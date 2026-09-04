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

  const res = await fetch(url, {
    ...options,
    headers: {
      'x-request-id': requestId,
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
    throw new AppError(message, {
      status: res.status,
      code: data?.code,
      requestId,
    })
  }

  log.debug(`#${id} 成功 ${res.status}`)
  return data
}
