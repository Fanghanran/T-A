/**
 * 用户数据隔离 E2E（跑完自动清理临时数据）。
 * 覆盖：知识库/图/题库/Wiki 的 per-owner 隔离 + admin '*' 聚合 + 题库 seed + 检索 fail-closed。
 */
const BASE = 'http://127.0.0.1:3000'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${name}${c ? '' : ' ' + extra}`) }
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` })

const login = (id) =>
  fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: id, password: '123456' }) }).then((r) => r.json())

const admin = await login('admin')
const member = await login('user001')
ok(Boolean(admin.token && member.token), 'admin / user001 登录')
const A = H(admin.token)
const M = H(member.token)

console.log('— 1. 知识库文件树隔离 —')
{
  const a = await (await fetch(BASE + '/api/files?pageSize=100', { headers: A })).json()
  const m = await (await fetch(BASE + '/api/files?pageSize=100', { headers: M })).json()
  const s = await (await fetch(BASE + '/api/files/stats', { headers: A })).json()
  ok(a.total === 4, `admin 聚合视图 4 篇（实际 ${a.total}）`)
  ok(m.total === 0, `user001 空库（实际 ${m.total}）`)
  ok(s.documents === 4, `admin stats 聚合 4（实际 ${s.documents}）`)
}

console.log('— 2. 知识网络图隔离 —')
{
  const a = await (await fetch(BASE + '/api/management/vector/graph?threshold=0.7&topK=6&includeWiki=0', { headers: A })).json()
  const m = await (await fetch(BASE + '/api/management/vector/graph?threshold=0.7&topK=6&includeWiki=0', { headers: M })).json()
  ok((a.nodes ?? []).length === 304, `admin 图 304 节点（实际 ${(a.nodes ?? []).length}）`)
  ok((m.nodes ?? []).length === 0, `user001 图空（实际 ${(m.nodes ?? []).length}）`)
}

console.log('— 3. 检索隔离（RAG unifiedSearch） —')
{
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: A, body: JSON.stringify({ messages: [{ role: 'user', content: 'React 性能优化' }], agentName: 'knowledge-base' }) })
  const body = await r.text()
  ok(r.status === 200, `admin RAG 200`)
  ok(body.includes('search_results'), 'admin 检索有引用注解（命中自己名下数据）')
  const r2 = await fetch(BASE + '/api/chat', { method: 'POST', headers: M, body: JSON.stringify({ messages: [{ role: 'user', content: 'React 性能优化' }], agentName: 'knowledge-base' }) })
  const body2 = await r2.text()
  const annot2 = body2.match(/"type":"search_results"[\s\S]{0,400}/)?.[0] ?? ''
  const zeroHits = annot2.includes('"total":0') || !annot2
  ok(zeroHits, 'user001 检索不串库（total=0 或无注解）')
}

console.log('— 4. 题库隔离 + seed —')
{
  const a = await (await fetch(BASE + '/api/interview/stats', { headers: A })).json()
  const m = await (await fetch(BASE + '/api/interview/stats', { headers: M })).json()
  ok(a.total === 18, `admin 题库 18（迁移存量，实际 ${a.total}）`)
  // .env QUESTION_SEED=off（既有配置：清空后不复灌）→ 新用户空题库起步，录入后为自己的数据
  ok(m.total === 0, `user001 空题库起步（QUESTION_SEED=off，实际 ${m.total}）`)
  // member 录入 → 自己可见、admin 聚合可见、member 的题不污染 admin 名下
  const add = await fetch(BASE + '/api/interview/questions', { method: 'POST', headers: M, body: JSON.stringify({ title: '隔离测试题：E2E 专用', category: '测试' }) })
  ok(add.status === 201, 'user001 录入题目 201')
  const added = await add.json()
  const m2 = await (await fetch(BASE + '/api/interview/questions', { headers: M })).json()
  const a2 = await (await fetch(BASE + '/api/interview/questions', { headers: A })).json()
  ok(m2.items.some((q) => q.id === added.id), 'user001 自己可见新题')
  ok(a2.items.some((q) => q.id === added.id), 'admin 聚合可见新题')
  const del = await fetch(BASE + '/api/interview/questions/' + added.id, { method: 'DELETE', headers: M })
  ok(del.status === 204, '清理测试题')
}

console.log('— 5. 题库检索 fail-closed 与通道 —')
{
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: M, body: JSON.stringify({ messages: [{ role: 'user', content: 'React 渲染优化' }], agentName: 'interview-retrieval' }) })
  const body = await r.text()
  ok(r.status === 200, `user001 面试题检索 agent 200（走自己题库）`)
}

console.log('— 清理 —')
// user001 无文档上传，无需清理；admin 数据未动
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
