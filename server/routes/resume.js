import { Router } from 'express'
import { extractDocumentTextAsync, decodeFilename } from '../lib/docProcessor.js'
import { rateLimiters } from '../lib/security.js'
import { upload, TEXT_EXT, UNSUPPORTED_HINT, dbg } from './shared.js'

/**
 * routes/resume —— 简历上传解析（供「简历分析」智能体使用）
 *
 * POST /api/resume/parse  (multipart/form-data: file)
 *   抽文本 → 返回 { title, text, format, chars }，**不落知识库**（简历不应被 RAG 检索污染）。
 *   前端拿到 text 后，经 /api/chat 的 body.resumeText 交给 resume-analysis 智能体分析。
 *
 * 依赖：docProcessor（提取，L4）/ security（限流，L0）/ shared（multer + 工具）。
 */
export const resumeRouter = Router()

resumeRouter.post('/api/resume/parse', rateLimiters.upload, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: '缺少 file 字段' })
    const originalName = decodeFilename(req.file.originalname)
    if (!TEXT_EXT.test(originalName)) {
      return res.status(400).json({ message: `${originalName} 暂不支持；${UNSUPPORTED_HINT}` })
    }
    let parsed
    try {
      parsed = await extractDocumentTextAsync(req.file.buffer, originalName)
    } catch (e) {
      return res.status(400).json({ message: `${originalName} 解析失败：${e.message}` })
    }
    const { text, format } = parsed
    if (!text || !text.trim()) {
      return res.status(400).json({ message: '简历内容为空，无法解析' })
    }
    dbg(`[resume] 解析 ${originalName} → ${text.length} 字 | format=${format}`)
    res.json({ title: originalName, text, format, chars: text.length })
  } catch (err) {
    next(err)
  }
})
