// P1 反思回路端到端验证 v2：messages 协议 + RAG 智能体（有引用）+ 纯对话各一次
const BASE = 'http://127.0.0.1:3000'

async function chat(body) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`对话失败 ${res.status}: ${(await res.text()).slice(0, 150)}`)
  await res.text() // 消费完整流，确保 onAssistantDone 已触发
}

// ① RAG 检索路径（knowledge-base 智能体，应带 search_results 引用）
await chat({
  agentName: 'knowledge-base',
  messages: [{ role: 'user', content: '用一句话说明什么是向量数据库' }],
})
console.log('① RAG 对话完成')

// ② 纯对话路径（defaultChat，无引用属正常）
await chat({
  agentName: 'defaultChat',
  messages: [{ role: 'user', content: '用一句话说明什么是向量数据库' }],
})
console.log('② 纯对话完成')

// ③ 轮询反思记录
let items = null, stats = null
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const r = await (await fetch(`${BASE}/api/reflection/list?limit=10`)).json()
  if ((r.items?.length ?? 0) >= 2) { items = r.items; stats = r.stats; break }
}
if (!items) { console.log('❌ 反思记录不足 2 条'); process.exit(1) }
console.log('统计:', JSON.stringify(stats))
for (const it of items) {
  console.log(`[${it.id}] score=${it.score} action=${it.action} top1=${it.top1Score} 引用=${it.citations} 问题="${String(it.question).slice(0, 30)}"`)
  if (it.issues?.length) console.log(`   缺陷: ${it.issues.join('; ')}`)
}
process.exit(0)
