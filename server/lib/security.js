import { randomUUID, timingSafeEqual } from 'node:crypto'
import { authMode as principalAuthMode } from './principal.js'
import { verifyAccessToken } from './auth/jwt.js'

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function authMode() {
  const configured = String(process.env.AUTH_MODE || '').trim().toLowerCase()
  if (configured === 'disabled') return 'disabled'
  // user-token 档：数据路由按用户令牌隔离（principal.js），管理路由仍要求 ADMIN_TOKEN
  if (configured === 'token' || configured === 'user-token') {
    return process.env.ADMIN_TOKEN ? 'token' : 'disabled'
  }
  // jwt 档（用户模块 v2）：不短路 disabled —— 管理权限由 adminAuth 内部判定
  // （ADMIN_TOKEN 或 admin 角色的登录 JWT）
  if (configured === 'jwt') {
    return 'jwt'
  }
  return process.env.NODE_ENV === 'production' && process.env.ADMIN_TOKEN ? 'token' : 'disabled'
}

export function corsOptions() {
  const raw = String(process.env.CORS_ORIGINS || '').trim()
  if (!raw) return { origin: process.env.NODE_ENV === 'production' ? false : true, credentials: true }
  const allowed = new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))
  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) return callback(null, true)
      return callback(new Error('CORS origin not allowed'))
    },
    credentials: true,
  }
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}

function tokenEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function adminAuth(req, res, next) {
  if (authMode() === 'disabled') return next()
  const expected = String(process.env.ADMIN_TOKEN || '')
  const header = req.get('authorization') || ''
  const supplied = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : req.get('x-admin-token')
  // ① 管理员令牌（ADMIN_TOKEN，现有路径零回归）
  if (expected && supplied && tokenEqual(String(supplied), expected)) {
    req.adminAuthenticated = true
    return next()
  }
  // ② jwt 模式：任意有效登录 JWT 放行（member 也过）——细粒度权限由挂载点的
  //    requirePerm(perm) 按角色权限集判定；admin 角色恒全权。
  if (principalAuthMode() === 'jwt') {
    const payload = verifyAccessToken(String(supplied || ''))
    if (payload?.sub) {
      req.adminAuthenticated = true
      req.adminUserId = payload.sub
      req.adminRole = payload.role ?? 'member'
      return next()
    }
  }
  res.setHeader('WWW-Authenticate', 'Bearer')
  return res.status(401).json({ message: '需要管理员认证' })
}

/* ---------- RBAC 权限判定（用户模块 v2.3） ---------- */

let _permsOfPromise = null
/** 惰性加载 accounts.permsOf（避免 security ← accounts 的同步加载时序耦合） */
function permsOfAsync(roleId) {
  if (!_permsOfPromise) {
    _permsOfPromise = import('./auth/accounts.js').then((m) => m.permsOf)
  }
  return _permsOfPromise.then((fn) => fn(roleId))
}

/**
 * 管理端点权限守卫：needed 满足其一即可（admin / '*' 全权）。
 * disabled 模式（单用户）全放行；member 等角色按 role_perms 实时查库。
 */
export function requirePerm(...needed) {
  return async (req, res, next) => {
    if (authMode() === 'disabled') return next()
    const header = req.get('authorization') || ''
    const supplied = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : req.get('x-user-token')
    let role = null
    if (principalAuthMode() === 'jwt') {
      const payload = verifyAccessToken(String(supplied || ''))
      if (!payload?.sub) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        return res.status(401).json({ message: '需要登录' })
      }
      role = payload.role ?? 'member'
      if (role === 'admin') {
        req.adminRole = role
        return next()
      }
    } else {
      return res.status(401).json({ message: '需要登录' })
    }
    try {
      const holds = await permsOfAsync(role)
      const ok = holds.includes('*') || needed.some((n) => holds.includes(n))
      if (!ok) {
        return res.status(403).json({ error: `权限不足（需要 ${needed.join(' 或 ')}）` })
      }
      return next()
    } catch (err) {
      return res.status(503).json({ error: err.message })
    }
  }
}

export function createRateLimiter({ windowMs, max, envPrefix, keyGenerator } = {}) {
  const window = positiveInt(windowMs, positiveInt(process.env[`${envPrefix}_WINDOW_MS`], 60_000))
  const limit = positiveInt(max, positiveInt(process.env[`${envPrefix}_LIMIT`], 60))
  const buckets = new Map()
  let lastSweep = 0
  return (req, res, next) => {
    const now = Date.now()
    if (now - lastSweep > window) {
      for (const [key, bucket] of buckets) if (now - bucket.started >= window) buckets.delete(key)
      lastSweep = now
    }
    const key = keyGenerator ? keyGenerator(req) : (req.ip || req.socket?.remoteAddress || 'unknown')
    const bucket = buckets.get(key)
    const current = !bucket || now - bucket.started >= window ? { started: now, count: 1 } : { ...bucket, count: bucket.count + 1 }
    buckets.set(key, current)
    res.setHeader('X-RateLimit-Limit', String(limit))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - current.count)))
    if (current.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((current.started + window - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({ message: '请求过于频繁，请稍后重试', retryAfter })
    }
    next()
  }
}

