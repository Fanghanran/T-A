import { Router } from 'express'
import { childLogger } from '../lib/logger.js'
import { principalOf } from '../lib/principal.js'
import { usageOf } from '../lib/quota.js'
import { signAccessToken } from '../lib/auth/jwt.js'
import { appendAudit } from '../lib/management/audit.js'
import { rateLimiters } from '../lib/security.js'
import {
  registerAccount,
  authenticate,
  oauthFindOrCreate,
  registrationEnabled,
  listAccounts,
} from '../lib/auth/accounts.js'
import { oauthEnabled, oauthPublicInfo, buildAuthorizeUrl, exchangeIdentity } from '../lib/auth/oauth.js'
import { permsOf } from '../lib/auth/accounts.js'

/**
 * routes/auth —— 认证端点（公开路由，不挂用户守卫 / adminAuth）
 *
 * POST /api/auth/register        注册（AUTH_REGISTRATION 门控；空库首账号自动 admin）
 * POST /api/auth/login           密码登录 → JWT（7 天）
 * GET  /api/auth/me              当前身份（三模式通用；前端 Header 用户菜单数据源）
 * GET  /api/auth/oauth/start     OAuth 授权跳转（未配置时 JSON 显式降级）
 * GET  /api/auth/oauth/callback  OAuth 回调 → find-or-create 账号 → 签发 JWT → 重定向前端
 *
 * 限流下沉：auth 爆破限流桶（RATE_AUTH，默认 20/窗）只护 login / register / oauth/start
 * 三个「凭据提交面」；me 是每次页面启动必调的身份查询，不占爆破桶（否则批量身份查询
 * 会把登录爆破防护的窗口额度吃光，登录反被 429 误伤——2026-09-12 实测教训）。
 */

const log = childLogger('auth')

export const authRouter = Router()

/** 脱敏账号视图（/me 用） */
function publicAccount({ userId, label, role, status, createdAt, lastLoginAt, authType }) {
  return { userId, label, role, status, authType, createdAt, lastLoginAt }
}

/** 客户端来源 IP（Express req.ip；无 trust proxy 时即 socket 地址） */
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '')
}

/* ---------- 注册 ---------- */

authRouter.post('/api/auth/register', rateLimiters.auth, (req, res) => {
  try {
    const r = registerAccount({
      userId: String(req.body?.userId ?? '').trim(),
      password: String(req.body?.password ?? ''),
      label: req.body?.label,
    })
    appendAudit('auth.register', { ownerId: r.userId, role: r.role, ip: clientIp(req) })
    res.json({ ok: true, ...r })
  } catch (err) {
    res.status(err.status ?? 400).json({ message: err.message })
  }
})

/* ---------- 密码登录（含失败锁定 + 审计） ---------- */

authRouter.post('/api/auth/login', rateLimiters.auth, (req, res) => {
  const userId = String(req.body?.userId ?? '').trim()
  try {
    const account = authenticate({
      userId,
      password: String(req.body?.password ?? ''),
      ip: clientIp(req),
    })
    const { token, expiresAt } = signAccessToken(account)
    appendAudit('auth.login', { ownerId: account.userId, ip: clientIp(req) })
    log.info(`[auth] 登录成功：${account.userId}`)
    res.json({ ok: true, token, tokenType: 'Bearer', expiresAt, user: publicAccount({ ...account, authType: 'password' }) })
  } catch (err) {
    // 423=账号锁定；401=凭据错误（防枚举统一文案）；403=账号禁用
    appendAudit(err.status === 423 ? 'auth.account.locked' : 'auth.login.failed', {
      ownerId: userId || 'unknown',
      ip: clientIp(req),
      reason: err.message,
    })
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter))
    res.status(err.status ?? 401).json({ message: err.message, retryAfter: err.retryAfter })
  }
})

/* ---------- 当前身份（三模式通用） ---------- */

authRouter.get('/api/auth/me', (req, res) => {
  const mode = String(process.env.AUTH_MODE || '').trim().toLowerCase() || 'disabled'
  const p = principalOf(req) // disabled 恒 local；jwt/user-token 模式令牌无效时为 null
  const userId = p?.userId ?? null
  // RBAC：权限集实时查库（JWT 只带 role，角色权限变更刷新页面即生效）
  const perms = userId ? (mode === 'disabled' ? ['*'] : permsOf(p?.role ?? 'member')) : []
  res.json({
    mode,
    registrationEnabled: registrationEnabled(),
    authenticated: Boolean(userId),
    user: userId ? { ...publicAccount({ userId, role: p?.role ?? 'member', ...findAccountSafe(userId) }), usage: safeUsage(userId), perms } : null,
    oauth: oauthPublicInfo(),
  })
})

function findAccountSafe(userId) {
  try {
    return listAccounts().find((a) => a.userId === userId) ?? {}
  } catch {
    return {}
  }
}

function safeUsage(userId) {
  try {
    const u = usageOf(userId)
    return { documents: u.documents, chunks: u.chunks, limits: u.limits }
  } catch {
    return null
  }
}

/* ---------- OAuth（env 门控） ---------- */

authRouter.get('/api/auth/oauth/start', rateLimiters.auth, (req, res) => {
  if (!oauthEnabled()) {
    return res.status(404).json({ message: 'OAuth 登录未启用（服务端未配置 AUTH_OAUTH_CLIENT_ID/SECRET）' })
  }
  const redirectUri = `${String(process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')}/auth/callback`
  try {
    const r = buildAuthorizeUrl({ redirectUri })
    if (!r) return res.status(404).json({ message: 'OAuth 登录未启用' })
    res.json({ ok: true, url: r.url, provider: r.provider })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

authRouter.get('/api/auth/oauth/callback', async (req, res) => {
  const frontendBase = String(process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
  const back = (fragment) => res.redirect(`${frontendBase}/auth/callback${fragment}`)
  try {
    if (req.query.error) return back(`#error=${encodeURIComponent(String(req.query.error))}`)
    const redirectUri = `${frontendBase}/auth/callback`
    const identity = await exchangeIdentity({ code: req.query.code, state: req.query.state, redirectUri })
    const account = oauthFindOrCreate({ provider: oauthPublicInfo().provider, providerId: identity.providerId, label: identity.label, ip: clientIp(req) })
    const { token, expiresAt } = signAccessToken(account)
    appendAudit('auth.login', { ownerId: account.userId, via: 'oauth', ip: clientIp(req) })
    log.info(`[auth] OAuth 登录成功：${account.userId}`)
    back(`#token=${encodeURIComponent(token)}&expiresAt=${expiresAt}&userId=${encodeURIComponent(account.userId)}`)
  } catch (err) {
    log.warn(`[auth] OAuth 回调失败：${err.message}`)
    back(`#error=${encodeURIComponent(err.message)}`)
  }
})
