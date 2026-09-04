import { randomUUID } from 'node:crypto'

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/**
 * requestTrace —— 请求追踪中间件
 *
 * 职责：
 *  - 读取或生成 requestId（优先复用格式合法的上游 x-request-id 头）
 *  - 注入 req.id（pino-http 会读取它来创建带 requestId 的 child logger）
 *  - 设置 x-request-id 响应头，便于客户端/网关关联日志
 *
 * 必须注册在 pinoHttp 之前。
 */
export function requestTrace() {
  return (req, res, next) => {
    const incoming = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : ''
    const requestId = REQUEST_ID_RE.test(incoming) ? incoming : randomUUID()
    req.id = requestId
    res.setHeader('x-request-id', requestId)
    next()
  }
}

export { REQUEST_ID_RE }
