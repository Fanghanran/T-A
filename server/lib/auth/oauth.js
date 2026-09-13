import { randomBytes } from 'node:crypto'
import { childLogger } from '../logger.js'

/**
 * oauth —— 通用 OAuth2 授权码登录（用户模块 v2）
 *
 * 设计：单 provider 槽位 + 内置 preset（github / google），env 配置即用：
 *   AUTH_OAUTH_CLIENT_ID / AUTH_OAUTH_CLIENT_SECRET   必填（缺失 = OAuth 整体关闭）
 *   AUTH_OAUTH_PROVIDER                               preset 名（github | google），或留空走全自定义
 *   AUTH_OAUTH_AUTH_URL / TOKEN_URL / USERINFO_URL    自定义端点（provider 未配时必填）
 *   AUTH_OAUTH_SCOPE                                  授权范围（默认按 preset / 'openid profile email'）
 *   AUTH_OAUTH_ID_FIELD                               userinfo 中取唯一 ID 的字段（默认按 preset / 'sub'）
 *   APP_URL                                           前端地址（回调跳转用，默认 http://127.0.0.1:5173）
 *
 * state 防 CSRF：进程内 Map（随机 16B hex，10 分钟 TTL，一次性消费）——
 * 单进程部署够用；多实例部署时需换共享存储（当前不存在该形态）。
 */

const log = childLogger('oauth')

const PRESETS = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scope: 'read:user',
    idField: 'id',
    idPrefix: 'gh',
    labelField: 'login',
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile email',
    idField: 'sub',
    idPrefix: 'gg',
    labelField: 'email',
  },
}

/** 当前 OAuth 是否已配置可用（缺 CLIENT_ID/SECRET 即关闭，显式降级不静默） */
export function oauthEnabled() {
  return Boolean(
    String(process.env.AUTH_OAUTH_CLIENT_ID || '').trim() &&
    String(process.env.AUTH_OAUTH_CLIENT_SECRET || '').trim(),
  )
}

/** 给前端的公开配置（不含 secret） */
export function oauthPublicInfo() {
  const provider = String(process.env.AUTH_OAUTH_PROVIDER || '').trim().toLowerCase()
  return {
    enabled: oauthEnabled(),
    provider: provider || 'custom',
    // 前端渲染按钮需要展示名称
    label: provider || 'OAuth',
  }
}

function providerConfig() {
  const provider = String(process.env.AUTH_OAUTH_PROVIDER || '').trim().toLowerCase()
  const preset = PRESETS[provider] ?? {}
  const cfg = {
    provider: provider || 'custom',
    authUrl: process.env.AUTH_OAUTH_AUTH_URL || preset.authUrl,
    tokenUrl: process.env.AUTH_OAUTH_TOKEN_URL || preset.tokenUrl,
    userinfoUrl: process.env.AUTH_OAUTH_USERINFO_URL || preset.userinfoUrl,
    scope: process.env.AUTH_OAUTH_SCOPE || preset.scope || 'openid profile email',
    idField: process.env.AUTH_OAUTH_ID_FIELD || preset.idField || 'sub',
    idPrefix: preset.idPrefix || provider || 'oauth',
    labelField: preset.labelField || 'name',
  }
  for (const k of ['authUrl', 'tokenUrl', 'userinfoUrl']) {
    if (!cfg[k]) throw new Error(`OAuth 配置不完整：缺少 ${k}（AUTH_OAUTH_PROVIDER 或对应 env）`)
  }
  return cfg
}

/** 生成授权跳转 URL（state 一次性随机，10 分钟有效） */
export function buildAuthorizeUrl({ redirectUri }) {
  if (!oauthEnabled()) return null
  const cfg = providerConfig()
  const state = randomBytes(16).toString('hex')
  _states.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 })
  const qs = new URLSearchParams({
    client_id: String(process.env.AUTH_OAUTH_CLIENT_ID),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: cfg.scope,
    state,
  })
  return { url: `${cfg.authUrl}?${qs.toString()}`, provider: cfg.provider }
}

const _states = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _states) if (v.expiresAt < now) _states.delete(k)
}, 60 * 1000).unref?.()

function consumeState(state) {
  const v = _states.get(String(state ?? ''))
  _states.delete(String(state ?? ''))
  return Boolean(v && v.expiresAt >= Date.now())
}

/**
 * 用授权码换身份：code → token → userinfo → { providerId, label }。
 * @returns {Promise<{ providerId:string, label:string }>}
 */
export async function exchangeIdentity({ code, redirectUri }) {
  const cfg = providerConfig()
  if (!consumeState(arguments[0]?.state)) {
    throw new Error('state 无效或已过期（防 CSRF 校验失败）')
  }
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: String(process.env.AUTH_OAUTH_CLIENT_ID),
      client_secret: String(process.env.AUTH_OAUTH_CLIENT_SECRET),
      code: String(code ?? ''),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  if (!tokenRes.ok) {
    log.warn(`[oauth] token 交换失败：${tokenRes.status}`)
    throw new Error('OAuth token 交换失败')
  }
  const tokenJson = await tokenRes.json().catch(() => null)
  const accessToken = tokenJson?.access_token
  if (!accessToken) throw new Error('OAuth token 响应缺少 access_token')

  const userRes = await fetch(cfg.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'interview-agent' },
  })
  if (!userRes.ok) {
    log.warn(`[oauth] userinfo 拉取失败：${userRes.status}`)
    throw new Error('OAuth userinfo 拉取失败')
  }
  const info = await userRes.json().catch(() => null)
  const providerId = info?.[cfg.idField]
  if (providerId === undefined || providerId === null || providerId === '') {
    throw new Error(`OAuth userinfo 缺少身份字段 ${cfg.idField}`)
  }
  return {
    providerId: String(providerId),
    label: String(info?.[cfg.labelField] ?? info?.name ?? info?.login ?? '').slice(0, 100),
  }
}