export const rateLimiters = {
  // chat 按 (IP, agentName) 计数：并行场景下一个智能体打满配额不影响其他智能体（ADR-008）
  chat: createRateLimiter({
    envPrefix: 'RATE_CHAT',
    max: 30,
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown'
      const agent = typeof req.body?.agentName === 'string' && req.body.agentName.trim() ? req.body.agentName.trim() : '-'
      return `${ip}:${agent}`
    },
  }),
  upload: createRateLimiter({ envPrefix: 'RATE_UPLOAD', max: 20 }),
  search: createRateLimiter({ envPrefix: 'RATE_SEARCH', max: 60 }),
  management: createRateLimiter({ envPrefix: 'RATE_MANAGEMENT', max: 120 }),
  // 认证端点独立限流：按 IP 计数，防密码暴力破解与用户枚举
  auth: createRateLimiter({ envPrefix: 'RATE_AUTH', max: 20 }),
}

function bad(res, message) {
  return res.status(400).json({ message })
}

const MAX_MESSAGE_CHARS = 32_000 // 单条消息正文上限（防单条超大消息制造同步 SQLite 写 / LLM 上下文负载）
const MAX_RESUME_CHARS = 200_000 // 简历正文上限（与知识库 content 上限同量级）
const MAX_JD_CHARS = 20_000 // 岗位 JD 上限

export function validateChatBody(req, res, next) {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(res, '请求体必须为对象')
  if (body.messages !== undefined && (!Array.isArray(body.messages) || body.messages.length > 100)) return bad(res, 'messages 必须是最多 100 条的数组')
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== 'object' || !['user', 'assistant', 'system', 'tool'].includes(message.role)) return bad(res, 'messages 包含无效消息')
      if (message.content !== undefined && typeof message.content !== 'string' && (typeof message.content !== 'object' || message.content === null)) return bad(res, '消息 content 类型无效')
      if (typeof message.content === 'string' && message.content.length > MAX_MESSAGE_CHARS) return bad(res, `单条消息不能超过 ${MAX_MESSAGE_CHARS} 字符`)
    }
  }
  if (body.agentName !== undefined && (typeof body.agentName !== 'string' || body.agentName.length > 200)) return bad(res, 'agentName 无效')
  if (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || body.sessionId.length > 200)) return bad(res, 'sessionId 无效')
  // 智能体扩展字段（简历分析 / 模拟面试）
  if (body.resumeText !== undefined && (typeof body.resumeText !== 'string' || body.resumeText.length > MAX_RESUME_CHARS)) return bad(res, `resumeText 必须为不超过 ${MAX_RESUME_CHARS} 字符的字符串`)
  if (body.jd !== undefined && (typeof body.jd !== 'string' || body.jd.length > MAX_JD_CHARS)) return bad(res, `jd 必须为不超过 ${MAX_JD_CHARS} 字符的字符串`)
  if (body.interviewFinish !== undefined && typeof body.interviewFinish !== 'boolean') return bad(res, 'interviewFinish 必须为布尔值')
  if (body.docId !== undefined && (typeof body.docId !== 'string' || body.docId.length > 200)) return bad(res, 'docId 无效')
  if (body.opReport !== undefined && (typeof body.opReport !== 'object' || body.opReport === null || Array.isArray(body.opReport))) return bad(res, 'opReport 必须为对象')
  next()
}

export function validateKnowledgeBody(req, res, next) {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(res, '请求体必须为对象')
  const query = body.query ?? body.q
  if (typeof query !== 'string' || !query.trim() || query.length > 20_000) return bad(res, '查询文本必须为 1~20000 个字符')
  if (body.history !== undefined) {
    if (!Array.isArray(body.history) || body.history.length > 50) return bad(res, 'history 必须是最多 50 条的数组')
    if (body.history.some((x) => !x || typeof x !== 'object')) return bad(res, 'history 包含无效消息')
  }
  for (const key of ['category', 'tag']) if (body[key] !== undefined && typeof body[key] !== 'string') return bad(res, `${key} 必须为字符串`)
  next()
}

export { REQUEST_ID_RE, randomUUID }
