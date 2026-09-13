import { getUserToken } from './api'

/**
 * authClient —— 认证状态查询（用户模块 v2：密码 / JWT / OAuth）
 *
 * 后端三模式通用端点 GET /api/auth/me：
 *   { mode, authenticated, user, registrationEnabled, oauth }
 *
 * 走裸 fetch 而非 api.request()：401 时不触发全局 auth:required 弹窗
 * （登录/身份场景的 401 由页面自行处理，避免令牌粘贴框打扰）。
 */

export async function fetchAuthMe() {
  const token = getUserToken()
  const res = await fetch('/api/auth/me', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`身份查询失败 (${res.status})`)
  return res.json()
}

/** 登录（密码）；成功返回 { token, user, expiresAt } */
export async function loginWithPassword(userId, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.message || `登录失败 (${res.status})`)
  return data
}

/** 注册；成功返回 { userId, role }（不含令牌，需再登录） */
export async function registerAccount(userId, password, label) {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password, label }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.message || `注册失败 (${res.status})`)
  return data
}
