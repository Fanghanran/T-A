import { Readable, Transform } from 'node:stream'
import multer from 'multer'
import express from 'express'
import { childLogger } from '../lib/logger.js'

/**
 * routes/shared —— 路由层共享设施（仅被 routes/* 引用，不反向暴露给 lib）
 *
 * 集中放置所有路由模块共用的横切工具：
 *  - pipeStream   Web ReadableStream → SSE 响应（AI SDK data-stream 管道 + 落库回调）
 *  - parseTags    tags 字段的多种提交格式归一化
 *  - upload       multer 单例（内存存储，10MB 上限，knowledge 与 doc-processor 上传共用）
 *  - TEXT_EXT / UNSUPPORTED_HINT   支持的上传格式清单
 *  - dbg          结构化 debug 日志适配器（console.log 兼容签名 → pino）
 */

/** 模块 logger：dbg(...) 保留 console.log 兼容签名 → pino logger.debug 适配器 */
const log = childLogger('routes')

export function dbg(...args) {
  if (args.length === 0) return
  if (args.length === 1) {
    log.debug(args[0])
    return
  }
  const msg = typeof args[0] === 'string' ? args[0] : String(args[0])
  const rest = args.slice(1)
  log.debug({ details: rest.length === 1 ? rest[0] : rest }, msg)
}

/**
 * 把 Web ReadableStream 以 SSE 形式 pipe 到 Express 响应。
 * - 可选 sessionId：写入响应头 x-session-id，前端读取后绑定 UI
 * - 可选 onAssistantText(fullText, annotations)：在流结束时回调
 *   "所有 0:text 分片拼接后的完整 assistant 文本 + 累积的 2: 注解"，
 *   用于持久化到会话消息库（流式过程中不会落盘，避免写一半的脏数据）。
 */
export function pipeStream(res, webStream, { sessionId, onAssistantText } = {}) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  if (sessionId) res.setHeader('x-session-id', sessionId)
  res.status(200)

  if (typeof onAssistantText !== 'function') {
    Readable.fromWeb(webStream).pipe(res)
    return
  }

  // 需要在流式结束时把完整文本回调 → 中间加一层 Transform 累计 0:text 分片
  let assistantText = ''
  let buf = ''
  // 累积 2: 注解行（search_results 等），用于持久化到会话消息
  let annotations = []
  let lineCount = 0
  let annotLineCount = 0
  let textLineCount = 0
  let otherLineCount = 0
  let _fired = false
  const sampleLines = [] // 采样前 30 行的前缀，便于协议诊断
  const accumTransform = new Transform({
    transform(chunk, encoding, cb) {
      const str = chunk.toString('utf8')
      buf += str
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        lineCount++
        const clean = line.replace(/\r$/, '')
        if (sampleLines.length < 30) sampleLines.push(clean.slice(0, 80))
        if (clean.startsWith('0:')) {
          textLineCount++
          try {
            const seg = JSON.parse(clean.slice(2))
            assistantText += typeof seg === 'string' ? seg : ''
          } catch {
            /* ignore */
          }
        } else if (clean.startsWith('2:')) {
          annotLineCount++
          try {
            const raw = clean.slice(2)
            const parsed = JSON.parse(raw)
            dbg(`[pipeStream] ✅ 解析到注解行 #${annotLineCount}`, {
              rawLen: raw.length,
              isArray: Array.isArray(parsed),
              items: (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ type: p?.type, engine: p?.engine, total: p?.total })),
            })
            if (Array.isArray(parsed)) {
              annotations = annotations.concat(parsed)
            } else if (parsed) {
              annotations.push(parsed)
            }
          } catch (e) {
            log.warn({ msg: e.message, rawPrefix: clean.slice(2, 120) }, '[pipeStream] 注解行解析失败')
          }
        } else if (clean.startsWith('d:') || clean.startsWith('1:') || clean.startsWith('3:') || clean.startsWith('4:')) {
          // AI SDK 其他协议行（done / reasoning / step / errors），忽略
        } else if (clean.length > 0) {
          otherLineCount++
        }
      }
      cb(null, chunk)
    },
    flush(cb) {
      // 收尾：处理 buf 里剩余半行
      if (buf) {
        const clean = buf.replace(/\r$/, '')
        if (sampleLines.length < 30) sampleLines.push(clean.slice(0, 80))
        if (clean.startsWith('0:')) {
          textLineCount++
          try {
            const seg = JSON.parse(clean.slice(2))
            assistantText += typeof seg === 'string' ? seg : ''
          } catch {
            /* ignore */
          }
        } else if (clean.startsWith('2:')) {
          annotLineCount++
          try {
            const parsed = JSON.parse(clean.slice(2))
            if (Array.isArray(parsed)) {
              annotations = annotations.concat(parsed)
            } else if (parsed) {
              annotations.push(parsed)
            }
          } catch {
            /* ignore */
          }
        }
      }
      dbg(`[pipeStream] flush | 总行=${lineCount} | 0:text行=${textLineCount} | 2:annot行=${annotLineCount} | 其他协议行=${otherLineCount} | annotations数=${annotations.length} | buf=${buf.length}`)
      // 打印采样前 15 行用于肉眼判断协议格式
      if (sampleLines.length > 0) {
        dbg(`[pipeStream] 前${Math.min(15, sampleLines.length)}行采样:`)
        sampleLines.slice(0, 15).forEach((l, i) => {
          const head = l.slice(0, 80).replace(/\r/g, '\\r')
          const len = l.length
          dbg(`       [L${i + 1}/${len}] ${head}`)
        })
      }
      cb()
    },
  })

  // 触发持久化回调：res finish = 响应已经全部发出，流一定已结束
  // （注：不挂 accumTransform.on('end')，因为 Readable.fromWeb() 的某些场景下 end 事件链路不稳定
  //   → 导致 annotations 永远落不了盘；而 res.finish 在 res.end()/pipe完成时必然触发）
  function _fireOnAssistantText() {
    if (_fired) return
    _fired = true
    const annotCount = annotations.length
    dbg(
      `[pipeStream] 持久化（res finish） | textLen=${assistantText.length} | annotationsCount=${annotCount}`,
      annotCount > 0 ? { annots: annotations.map((a) => ({ type: a?.type, engine: a?.engine, total: a?.total, results: a?.results?.length })) } : null,
    )
    try {
      if (typeof onAssistantText === 'function') onAssistantText(assistantText, annotations)
    } catch (e) {
      log.error({ msg: e.message, stack: e.stack }, '[pipeStream] onAssistantText 回调异常')
    }
  }
  res.on('finish', _fireOnAssistantText)
  res.on('close', _fireOnAssistantText)
  // 保险：仍然挂 end/error 作为兜底
  accumTransform.on('end', _fireOnAssistantText)
  accumTransform.on('error', (e) => {
    log.error({ msg: e.message }, '[pipeStream] accumTransform error')
    _fireOnAssistantText()
  })

  Readable.fromWeb(webStream).pipe(accumTransform).pipe(res)
}

