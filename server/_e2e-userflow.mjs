/**
 * 用户模块 E2E（SQLite 用户表 + 登录校验链路）
 * 前置：后端以 AUTH_MODE=jwt 启动于 127.0.0.1:3000
 */
import { execFileSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3000'
const USER = 'e2euser2'
const PASS = 'Passw0rd!23'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const j = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts)
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body, headers: res.headers }
}

const login = (userId, password) =>
  j('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  })

/** 直接查 SQLite 用户表（不经 API 验证落库） */
const sqlUser = () => {
  const out = execFileSync(
    'C:/Program Files/nodejs/node.exe',
    ['-e', `
      const Database = require('D:/workplace/trae/server/node_modules/better-sqlite3');
      const db = new Database('D:/workplace/trae/server/data/management/accounts.db', { readonly: true });
      const r = db.prepare('SELECT user_id, role, auth_type, last_login_ip, failed_count, locked_until FROM users WHERE user_id = ?').get('${USER}');
      console.log(JSON.stringify(r ?? null));
      db.close();
    `],
    { encoding: 'utf8' },
  )
  return JSON.parse(out.trim())
}

console.log('── 1. 注册 + 用户表落库 ──')
{
  const { status, body } = await j('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER, password: PASS, label: 'E2E' }),
  })
  check('注册 200', status === 200, JSON.stringify(body))
  const row = sqlUser()
  check('SQLite users 表有行', row && row.user_id === USER, JSON.stringify(row))
  check('auth_type=password', row?.auth_type === 'password')
  check('failed_count 初始 0', row?.failed_count === 0)
}

console.log('── 2. 登录 + last_login_ip 落库 ──')
{
  const { status, body } = await login(USER, PASS)
  check('登录 200', status === 200, JSON.stringify(body))
  const row = sqlUser()
  check('last_login_ip 已记录', typeof row?.last_login_ip === 'string' && row.last_login_ip.length > 0, JSON.stringify(row))
  const { status: s2, body: b2 } = await j('/api/auth/me', {
    headers: { Authorization: `Bearer ${body?.token}` },
  })
  check('me authenticated', s2 === 200 && b2?.authenticated === true)
}

console.log('── 3. 失败锁定 ──')
{
  let locked = null
  for (let i = 0; i < 6; i++) {
    const r = await login(USER, 'wrong-password')
    if (r.status === 423) {
      locked = r
      break
    }
    check(`第 ${i + 1} 次错密码 → 401`, r.status === 401, `status=${r.status}`)
  }
  check('连续失败触发 423 锁定', locked?.status === 423, JSON.stringify(locked?.body))
  check('Retry-After 头存在', Boolean(locked?.headers?.get('retry-after')))
  const row = sqlUser()
  check('locked_until 已落库', Boolean(row?.locked_until), JSON.stringify(row))
  const okPw = await login(USER, PASS)
  check('锁定期间正确密码也 423', okPw.status === 423, `status=${okPw.status}`)
}

console.log(`\n结果：${passed} 过 / ${failed} 挂`)
process.exit(failed ? 1 : 0)
