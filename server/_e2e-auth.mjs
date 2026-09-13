// 认证体系 E2E 验证（jwt 模式）
const BASE = 'http://127.0.0.1:3000'
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('OK  ', name, extra) }
  else { fail++; console.log('FAIL', name, extra) }
}
const req = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let data = null
  try { data = await res.json() } catch { /* ignore */ }
  return { status: res.status, data }
}

// 1. 未登录 /me
let r = await req('GET', '/api/auth/me')
ok(r.status === 200 && r.data.mode === 'jwt' && r.data.authenticated === false, '未登录 /me → mode=jwt 未认证')

// 2. 注册首个账号 → admin
r = await req('POST', '/api/auth/register', { body: { userId: 'e2e_admin', password: 'pass12345', label: 'E2E 管理员' } })
ok(r.status === 200 && r.data.role === 'admin', '注册首账号 → 自动 admin', JSON.stringify(r.data))

// 3. 重复注册 → 400
r = await req('POST', '/api/auth/register', { body: { userId: 'e2e_admin', password: 'pass12345' } })
ok(r.status === 400, '重复注册 → 400')

// 4. 短密码 → 400
r = await req('POST', '/api/auth/register', { body: { userId: 'e2e_x', password: '123' } })
ok(r.status === 400, '短密码 → 400')

// 5. 登录拿 JWT
r = await req('POST', '/api/auth/login', { body: { userId: 'e2e_admin', password: 'pass12345' } })
ok(r.status === 200 && r.data.token?.split('.').length === 3, '登录 → 签发 JWT')
const adminToken = r.data.token

// 6. 错密码 → 401 通用文案
r = await req('POST', '/api/auth/login', { body: { userId: 'e2e_admin', password: 'wrong-pass' } })
ok(r.status === 401 && r.data.message === '用户 ID 或密码错误', '错密码 → 401 防枚举文案')

// 7. /me with JWT → 已认证 + admin + 用量
r = await req('GET', '/api/auth/me', { token: adminToken })
ok(r.status === 200 && r.data.authenticated === true && r.data.user.userId === 'e2e_admin' && r.data.user.role === 'admin',
  '/me with JWT → 身份正确', `usage=${JSON.stringify(r.data.user?.usage)}`)

// 8. 数据路由：无 token → 401；带 JWT → 200 且数据隔离（e2e 用户看不到 local 的文档）
r = await req('GET', '/api/knowledge/documents')
ok(r.status === 401, '数据路由无凭据 → 401')
r = await req('GET', '/api/knowledge/documents', { token: adminToken })
ok(r.status === 200 && Array.isArray(r.data) ? (r.data.length === 0) : (r.data?.items?.length === 0 ?? true),
  '带 JWT → 200 且 owner 隔离（看不到 local 文档）', `docs=${JSON.stringify(r.data).slice(0, 60)}`)

// 9. 管理接口：admin JWT → 200
r = await req('GET', '/api/management/users', { token: adminToken })
ok(r.status === 200, '管理接口 admin JWT → 200')

// 10. 注册 member → 其 JWT 访问管理接口 → 401
r = await req('POST', '/api/auth/register', { body: { userId: 'e2e_member', password: 'pass12345' } })
ok(r.status === 200 && r.data.role === 'member', '注册第二账号 → member')
r = await req('POST', '/api/auth/login', { body: { userId: 'e2e_member', password: 'pass12345' } })
const memberToken = r.data.token
r = await req('GET', '/api/management/users', { token: memberToken })
ok(r.status === 401, 'member JWT 访问管理接口 → 401')

// 11. member 数据路由正常（自己的隔离空间）
r = await req('GET', '/api/knowledge/documents', { token: memberToken })
ok(r.status === 200, 'member JWT 数据路由 → 200')

// 12. OAuth 未配置 → 显式降级
r = await req('GET', '/api/auth/oauth/start')
ok(r.status === 404, 'OAuth 未配置 → 404 显式降级')

// 13. /me 不带 token 也 200（公开端点）
r = await req('GET', '/api/auth/me')
ok(r.status === 200, 'me 公开端点无需凭据')

// 14. 旧静态令牌兼容路径：user-token 模式未动，这里仅确认 jwt 模式拒绝垃圾 token
r = await req('GET', '/api/knowledge/documents', { token: 'garbage.token.value' })
ok(r.status === 401, '垃圾 token → 401')

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
