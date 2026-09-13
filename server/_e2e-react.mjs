// P2 ReAct 规划器端到端验证（临时脚本）
// 场景：复合目标（检索 → 整理 → 写记忆）→ 应触发 react-planner 而非普通 RAG
const BASE = 'http://127.0.0.1:3000'

// ① 建会话
const createRes = await fetch(`${BASE}/api/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentName: 'knowledge-base' }),
})
let sid = ''
if (createRes.ok) {
  const j = await createRes.json()
  sid = j.id || j.session?.id || ''
}
if (!sid) {
  // 会话端点路径不同时兜底：不带 sessionId 直接聊天（chat.js 会自动建会话）
  console.log('（会话接口未命中，走 chat 自动建会话）')
}

// ② 发复合目标
const goal = '查一下知识库里向量数据库的选型结论，然后把最重要的两条结论写入记忆'
console.log('目标:', goal)
console.log('--- SSE 流 ---')

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentName: 'knowledge-base',
    ...(sid ? { sessionId: sid } : {}),
    messages: [{ role: 'user', content: goal }],
  }),
})
console.log('HTTP', res.status, '| x-session-id:', res.headers.get('x-session-id'))
if (!res.ok) {
  console.log('失败:', await res.text())
  process.exit(1)
}
const newSid = res.headers.get('x-session-id') || sid

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
let stepCount = 0
let textLen = 0
let sawFinish = false
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (line.startsWith('0:')) {
      textLen += JSON.parse(line.slice(2)).length
    } else if (line.startsWith('2:')) {
      const arr = JSON.parse(line.slice(2))
      for (const a of arr) {
        if (a.type === 'agent_workflow') {
          stepCount++
          console.log(`[step ${a.seq}] ${a.tool} (${a.ms}ms) engine=${a.engine}`)
          console.log(`  thought: ${(a.thought || '').slice(0, 80)}`)
          console.log(`  args: ${JSON.stringify(a.args).slice(0, 120)}`)
          console.log(`  observation: ${(a.observation || '').slice(0, 120)}`)
          if (a.tool === 'FINISH') sawFinish = true
        }
      }
    }
  }
}
console.log('--- 结果 ---')
console.log(`agent_workflow 步骤数: ${stepCount} | FINISH: ${sawFinish} | 文本总量: ${textLen} 字`)

// ③ 查审计
const audit = await fetch(`${BASE}/api/react/steps?limit=30`)
const aj = await audit.json()
console.log('--- 审计（react.*）---')
for (const e of aj.items ?? []) {
  console.log(`${e.action} | ${e.tool ?? ''} seq=${e.seq ?? ''} ok=${e.ok ?? ''} ${e.steps != null ? `steps=${e.steps} totalMs=${e.totalMs}` : ''}`)
}

// ④ 验证记忆确实写入（等 flush）
await new Promise((r) => setTimeout(r, 1000))
const { createHash } = await import('node:crypto')
console.log('（记忆写入以流内 step 的 memory.write observation 为准）')
process.exit(0)
