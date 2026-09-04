/**
 * logger —— 前端轻量日志工具
 *
 * 设计目标：
 *  - DEBUG 模式：开发环境默认开启，生产可用 localStorage.DEBUG_LOG=1 开启
 *  - 命名空间隔离：child('chat') / child('knowledge') 等，日志带前缀
 *  - warn/error 始终输出（不依赖 DEBUG 开关）
 *  - 零依赖，纯 console 封装
 */

const _envDev =
  typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV
const _lsFlag =
  typeof localStorage !== 'undefined'
    ? String(localStorage.getItem('DEBUG_LOG') ?? '')
    : ''
// localStorage 显式设置时以它为准；否则开发环境默认开
const DEBUG = _lsFlag ? /^(1|true|yes|on)$/i.test(_lsFlag) : !!_envDev

const _prefixes = {
  chat: '[Chat]',
  knowledge: '[Knowledge]',
  session: '[Session]',
  api: '[API]',
  error: '[Error]',
  theme: '[Theme]',
}

function _format(namespace, args) {
  const prefix = _prefixes[namespace] || `[${namespace}]`
  return [prefix, ...args]
}

export const logger = {
  debug: (...args) => {
    if (DEBUG) console.debug(...args)
  },
  info: (...args) => {
    if (DEBUG) console.info(...args)
  },
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}

export function child(namespace) {
  return {
    debug: (...a) => logger.debug(..._format(namespace, a)),
    info: (...a) => logger.info(..._format(namespace, a)),
    warn: (...a) => logger.warn(..._format(namespace, a)),
    error: (...a) => logger.error(..._format(namespace, a)),
  }
}
