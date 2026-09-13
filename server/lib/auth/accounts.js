import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { childLogger } from '../logger.js'
import { makeSqliteBrowser, maskSensitiveRow } from '../sqliteBrowse.js'
import { sanitizePerms, DEFAULT_MEMBER_PERMS } from './perms.js'

/**
 * accounts —— 密码账号存储（用户模块 v2，SQLite 用户表）
 *
 * 持久化：server/data/management/accounts.db（better-sqlite3，与其他库同栈）
 *
 *   users 表：
 *     user_id TEXT PK | label | role('admin'|'member') | status('active'|'disabled')
 *     auth_type('password'|'oauth'|'token') | salt | password_hash
 *     oauth_provider | oauth_provider_id（组合索引，OAuth find-or-create 用）
 *     created_at | last_login_at | last_login_ip
 *     failed_count | locked_until（登录失败锁定，防暴力破解）
 *
 * 密码哈希用 Node 内置 scrypt（N=16384,r=8,p=1，随机 16B 盐）—— 不引入 bcrypt 等
 * 需原生编译的依赖（Windows 无 VS C++ Build Tools 环境硬约束）。
 *
 * 迁移：启动时若存在旧 accounts.json 则整表导入后重命名为 accounts.json.imported（备份保留）。
 * 引导规则：空表注册的第一个账号自动 role=admin（否则没人能进管理端）。
 * 注册开关：env AUTH_REGISTRATION（默认 on；off 时 register 显式 403，已有账号登录不受影响）。
 * 锁定：连续失败 ≥AUTH_LOCKOUT_MAX（默认 5）次锁 AUTH_LOCKOUT_MINUTES（默认 15）分钟。
 */

const log = childLogger('accounts')

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management')
const DB_FILE = join(DATA_DIR, 'accounts.db')
const LEGACY_JSON = join(DATA_DIR, 'accounts.json')

export const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
export const MIN_PASSWORD_LEN = 6
export const MAX_PASSWORD_LEN = 16

/** 密码规则校验（注册 / 管理员代建 / 重置密码共用）：6~16 位 */
export function assertPasswordValid(password) {
  const len = String(password ?? '').length
  if (len < MIN_PASSWORD_LEN || len > MAX_PASSWORD_LEN) {
    throw new Error(`密码长度需为 ${MIN_PASSWORD_LEN}~${MAX_PASSWORD_LEN} 位`)
  }
}

const LOCKOUT_MAX = Math.max(1, Number(process.env.AUTH_LOCKOUT_MAX ?? 5) || 5)
const LOCKOUT_MINUTES = Math.max(1, Number(process.env.AUTH_LOCKOUT_MINUTES ?? 15) || 15)

mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 3000')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id          TEXT PRIMARY KEY,
    label            TEXT NOT NULL DEFAULT '',
    role             TEXT NOT NULL DEFAULT 'member',
    status           TEXT NOT NULL DEFAULT 'active',
    auth_type        TEXT NOT NULL DEFAULT 'password',
    salt             TEXT,
    password_hash    TEXT,
    oauth_provider   TEXT,
    oauth_provider_id TEXT,
    created_at       TEXT NOT NULL,
    last_login_at    TEXT,
    last_login_ip    TEXT,
    failed_count     INTEGER NOT NULL DEFAULT 0,
    locked_until     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_oauth
    ON users(oauth_provider, oauth_provider_id);
  CREATE TABLE IF NOT EXISTS roles (
    role_id     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    built_in    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_perms (
    role_id TEXT NOT NULL,
    perm    TEXT NOT NULL,
    PRIMARY KEY (role_id, perm)
  );
`)

/* ---------- 内置角色种子（幂等） ---------- */
;(() => {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT OR IGNORE INTO roles (role_id, name, description, built_in, created_at) VALUES ('admin', '管理员', '全部权限（内置，不可修改）', 1, ?)",
  ).run(now)
  db.prepare(
    "INSERT OR IGNORE INTO roles (role_id, name, description, built_in, created_at) VALUES ('member', '成员', '默认基础权限（内置，可调整权限集）', 1, ?)",
  ).run(now)
  // member 默认权限集仅首次播种（之后以角色管理页的配置为准）
  const has = db.prepare('SELECT 1 FROM role_perms WHERE role_id = ?').get('member')
  if (!has) {
    const ins = db.prepare('INSERT INTO role_perms (role_id, perm) VALUES (?, ?)')
    const tx = db.transaction((list) => {
      for (const p of list) ins.run('member', p)
    })
    tx(DEFAULT_MEMBER_PERMS)
  }
})()

/* ---------- 旧 JSON 自动迁移 ---------- */

/* ---------- 行 ↔ 账号对象映射 ---------- */

const COLS = `user_id, label, role, status, auth_type, salt, password_hash,
  oauth_provider, oauth_provider_id, created_at, last_login_at, last_login_ip,
  failed_count, locked_until`

function rowToAccount(r) {
  if (!r) return null
  return {
    userId: r.user_id,
    label: r.label,
    role: r.role,
    status: r.status,
    auth:
      r.auth_type === 'password'
        ? { type: 'password', salt: r.salt, hash: r.password_hash }
        : r.auth_type === 'oauth'
          ? { type: 'oauth', provider: r.oauth_provider, providerId: r.oauth_provider_id }
          : { type: r.auth_type },
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    lastLoginIp: r.last_login_ip,
    failedCount: r.failed_count,
    lockedUntil: r.locked_until,
  }
}

function insertAccount(u) {
  db.prepare(
    `INSERT INTO users (user_id, label, role, status, auth_type, salt, password_hash,
       oauth_provider, oauth_provider_id, created_at, last_login_at, last_login_ip,
       failed_count, locked_until)
     VALUES (@user_id, @label, @role, @status, @auth_type, @salt, @password_hash,
       @oauth_provider, @oauth_provider_id, @created_at, @last_login_at, @last_login_ip,
       0, NULL)`,
  ).run({
    user_id: u.userId,
    label: u.label ?? '',
    role: u.role ?? 'member',
    status: u.status ?? 'active',
    auth_type: u.auth?.type ?? 'password',
    salt: u.auth?.salt ?? null,
    password_hash: u.auth?.hash ?? null,
    oauth_provider: u.auth?.provider ?? null,
    oauth_provider_id: u.auth?.providerId ?? null,
    created_at: u.createdAt ?? new Date().toISOString(),
    last_login_at: u.lastLoginAt ?? null,
    last_login_ip: u.lastLoginIp ?? null,
  })
}

/* ---------- 注册开关 ---------- */

/** 注册是否开放（env AUTH_REGISTRATION，默认 on） */
export function registrationEnabled() {
  return !/^(0|false|off)$/i.test(String(process.env.AUTH_REGISTRATION ?? 'on').trim())
}

/* ---------- 查询 ---------- */

/** 账号列表（不含敏感字段） */
export function listAccounts() {
  return db
    .prepare(`SELECT ${COLS} FROM users ORDER BY created_at ASC`)
    .all()
    .map((r) => {
      const a = rowToAccount(r)
      return {
        userId: a.userId,
        label: a.label,
        role: a.role,
        status: a.status,
        authType: a.auth.type,
        createdAt: a.createdAt,
        lastLoginAt: a.lastLoginAt,
        lastLoginIp: a.lastLoginIp,
      }
    })
}

export function findAccount(userId) {
  const r = db.prepare(`SELECT ${COLS} FROM users WHERE user_id = ?`).get(String(userId ?? ''))
  return rowToAccount(r)
}

/** 用户表总数（含禁用）—— 引导判定用 */
function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n
}

/* ---------- 密码 ---------- */

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(String(password), salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPassword(password, auth) {
  if (auth?.type !== 'password' || !auth.salt || !auth.hash) return false
  const derived = scryptSync(String(password), auth.salt, 64)
  const stored = Buffer.from(auth.hash, 'hex')
  return derived.length === stored.length && timingSafeEqual(derived, stored)
}

/* ---------- 注册 ---------- */

/**
 * 注册账号（密码登录）。空表第一个账号自动 role=admin。
 * @param {{ userId:string, password:string, label?:string }} p
 * @returns {{ userId:string, role:string }}（不含任何令牌）
 */
export function registerAccount({ userId, password, label }) {
  if (!USER_ID_RE.test(String(userId ?? ''))) {
    throw new Error('用户 ID 无效：仅允许字母数字下划线连字符，1~32 位，且以字母或数字开头')
  }
  assertPasswordValid(password)
  if (!registrationEnabled()) {
    const err = new Error('注册已关闭（AUTH_REGISTRATION=off），请联系管理员开通账号')
    err.status = 403
    throw err
  }
  if (findAccount(userId)) {
    throw new Error(`用户 ${userId} 已存在`)
  }
  const account = {
    userId,
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : '',
    // 引导：空表第一个注册者自动成为管理员（否则无人能进管理端）
    role: countUsers() === 0 ? 'admin' : 'member',
    status: 'active',
    auth: { type: 'password', ...hashPassword(password) },
    createdAt: new Date().toISOString(),
  }
  insertAccount(account)
  log.info(`[accounts] 新注册账号：${userId}（role=${account.role}）`)
  return { userId, role: account.role }
}

/* ---------- 锁定 ---------- */

function lockedNow(u) {
  if (!u?.lockedUntil) return null
  const until = Date.parse(u.lockedUntil)
  if (!Number.isFinite(until)) return null
  const remainMs = until - Date.now()
  if (remainMs <= 0) return null
  return Math.ceil(remainMs / 1000)
}

function clearLock(userId) {
  db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE user_id = ?').run(userId)
}

function registerFailure(userId) {
  const u = findAccount(userId)
  if (!u) return
  const next = (u.failedCount ?? 0) + 1
  if (next >= LOCKOUT_MAX) {
    const until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
    db.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE user_id = ?').run(next, until, userId)
    log.warn(`[accounts] 账号 ${userId} 连续失败 ${next} 次，锁定至 ${until}`)
  } else {
    db.prepare('UPDATE users SET failed_count = ? WHERE user_id = ?').run(next, userId)
  }
}

/* ---------- 登录校验 ---------- */

/**
 * 密码登录校验（含失败锁定）。失败统一抛同一文案（防用户枚举），调用方转 401；
 * 账号锁定抛 423 + retryAfter。
 * @param {{ userId:string, password:string, ip?:string }} p
 * @returns {{ userId:string, role:string }}
 */
export function authenticate({ userId, password, ip }) {
  const id = String(userId ?? '')
  const u = findAccount(id)
  // 即使账号不存在也做一次 scrypt，抹平响应时间差（防时序枚举）
  if (!u) {
    scryptSync(String(password ?? ''), 'timing-equalizer', 64)
    const err = new Error('用户 ID 或密码错误')
    err.status = 401
    throw err
  }
  const remainSec = lockedNow(u)
  if (remainSec) {
    const err = new Error(`失败次数过多，账号已锁定，请 ${remainSec} 秒后重试`)
    err.status = 423
    err.retryAfter = remainSec
    throw err
  }
  const ok = u.status === 'active' && verifyPassword(password, u.auth)
  if (!ok) {
    registerFailure(id)
    const err = new Error('用户 ID 或密码错误')
    err.status = u.status === 'active' ? 401 : 403
    if (u.status !== 'active') err.message = '该账号已被禁用'
    throw err
  }
  clearLock(id)
  db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE user_id = ?').run(
    new Date().toISOString(),
    String(ip ?? ''),
    id,
  )
  return { userId: u.userId, role: u.role }
}

/* ---------- OAuth ---------- */

/**
 * OAuth 身份登录（find-or-create）：按 (provider, providerId) 幂等建号，无密码。
 * @param {{ provider:string, providerId:string, label?:string, ip?:string }} p
 * @returns {{ userId:string, role:string, created:boolean }}
 */
export function oauthFindOrCreate({ provider, providerId, label, ip }) {
  if (!/^[a-z][a-z0-9_]{1,15}$/i.test(String(provider ?? ''))) throw new Error('非法 provider')
  if (!/^[\w.@:-]{1,128}$/.test(String(providerId ?? ''))) throw new Error('非法 providerId')
  const existing = db
    .prepare('SELECT user_id FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?')
    .get(provider, providerId)
  let created = false
  let userId
  if (existing) {
    userId = existing.user_id
  } else {
    if (!registrationEnabled()) {
      const err = new Error('注册已关闭（AUTH_REGISTRATION=off），该 OAuth 身份未绑定账号')
      err.status = 403
      throw err
    }
    // userId 由 provider 身份派生（如 gh_12345），冲突时追加序号
    userId = `${String(provider).slice(0, 6).toLowerCase()}_${String(providerId).replace(/[^\w-]/g, '').slice(0, 20)}`
    if (!USER_ID_RE.test(userId)) userId = `${provider.toLowerCase().slice(0, 6)}_user`
    let n = 1
    while (findAccount(userId)) userId = `${userId}_${n++}`.slice(0, 32)
    const account = {
      userId,
      label: (label || '').toString().slice(0, 100) || `${provider} 用户`,
      role: countUsers() === 0 ? 'admin' : 'member',
      status: 'active',
      auth: { type: 'oauth', provider, providerId },
      createdAt: new Date().toISOString(),
    }
    insertAccount(account)
    created = true
    log.info(`[accounts] OAuth 新建账号：${userId}（${provider}）`)
  }
  const u = findAccount(userId)
  if (u.status !== 'active') {
    const err = new Error('该账号已被禁用')
    err.status = 403
    throw err
  }
  db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE user_id = ?').run(
    new Date().toISOString(),
    String(ip ?? ''),
    userId,
  )
  return { userId, role: u.role, created }
}

/* ---------- 管理端操作 ---------- */

/**
 * 管理端操作：禁用/启用账号；禁用时同步清锁定状态。
 * @returns {boolean} 是否发生变更
 */
export function setAccountStatus(userId, status) {
  const u = findAccount(userId)
  if (!u || u.status === status) return false
  db.prepare('UPDATE users SET status = ?, failed_count = 0, locked_until = NULL WHERE user_id = ?').run(status, userId)
  log.info(`[accounts] 账号 ${userId} 状态 → ${status}`)
  return true
}

/** 管理端操作：手动解锁（清失败计数与锁定） */
export function unlockAccount(userId) {
  const u = findAccount(userId)
  if (!u) return false
  clearLock(userId)
  log.info(`[accounts] 账号 ${userId} 已手动解锁`)
  return true
}

/* ---------- 权限管理（管理端操作） ---------- */

/** 当前 active 管理员数量 —— 「最后一个 admin」保护用 */
export function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n
}

/**
 * 设置账号角色（'admin' | 'member'）。
 * 调用方（manager 端点）负责「不能改自己 / 不能动最后一个 admin」的前置校验。
 * @returns {boolean} 是否发生变更
 */
export function setAccountRole(userId, role) {
  if (!['admin', 'member'].includes(role) && !findRole(role)) {
    throw new Error(`角色不存在：${role}`)
  }
  const u = findAccount(userId)
  if (!u) throw new Error(`用户 ${userId} 不存在`)
  if (u.role === role) return false
  db.prepare('UPDATE users SET role = ? WHERE user_id = ?').run(role, userId)
  log.info(`[accounts] 账号 ${userId} 角色 → ${role}`)
  return true
}

/**
 * 管理员重置账号密码（不验旧密码，凭 admin 权限执行）。
 * 重置同时清失败锁定，让被锁账号可直接用新密码登录。
 * @returns {boolean} 是否发生变更
 */
export function resetAccountPassword(userId, password) {
  const u = findAccount(userId)
  if (!u) throw new Error(`用户 ${userId} 不存在`)
  assertPasswordValid(password)
  const { salt, hash } = hashPassword(password)
  db.prepare('UPDATE users SET salt = ?, password_hash = ?, failed_count = 0, locked_until = NULL WHERE user_id = ?').run(
    salt,
    hash,
    userId,
  )
  log.info(`[accounts] 账号 ${userId} 密码已由管理员重置`)
  return true
}

/* ---------- 角色与权限（RBAC，角色管理页数据源） ---------- */

/**
 * 指定角色的权限集。admin 恒为 ['*']；其余查 role_perms。
 * @param {string} roleId
 * @returns {string[]}
 */
export function permsOf(roleId) {
  if (roleId === 'admin') return ['*']
  return db.prepare('SELECT perm FROM role_perms WHERE role_id = ?').all(String(roleId ?? '')).map((r) => r.perm)
}

/** 角色是否存在 */
export function findRole(roleId) {
  return db
    .prepare('SELECT role_id, name, description, built_in, created_at FROM roles WHERE role_id = ?')
    .get(String(roleId ?? '')) ?? null
}

/** 角色清单（含权限集与引用计数；字段 camelCase 与 users 端点约定一致） */
export function listRoles() {
  const roles = db.prepare('SELECT role_id, name, description, built_in, created_at FROM roles ORDER BY built_in DESC, created_at ASC').all()
  const refCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = ?')
  return roles.map((r) => ({
    roleId: r.role_id,
    name: r.name,
    description: r.description,
    builtIn: !!r.built_in,
    createdAt: r.created_at,
    perms: permsOf(r.role_id),
    userCount: refCount.get(r.role_id, 'active').n,
  }))
}

/** 新建自定义角色（perms 传非法键会抛错） */
export function createRole({ roleId, name, description, perms }) {
  if (!USER_ID_RE.test(String(roleId ?? ''))) {
    throw new Error('角色 ID 无效：仅允许字母数字下划线连字符，1~32 位，且以字母或数字开头')
  }
  if (findRole(roleId)) throw new Error(`角色 ${roleId} 已存在`)
  if (!String(name ?? '').trim()) throw new Error('角色名称不能为空')
  const list = sanitizePerms(perms)
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO roles (role_id, name, description, built_in, created_at) VALUES (?, ?, ?, 0, ?)').run(
      roleId,
      String(name).trim().slice(0, 50),
      String(description ?? '').trim().slice(0, 200),
      new Date().toISOString(),
    )
    const ins = db.prepare('INSERT INTO role_perms (role_id, perm) VALUES (?, ?)')
    for (const p of list) ins.run(roleId, p)
  })
  tx()
  log.info(`[accounts] 新建角色：${roleId}（权限 ${list.length} 项）`)
  return { roleId, perms: list }
}

/** 更新角色（名称/描述/权限集；内置角色仅 member 允许改权限集，admin 完全锁定） */
export function updateRole(roleId, { name, description, perms } = {}) {
  const r = findRole(roleId)
  if (!r) throw new Error(`角色 ${roleId} 不存在`)
  if (roleId === 'admin') throw new Error('admin 为内置角色，权限不可修改')
  const tx = db.transaction(() => {
    if (name != null && String(name).trim()) {
      if (r.built_in) throw new Error('内置角色不可改名')
      db.prepare('UPDATE roles SET name = ? WHERE role_id = ?').run(String(name).trim().slice(0, 50), roleId)
    }
    if (description != null && !r.built_in) {
      db.prepare('UPDATE roles SET description = ? WHERE role_id = ?').run(String(description).trim().slice(0, 200), roleId)
    }
    if (perms != null) {
      const list = sanitizePerms(perms)
      db.prepare('DELETE FROM role_perms WHERE role_id = ?').run(roleId)
      const ins = db.prepare('INSERT INTO role_perms (role_id, perm) VALUES (?, ?)')
      for (const p of list) ins.run(roleId, p)
    }
  })
  tx()
  log.info(`[accounts] 角色 ${roleId} 已更新`)
  return { roleId, perms: permsOf(roleId) }
}

/** 删除角色（内置不可删；仍有 active 用户引用不可删） */
export function deleteRole(roleId) {
  const r = findRole(roleId)
  if (!r) throw new Error(`角色 ${roleId} 不存在`)
  if (r.built_in) throw new Error(`内置角色 ${roleId} 不可删除`)
  const refs = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = 'active'").get(roleId).n
  if (refs > 0) throw new Error(`角色 ${roleId} 仍被 ${refs} 个启用中的账号引用，请先转移成员角色`)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_perms WHERE role_id = ?').run(roleId)
    db.prepare('DELETE FROM roles WHERE role_id = ?').run(roleId)
  })
  tx()
  log.info(`[accounts] 角色 ${roleId} 已删除`)
  return true
}

/* ---------- 成员管理（管理员代建 / 删除账号） ---------- */

/** 角色是否为启用中账号引用的判定（删除保护用） */
function activeRefsOfRole(roleId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = 'active'").get(roleId).n
}

/**
 * 管理员创建成员账号（指定角色，不走「空表首注册 admin」引导）。
 * @returns {{ userId:string, role:string }}
 */
export function createAccountByAdmin({ userId, password, label, role = 'member' }) {
  if (!USER_ID_RE.test(String(userId ?? ''))) {
    throw new Error('用户 ID 无效：仅允许字母数字下划线连字符，1~32 位，且以字母或数字开头')
  }
  assertPasswordValid(password)
  if (findAccount(userId)) throw new Error(`用户 ${userId} 已存在`)
  if (!findRole(role)) throw new Error(`角色不存在：${role}`)
  insertAccount({
    userId,
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : '',
    role,
    status: 'active',
    auth: { type: 'password', ...hashPassword(password) },
    createdAt: new Date().toISOString(),
  })
  log.info(`[accounts] 管理员创建成员：${userId}（role=${role}）`)
  return { userId, role }
}

/**
 * 删除账号（连数据隔离的 owner 数据不可由此删除——仅删账号本身）。
 * 保护：不可删除自己；不可删除最后一个 active admin。
 * @returns {boolean}
 */
export function deleteAccount(userId) {
  const u = findAccount(userId)
  if (!u) throw new Error(`用户 ${userId} 不存在`)
  if (u.role === 'admin' && u.status === 'active' && activeRefsOfRole('admin') <= 1) {
    throw new Error('不能删除唯一的管理员')
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM users WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM role_perms WHERE role_id = ?').run(`__user_${userId}`) // 防御性清理（正常无此行）
  })
  tx()
  log.info(`[accounts] 账号 ${userId} 已删除`)
  return true
}

/* ---------- 数据库目录浏览（管理端只读："数据库 → 基础库" 的数据源） ---------- */

const TABLE_META = {
  users: { desc: '用户账号表（密码 / OAuth 绑定 / 角色 / 登录锁定状态）', order: 0 },
}

// 行级脱敏：password_hash / salt 等敏感列在数据明细中以掩码下发（结构与行数不受影响）
const { browseTables, browseRows } = makeSqliteBrowser({
  db,
  file: DB_FILE,
  tableMeta: TABLE_META,
  label: 'accounts',
  rowTransform: maskSensitiveRow,
})
export { browseTables, browseRows }

/* ---------- 旧 JSON 迁移（进程启动时执行一次） ---------- */
;(() => {
  if (!existsSync(LEGACY_JSON)) return
  try {
    const raw = JSON.parse(readFileSync(LEGACY_JSON, 'utf8'))
    const users = Array.isArray(raw?.users) ? raw.users : []
    const insert = db.prepare(
      `INSERT OR IGNORE INTO users (user_id, label, role, status, auth_type, salt, password_hash,
         oauth_provider, oauth_provider_id, created_at, last_login_at, last_login_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    const tx = db.transaction((list) => {
      for (const u of list) {
        insert.run(
          u.userId,
          u.label ?? '',
          u.role ?? 'member',
          u.status ?? 'active',
          u.auth?.type ?? 'password',
          u.auth?.salt ?? null,
          u.auth?.hash ?? null,
          u.auth?.provider ?? null,
          u.auth?.providerId ?? null,
          u.createdAt ?? new Date().toISOString(),
          u.lastLoginAt ?? null,
        )
      }
    })
    tx(users)
    renameSync(LEGACY_JSON, `${LEGACY_JSON}.imported`)
    log.info(`[accounts] 旧 accounts.json 已迁移到 SQLite 用户表（${users.length} 个账号），原文件备份为 accounts.json.imported`)
  } catch (err) {
    log.warn(`[accounts] 旧 accounts.json 迁移失败（${err.message}），保留原文件待人工处理`)
  }
})()
