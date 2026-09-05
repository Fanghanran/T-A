/**
 * docAgent E2E 第二阶段：入库路径 + 确认守卫 + 数据落库验证
 * 用法：node _e2e_doc_agent2.cjs [docId]
 * ① 无确认词的"帮我处理" → 期望 Agent 不入库（守卫生效）
 * ② "入库" → 期望 CommitToStore 执行，Milvus 块数增加
 * ③ 清理测试文档
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000'

async function chat(content, docId, sessionId) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: `u_${Date.now()}`, role: 'user', content }],
      agentName: 'doc-processor',
      ...(docId ? { docId } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  })
  const sid = r.headers.get('x-session-id')
  const raw = await r.text()
  const texts = []
  for (const line of raw.split('\n')) if (line.startsWith('0:')) texts.push(JSON.parse(line.slice(2)))
  return { sid, text: texts.join('') }
}

async function health() {
  const h = await (await fetch(`${BASE}/api/health`)).json()
  return { docs: h.documents, chunks: h.chunks }
}

async function main() {
  // 上传一份新文档
  const fd = new FormData()
  const content = '# 测试文档\n\n## 第一节\n\n' + '这是智能体入库守卫测试内容。'.repeat(30) + '\n\n## 第二节\n\n' + '第二节内容，用于切块。'.repeat(30)
  fd.append('file', new Blob([content]), 'guard-test.md')
  const up = await (await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })).json()
  console.log(`[0] 上传 OK docId=${up.docId}`)

  const before = await health()
  let sid = ''

  // ① 无确认词 → 期望守卫拒绝入库
  const r1 = await chat('帮我把这份文档处理一下', up.docId)
  sid = r1.sid
  console.log(`[1] 无确认词 ${'`处理一下`'} → 回复片段: ${r1.text.replace(/\n+/g, ' ').slice(0, 160)}`)
  const mid1 = await health()
  console.log(`    块数 ${before.chunks} → ${mid1.chunks}（${mid1.chunks === before.chunks ? '未入库 ✅' : '异常入库 ❌'}）`)
  if (mid1.chunks !== before.chunks) throw new Error('守卫失效：未确认就入库了')

  // ② 明确"入库" → 期望执行
  const r2 = await chat('入库', up.docId, sid)
  console.log(`[2] 确认入库 → 回复片段: ${r2.text.replace(/\n+/g, ' ').slice(0, 200)}`)
  const after = await health()
  console.log(`    块数 ${before.chunks} → ${after.chunks}（${after.chunks > before.chunks ? '已入库 ✅' : '未入库 ❌'}）`)

  // ③ 清理
  await fetch(`${BASE}/api/knowledge/documents/${up.docId}`, { method: 'DELETE' })
  if (sid) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })
  console.log('[3] 测试文档与会话已清理')

  const pass = mid1.chunks === before.chunks && after.chunks > before.chunks
  console.log(pass ? '\n=== E2E PASS ===' : '\n=== E2E FAIL ===')
  if (!pass) process.exitCode = 1
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exitCode = 1
})
