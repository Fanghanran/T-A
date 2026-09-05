import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from './logger.js'

/**
 * principal —— 用户主体抽象（M5a / ADR-008 B 部分，L0 基础设施）
 *
 * 认证三档递进（AUTH_MODE）：
 *   disabled    单一系统用户 local，全部数据归 local，现状零回归（默认）
 *   user-token  请求携带用户令牌（Authorization: Bearer / x-user-token）→ 解析为 userId；
 *               数据层（SQLite / Milvus）按 owner_id 强制过滤，跨用户不可见
 *   jwt         预留升级位（本期不实现，ADR-008 明确不做 OAuth）
 *
 * 令牌只存 sha256 哈希，明文仅在签发响应中出现一次；
 * 管理端点（签发/吊销）由 manager.js 挂 adminAuth，本模块只提供存取与校验。
 */

const log = childLogger('principal')

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'management')
const USERS_FILE = join(DATA_DIR, 'users.json')

export const LOCAL_USER_ID = 'local'

const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 用户体系是否启用（false = 全部请求视为 local 单一用户） */
export function usersEnabled() {
  return String(process.env.AUTH_MODE || '').trim().toLowerCase() === 'user-token'
}

function sha256(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')
}

let _users = null

function loadUsers() {
  if (_users) return _users
  try {
    if (existsSync(USERS_FILE)) {
      const raw = JSON.parse(readFileSync(USERS_FILE, 'utf8'))
      _users = Array.isArray(raw?.users) ? raw.users : []
    } else {
      _users = []
    }
  } catch (err) {
    log.warn(`[principal] 读取 ${USERS_FILE} 失败（${err.message}），按空用户表处理`)
    _users = []
  }
  return _users
}

function saveUsers() {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(USERS_FILE, JSON.stringify({ version: 1, users: _users }, null, 2), 'utf8')
}

/** 校验 userId 形态（存储层把 ownerId 拼进 Milvus 过滤表达式，白名单即防注入） */
export function isValidUserId(userId) {
  return typeof userId === 'string' && USER_ID_RE.test(userId)
}

function tokenEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * 从请求解析用户主体。
 * @returns {{userId: string}|null} disabled 模式恒为 local；user-token 模式下令牌无效返回 null
 */
export function principalOf(req) {
  if (!usersEnabled()) return { userId: LOCAL_USER_ID }
  const header = req.get('authorization') || ''
  const supplied = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : req.get('x-user-token')
  if (!supplied) return null
  const hash = sha256(supplied)
  const user = loadUsers().find((u) => u.tokenHash && !u.revokedAt && tokenEqual(u.tokenHash, hash))
  return user ? { userId: user.userId } : null
}

/** Express 中间件：挂 req.principal；user-token 模式下令牌缺失/无效 → 401 */
export function requireUser(req, res, next) {
  const p = principalOf(req)
  if (!p) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    return res.status(401).json({ message: '需要用户令牌（Authorization: Bearer <token> 或 x-user-token）' })
  }
  req.principal = p
  next()
}

/** 签发用户令牌；明文 token 只在本次返回中出现，落库为 sha256 */
export function issueUserToken({ userId, label } = {}) {
  if (!isValidUserId(userId)) {
    throw new Error('userId 无效：仅允许字母数字下划线连字符，1~32 位，且以字母或数字开头')
  }
  if (userId === LOCAL_USER_ID) throw new Error('local 为系统保留用户，禁止签发')
  const users = loadUsers()
  if (users.some((u) => u.userId === userId && !u.revokedAt)) {
    throw new Error(`用户 ${userId} 已存在`)
  }
  const token = `ua_${randomBytes(24).toString('hex')}`
  users.push({
    userId,
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : '',
    tokenHash: sha256(token),
    createdAt: new Date().toISOString(),
    revokedAt: null,
  })
  saveUsers()
  log.info(`[principal] 已签发用户令牌：${userId}`)
  return { userId, token }
}

/** 用户列表（不含令牌哈希） */
export function listUsers() {
  return loadUsers().map((u) => ({
    userId: u.userId,
    label: u.label,
    createdAt: u.createdAt,
    revokedAt: u.revokedAt ?? null,
  }))
}

/** 吊销用户（数据保留，令牌立即失效；不可吊销 local） */
export function revokeUser(userId) {
  if (userId === LOCAL_USER_ID) throw new Error('local 为系统保留用户，禁止吊销')
  const users = loadUsers()
  const u = users.find((x) => x.userId === userId && !x.revokedAt)
  if (!u) return false
  u.revokedAt = new Date().toISOString()
  saveUsers()
  log.info(`[principal] 已吊销用户令牌：${userId}`)
  return true
}
