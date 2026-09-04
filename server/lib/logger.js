import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'

/**
 * logger —— 结构化 JSON 日志（pino）
 *
 * 设计目标：
 *  - 结构化输出：每条日志含时间、级别、模块、requestId、消息
 *  - 开发环境：stdout JSON（可管道给 pino-pretty 美化）
 *  - 生产环境：写入文件（data/logs/app.log，可通过 LOG_FILE 覆盖）
 *  - childLogger 工厂：各模块注入独立 child，自动带 module 字段
 *  - 通过 pino-http 中间件，每条请求日志自动带 requestId
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.resolve(__dirname, '..', 'data', 'logs')
const DEFAULT_LOG_FILE = path.join(LOG_DIR, 'app.log')

const isProd = process.env.NODE_ENV === 'production'
const debugEnabled = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG_LOG ?? '').trim())
// level 规则：LOG_LEVEL 显式覆盖 > 生产 info > DEBUG_LOG=1 时 debug > 默认 info
// 这样 dbg()/logger.debug() 在生产或未开 DEBUG_LOG 时自动静默，与原 dbg() 行为一致
const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : (debugEnabled ? 'debug' : 'info'))

// 写文件的开关。
// 原实现只认 NODE_ENV=production，但本项目从未设置该变量 —— 结果「生产写 data/logs/app.log」
// 这段配置从来没生效过，日志全走 stdout，服务一重启就丢。
// 改为显式开关：LOG_TO_FILE=1、或显式指定 LOG_FILE、或 NODE_ENV=production，任一成立即写文件。
const logToFile =
  /^(1|true|yes|on)$/i.test(String(process.env.LOG_TO_FILE ?? '').trim()) ||
  Boolean((process.env.LOG_FILE ?? '').trim()) ||
  isProd

/**
 * 同步探测目标日志文件是否可写。
 *
 * pino.destination 的文件打开失败是**异步** emit 的 'error' 事件，等它抛出来时 logger
 * 已经建好了，来不及降级 —— 结果是整个服务进程被打挂（实测：在受限环境开启
 * LOG_TO_FILE 会直接起不来）。所以必须在创建前先同步试一次。
 */
function isWritable(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 以追加方式打开再立刻关闭，能同时覆盖「文件不存在」和「无写权限」两种情况
    const fd = fs.openSync(file, 'a')
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

let destination
if (logToFile) {
  const file = (process.env.LOG_FILE ?? '').trim()
    ? path.resolve(process.cwd(), process.env.LOG_FILE.trim())
    : DEFAULT_LOG_FILE
  if (isWritable(file)) {
    destination = pino.destination(file)
  } else {
    // 日志写不成本不该拖垮服务 —— 降级 stdout 并明确告知
    console.error(`[logger] 无法写入日志文件 ${file}（权限受限），已降级为 stdout`)
  }
}

export const logger = pino(
  {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { app: 'interview-agent' },
  },
  destination,
)

/**
 * 模块级 child logger：各 lib 模块用 childLogger('vectorStore') 拿到带 module 字段的 logger
 * @param {string} moduleName
 * @returns {import('pino').Logger}
 */
export function childLogger(moduleName) {
  return logger.child({ module: moduleName })
}
