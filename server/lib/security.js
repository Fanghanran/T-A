import { randomUUID, timingSafeEqual } from 'node:crypto'

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
  if (!expected || !tokenEqual(String(supplied || ''), expected)) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    return res.status(401).json({ message: '需要管理员认证' })
  }
  req.adminAuthenticated = true
  next()
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