/** 解析 tags：兼容多种提交格式（数组 / JSON 字符串 / 逗号分隔字符串 / multer 多值） */
export function parseTags(raw) {
  if (!raw) return []

  // 如果 multer 将同名字段解析为数组
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string') {
      // 尝试解析单个字符串元素
      try {
        const v = JSON.parse(raw[0])
        if (Array.isArray(v)) return v
        return [v]
      } catch {
        // 不是 JSON，按逗号切分
        return raw[0].split(',').map((s) => s.trim()).filter(Boolean)
      }
    }
    // 其他情况，假设已经是正确的 tag 数组
    return raw.map(String).filter(Boolean)
  }

  // 单个字符串
  if (typeof raw === 'string') {
    // 先尝试 JSON 解析
    try {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v
      return [String(v)]
    } catch {
      // JSON 解析失败，按逗号切分
      return raw.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }

  return []
}

/** 文件上传中间件单例：内存存储（文本类小文件，无需落盘），10MB 上限 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

/** 路由层通用的 JSON body 大小限制（与各端点原配置一致） */
export const jsonLimits = {
  small: express.json({ limit: '64kb' }),
  chat: express.json({ limit: '8mb' }),
  preview: express.json({ limit: '4mb' }),
  batch: express.json({ limit: '256kb' }),
  manual: express.json({ limit: '2mb' }),
  search: express.json({ limit: '1mb' }),
}

// 支持的后缀。PDF / DOCX 自 2026-08-30 起支持（pdfjs-dist + mammoth，均为纯 JS，
// 本机无 VS C++ Build Tools，不能选需要编译原生模块的库）。
// XLSX / PPTX / ODF / RTF 仍不支持：需要额外解析库，且并非面试资料的主流格式。
export const TEXT_EXT = /\.(md|markdown|txt|html?|csv|tsv|log|json|ya?ml|pdf|docx)$/i
export const UNSUPPORTED_HINT =
  '当前支持 .md/.markdown/.txt/.html/.csv/.tsv/.log/.json/.yaml/.yml/.pdf/.docx'
