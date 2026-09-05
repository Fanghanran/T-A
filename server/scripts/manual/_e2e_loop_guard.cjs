/**
 * 重复调用守卫验证：复现"反复 AnalyzeDocument 刷屏"故障场景
 * ① 上传无标题纯文本文档（约 900 字 / 3 段落，与故障报告同特征）
 * ② 发送"请分析这份文档" → 断言"收到文档"只出现 1 次，且回复含下一步引导
 * ③ 清理
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

async function main() {
  const fd = new FormData()
  const para = '这是一段没有任何标题结构的纯文本内容，用于验证文档处理智能体在缺乏结构特征时不会陷入重复调用的死循环。'.repeat(6)
  const content = [para, para, para].join('\n\n')
  fd.append('file', new Blob([content]), 'loop-guard-test.txt')
  const up = await (await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })).json()
  console.log(`[0] 上传 OK docId=${up.docId}（${content.length} 字 / 3 段落 / 0 标题）`)

  const r = await chat('请分析这份文档', up.docId)
  const analyzeCount = (r.text.match(/收到文档：/g) || []).length
  console.log(`[1] "请分析这份文档" → "收到文档"出现 ${analyzeCount} 次（期望 1）`)
  console.log(`    回复片段: ${r.text.replace(/\n+/g, ' ').slice(0, 200)}`)

  if (analyzeCount > 1) throw new Error(`守卫失效：分析结果重复输出了 ${analyzeCount} 次`)
  const guided = /预览|入库|导出/.test(r.text)
  console.log(`[2] 回复含下一步引导: ${guided ? '✅' : '❌'}`)
  if (!guided) throw new Error('回复缺少下一步引导')

  await fetch(`${BASE}/api/knowledge/documents/${up.docId}`, { method: 'DELETE' })
  if (r.sid) await fetch(`${BASE}/api/sessions/${r.sid}`, { method: 'DELETE' })
  console.log('[3] 测试数据已清理')
  console.log('\n=== LOOP GUARD PASS ===')
}

main().catch((e) => {
  console.error('E2E FAIL:', e.message)
  process.exit(1)
})
