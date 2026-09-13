// faq.md 重新入库：prepare → commit → 验证计数（2026-09-11 数据丢失后的恢复脚本）
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3000'
const buf = readFileSync('D:/workplace/trae/faq.md')
const size = buf.byteLength
console.log('读取 faq.md:', size, '字节')

// ① prepare：解析 + 切片预览（与用户昨晚上传时一致：双换行分段）
const form = new FormData()
form.append('file', new Blob([buf]), 'faq.md')
form.append('chunkStrategy', 'delimiter')
form.append('delimiter', '\n\n')
const prep = await (await fetch(`${BASE}/api/knowledge/documents/prepare`, { method: 'POST', body: form })).json()
if (!prep.previewId) throw new Error('prepare 失败: ' + JSON.stringify(prep).slice(0, 200))
console.log('prepare OK: previewId=', prep.previewId, '| 切片', prep.chunkCount, '| 均分', prep.avgScore)

// ② commit：入库（embedding + 向量写入 + flush）
const com = await (
  await fetch(`${BASE}/api/knowledge/documents/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewId: prep.previewId, category: '' }),
  })
).json()
if (com.duplicate) throw new Error('内容重复: ' + com.message)
if (!com.id) throw new Error('commit 失败: ' + JSON.stringify(com).slice(0, 200))
console.log('commit OK: docId=', com.id, '| status=', com.status)

// ③ 等索引完成后验证
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const st = await (await fetch(`${BASE}/api/knowledge/documents/${com.id}/status`)).json()
  if (st.status === 'indexed') {
    const stats = await (await fetch(`${BASE}/api/files/stats`)).json()
    console.log('索引完成 | 锚点层:', stats.documents, '篇 /', stats.chunks, '切片')
    const rows = await (await fetch(`${BASE}/api/management/vector/collections/kb_vectors/rows?limit=1`)).json()
    console.log('kb_vectors:', rows.total, '条')
    if (rows.total < stats.chunks) throw new Error(`向量数 ${rows.total} < 切片数 ${stats.chunks}，仍有丢失`)
    console.log('✅ 恢复完成，向量与切片一致')
    process.exit(0)
  }
  console.log(`等待索引... status=${st.status}`)
}
throw new Error('索引超时')
