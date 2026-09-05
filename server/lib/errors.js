/**
 * errors —— 统一异常体系 + Express 错误处理中间件
 *
 * 设计目标：
 *  - AppError 区分"客户端错误"(4xx)和"服务端错误"(5xx)
 *  - 携带 code 字段便于前端展示友好提示
 *  - errorHandler 中间件统一捕获：AppError(已知) vs Error(未知)
 *  - 结构化日志：记录 method、path、status、code、stack，关联 requestId
 *  - 统一响应格式：{ success: false, code, message }
 */

import { logger } from './logger.js'

export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', cause } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    if (cause) this.cause = cause
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, { status: 404, code: 'NOT_FOUND' })
  }
}

export class BadRequestError extends AppError {
  constructor(message) {
    super(message, { status: 400, code: 'BAD_REQUEST' })
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message, code = 'SERVICE_UNAVAILABLE') {
    super(message, { status: 503, code })
  }
}

/**
 * Express 错误处理中间件（4 参数签名，放路由之后最后注册）
 * - AppError：按 err.status 响应，消息透传
 * - 普通 Error：500，生产环境隐藏内部消息
 * - 优先用 req.log（pino-http 注入，带 requestId）；fallback 到全局 logger
 */
export function errorHandler(err, req, res, _next) {
  const isAppError = err instanceof AppError
  const status = isAppError ? err.status : 500
  const code = isAppError ? err.code : 'INTERNAL_ERROR'

  const log = req.log || logger
  log.error({
    method: req.method,
    path: req.path,
    status,
    code,
    msg: err.message,
    stack: err.stack,
  }, err.message)

  res.status(status).json({
    success: false,
    code,
    message: isAppError
      ? err.message
      : (process.env.NODE_ENV === 'production' ? '内部错误，请稍后重试' : err.message),
  })
}
