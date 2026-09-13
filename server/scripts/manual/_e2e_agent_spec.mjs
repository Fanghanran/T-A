/**
 * P1 Agent Spec E2E —— 临时数据全程清理。
 * 覆盖：seed / 前端数据源 / 自定义 chat+rag agent / 内置保护 / 停用语义 / RBAC / 别名冲突。
 */
const BASE = 'http://127.0.0.1:3000'
const DB = 'D:/workplace/trae/server/data/management/accounts.db'
const ADMIN = 'p1-e2e-admin'
const MEMBER = 'p1-e2e-member'
const PASS = 'Probe!234'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${name}${c ? '' : ' ' + extra}`) }
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

const register = (id) => fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: id, password: PASS }) })
const login = (id) => fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: id, password: PASS }) }).then((r) => r.json())

// 准备：临时号 + 提权
await register(ADMIN); await register(MEMBER)
{
  const Database = (await import('better-sqlite3')).default
  const db = new Database(DB)
  db.prepare("UPDATE users SET role='admin' WHERE user_id=?").run(ADMIN)
  db.close()
}
const adminToken = (await login(ADMIN)).token
const memberToken = (await login(MEMBER)).token
ok(Boolean(adminToken && memberToken), '临时账号就绪')

console.log('— 1. seed 与前端数据源 —')
let r = await fetch(BASE + '/api/agents', { headers: H(adminToken) })
let data = await r.json()
ok(r.status === 200 && Array.isArray(data.items), `GET /api/agents 200（实际 ${r.status}）`)
ok(data.items.length === 6, `seed 6 个内置 spec（实际 ${data.items.length}）`, JSON.stringify(data.items.map((x) => x.id)))
ok(data.items.filter((x) => !x.hidden).length === 4, '4 个可见 + 2 个隐藏路由 agent')
ok(data.items.every((x) => !('systemPrompt' in x)), '前端数据源不泄露 systemPrompt')

console.log('— 2. 管理端点 + RBAC —')
r = await fetch(BASE + '/api/management/agents', { headers: H(memberToken) })
ok(r.status === 403, `member 打管理端点 → 403（实际 ${r.status}）`)
r = await fetch(BASE + '/api/management/agents', { headers: H(adminToken) })
const mgmt = await r.json()
ok(r.status === 200 && mgmt.items?.length === 6, 'admin 管理清单 200')

console.log('— 3. 新建 chat 型自定义智能体 —')
r = await fetch(BASE + '/api/management/agents', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ id: 'p1-test-chat', name: 'P1测试机器人', description: 'E2E 临时', icon: 'bot', aliases: ['P1测试'], runtime: 'chat', systemPrompt: '你是一个只会用「哔哔」开头说话的测试机器人。' }) })
ok(r.status === 200, `新建 chat 型 agent（实际 ${r.status}: ${JSON.stringify(await r.json().catch(() => ({})))}）`)
// 数据源出现
data = await (await fetch(BASE + '/api/agents', { headers: H(adminToken) })).json()
ok(data.items.some((x) => x.id === 'p1-test-chat'), '新 agent 出现在 /api/agents')
// 路由生效：/api/chat 用新 agent 发消息（LLM 真实回复）
const chatRes = await fetch(BASE + '/api/chat', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], agentName: 'p1-test-chat' }) })
ok(chatRes.status === 200, `/api/chat 路由到新 agent → 200（实际 ${chatRes.status}）`)
await chatRes.text().catch(() => {})
// 重复 id 冲突
r = await fetch(BASE + '/api/management/agents', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ id: 'p1-test-chat', name: 'x', runtime: 'chat' }) })
ok(r.status === 400, `重复 id 被拒（实际 ${r.status}）`)
// 别名冲突（与内置中文别名）
r = await fetch(BASE + '/api/management/agents', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ id: 'p1-test-c2', name: 'x2', runtime: 'chat', aliases: ['模拟面试'] }) })
ok(r.status === 400, `别名与内置冲突被拒（实际 ${r.status}）`)

console.log('— 4. 新建 rag 型智能体 —')
r = await fetch(BASE + '/api/management/agents', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ id: 'p1-test-rag', name: 'P1检索测试', runtime: 'rag', systemPrompt: '回答时保持简洁。' }) })
ok(r.status === 200, `新建 rag 型 agent`)
const ragRes = await fetch(BASE + '/api/chat', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ messages: [{ role: 'user', content: '什么是TCP三次握手' }], agentName: 'p1-test-rag' }) })
ok(ragRes.status === 200, `rag agent 对话 200（实际 ${ragRes.status}）`)
const ragBody = await ragRes.text().catch(() => '')
ok(ragBody.includes('search_results'), 'rag 流内含 search_results 引用注解（检索链路生效）')

console.log('— 5. 内置保护与停用语义 —')
r = await fetch(BASE + '/api/management/agents/mock-interview', { method: 'DELETE', headers: H(adminToken) })
ok(r.status === 400, `删除内置被拒（实际 ${r.status}）`)
r = await fetch(BASE + '/api/management/agents/mock-interview', { method: 'PATCH', headers: H(adminToken), body: JSON.stringify({ runtime: 'chat' }) })
ok(r.status === 400, `内置改 runtime 被拒（实际 ${r.status}）`)
r = await fetch(BASE + '/api/management/agents/mock-interview', { method: 'PATCH', headers: H(adminToken), body: JSON.stringify({ enabled: 0 }) })
ok(r.status === 200, `内置可停用`)
data = await (await fetch(BASE + '/api/agents', { headers: H(adminToken) })).json()
ok(!data.items.some((x) => x.id === 'mock-interview'), '停用后 /api/agents 不含 mock-interview')
// 重新启用
r = await fetch(BASE + '/api/management/agents/mock-interview', { method: 'PATCH', headers: H(adminToken), body: JSON.stringify({ enabled: 1 }) })
ok(r.status === 200, '重新启用内置')

console.log('— 6. 清理 —')
for (const id of ['p1-test-chat', 'p1-test-rag']) {
  await fetch(BASE + '/api/management/agents/' + id, { method: 'DELETE', headers: H(adminToken) })
}
data = await (await fetch(BASE + '/api/agents', { headers: H(adminToken) })).json()
ok(!data.items.some((x) => x.id.startsWith('p1-test-')), '临时 spec 已清理（软删不出现在数据源）')
{
  const Database = (await import('better-sqlite3')).default
  const db = new Database(DB)
  db.prepare("DELETE FROM users WHERE user_id LIKE 'p1-e2e-%'").run()
  const d2 = new Database('D:/workplace/trae/server/data/management/agents.db')
  d2.prepare("DELETE FROM agents WHERE agent_id LIKE 'p1-test-%'").run()
  db.close(); d2.close()
  console.log('  临时账号与 spec 已物理清除')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
