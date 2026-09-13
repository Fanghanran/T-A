import { Router } from 'express'
import multer from 'multer'
import { requireUser } from '../lib/principal.js'
import { rateLimiters } from '../lib/security.js'
import { sttConfig } from '../lib/config.js'
import { childLogger } from '../lib/logger.js'

/**
 * routes/stt —— 语音转文字（M：语音输入，STT provider 转发）
 *
 * 约定：STT_BASE_URL 指向 OpenAI 兼容的 /audio/transcriptions 端点
 * （自托管 whisper-asr-webservice / Groq / 任意兼容云均可）。
 * 未配置 STT_BASE_URL 时端点明确返回 501（Fail-Fast：不静默假装支持）。
 *
 * POST /api/stt   multipart: file（音频，≤10MB）→ { text }
 * GET  /api/stt   → { enabled }（前端据此显示/隐藏麦克风按钮）
 */

const log = childLogger('stt')

const sttRouter = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

/** 语音功能是否已配置（前端麦克风按钮的显示依据） */
sttRouter.get('/api/stt', (_req, res) => {
  res.json({ enabled: sttConfig.enabled, hint: sttConfig.enabled ? '' : '未配置语音识别服务：设置 STT_BASE_URL 后重启（本地可用 docker 跑 whisper-asr-webservice）' })
})

sttRouter.post('/api/stt', requireUser, rateLimiters.upload, upload.single('file'), async (req, res) => {
  if (!sttConfig.enabled) {
    return res.status(501).json({
      message: '语音识别未配置：请在 server/.env 设置 STT_BASE_URL（OpenAI 兼容转写端点）后重启',
    })
  }
  if (!req.file) return res.status(400).json({ message: '缺少 file 字段（音频）' })

  const t0 = performance.now()
  try {
    const form = new FormData()
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'audio.webm')
    form.append('model', sttConfig.model)
    const headers = { Authorization: `Bearer ${sttConfig.apiKey}` }
    const upstream = await fetch(sttConfig.baseUrl, { method: 'POST', headers, body: form })
    const body = await upstream.json().catch(() => ({}))
    if (!upstream.ok) {
      return res.status(502).json({ message: `语音识别服务返回 ${upstream.status}：${body?.error?.message ?? body?.message ?? '未知错误'}` })
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    log.info({ ms: Math.round(performance.now() - t0), chars: text.length }, '[stt] 转写完成')
    res.json({ text })
  } catch (err) {
    res.status(502).json({ message: `语音识别服务不可达：${err.message}` })
  }
})

export default sttRouter
