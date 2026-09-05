import { child } from './logger'

const log = child('api')

/**
 * AppError —— 前端统一错误类型
 * 携带 status / code / requestId，便于全局错误边界展示友好提示
 */
export class AppError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

let _requestCount = 0

/**
 * 用户令牌存取（M5a / ADR-008 user-token 档）：
 * - AUTH_MODE=user-token 时后端要求 Authorization: Bearer <token>
 * - token 由管理页签发，前端保存于 localStorage
 * - 收到 401 时广播 auth:required 事件，由 AppShell 弹出令牌输入框
 */
const USER_TOKEN_KEY = 'userToken'
export function getUserToken() {
  try {
    return localStorage.getItem(USER_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
export function setUserToken(token) {
  try {
    if (token) localStorage.setItem(USER_TOKEN_KEY, token)
    else localStorage.removeItem(USER_TOKEN_KEY)
  } catch {
    /* 存储不可用时忽略 */
  }
}

/**
 * 统一 fetch 封装：
 *  - 自动附加 x-request-id 头（与后端 requestTrace 对接，全链路可追溯）
 *  - 统一错误处理：解析错误体 → 抛 AppError → 触发全局错误边界
 *  - 请求/响应日志（DEBUG 模式下）
 *  - 流式响应（SSE / octet-stream）直接返回 Response，不解析 JSON
 */
export async function request(url, options = {}) {
  const id = ++_requestCount
  const requestId = `req-${Date.now()}-${id}`

  log.debug(`#${id} ${options.method ?? 'GET'} ${url}`)

  const token = getUserToken()
  const res = await fetch(url, {
    ...options,
    headers: {
      'x-request-id': requestId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  })

  const contentType = res.headers.get('content-type') || ''

  // 流式响应直接返回（不解析 JSON，交给调用方处理流）
  if (
    contentType.includes('text/event-stream') ||
    contentType.includes('application/octet-stream')
  ) {
    return res
  }

  // 204 No Content
  if (res.status === 204) return null

  let data
  try {
    data = await res.json()
  } catch {
    throw new AppError(`响应解析失败 (${res.status})`, {
      status: res.status,
      requestId,
    })
  }

  if (!res.ok) {
    const message = data?.message ?? `请求失败 (${res.status})`
    log.error(`#${id} 失败 ${res.status}: ${message}`)
    if (res.status === 401) {
      // 令牌缺失/失效：通知 UI 弹出令牌输入
      window.dispatchEvent(new CustomEvent('auth:required', { detail: { message } }))
    }
    throw new AppError(message, {
      status: res.status,
      code: data?.code,
      requestId,
    })
  }

  log.debug(`#${id} 成功 ${res.status}`)
  return data
}
