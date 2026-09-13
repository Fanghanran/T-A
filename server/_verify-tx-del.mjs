// 事务化删除端到端验证：上传 → 三层确认 → 删除 → 三层确认 + 回收站清空
import { existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import * as anchors from './lib/anchorStore.js'
import * as files from './lib/fileStore.js'
import { countVectors } from './lib/vectorIndexV3.js'

const BASE = 'http://127.0.0.1:3000'
const before = { chunks: anchors.stats().chunks, vecs: await countVectors('local') }
console.log(`删除前：锚点切片 ${before.chunks} | kb_vectors ${before.vecs}`)

// ① 上传测试文档（prepare + commit）
const text = '# 事务删除验证\n\n第一段内容。\n\n## 第二节\n\n第二段内容。\n'
const form = new FormData()
form.append('file', new Blob([text]), 'tx-del-test.md')
const prep = await (await fetch(`${BASE}/api/knowledge/documents/prepare`, { method: 'POST', body: form })).json()
const com = await (
  await fetch(`${BASE}/api/knowledge/documents/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewId: prep.previewId, category: '测试' }),
  })
).json()
if (!com.id) throw new Error('commit 失败: ' + JSON.stringify(com).slice(0, 150))
await new Promise((r) => setTimeout(r, 6000))

const docId = com.id
const dir = files.docDir('local', docId)
const mid = { doc: !!anchors.getDocument(docId, 'local'), chunks: anchors.countChunksOfDoc(docId, 'local'), dir: existsSync(dir), vecs: await countVectors('local') }
console.log(`上传后：锚点文档=${mid.doc} 切片=${mid.chunks} | 物理目录=${mid.dir} | kb_vectors=${mid.vecs}`)
if (!mid.doc || !mid.dir || mid.vecs <= before.vecs) throw new Error('上传后三层不一致，中止')

// ② 事务化删除
const del = await fetch(`${BASE}/api/knowledge/documents/${docId}`, { method: 'DELETE' })
console.log('删除响应:', del.status)

// ③ 三层确认
const after = { doc: !!anchors.getDocument(docId, 'local'), dir: existsSync(dir), vecs: await countVectors('local') }
const trash = existsSync(files.rootDir() + '/.trash') ? readdirSync(files.rootDir() + '/.trash') : []
console.log(`删除后：锚点文档=${after.doc}（应 false）| 物理目录=${after.dir}（应 false）| kb_vectors=${after.vecs}（应 ${before.vecs}）| 回收站残留=${trash.length}条`)
if (after.doc || after.dir || after.vecs !== before.vecs || trash.length > 0) {
  throw new Error('事务删除验证未通过')
}
console.log('✅ 三层统一口径删除 + 回收站清空：全部通过')
rmSync('D:/workplace/trae/server/_tx-del-test.log', { force: true })
writeFileSync('D:/workplace/trae/server/_tx-ok.txt', 'OK')
