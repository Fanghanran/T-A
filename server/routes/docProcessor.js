import { Router } from 'express'
import * as store from '../lib/vectorStore.js'
import {
  previewChunks,
  parseAdjustmentInstruction,
  applyChunkAdjustment,
  exportChunksAsMarkdown,
  prepareDocChunksAndVectors,
  extractDocumentTextAsync,
  analyzeDocFeatures,
  attachChunkScoresAsync,
  getCachedPreview,
  setCachedPreview,
  clearCachedPreview,
  decodeFilename,
  listTemplates,
  upsertTemplate,
  removeTemplate,
} from '../lib/docProcessor.js'
import { prepareAdjustedChunks, dedupPreparedChunks } from '../lib/tools/docTools.js'
import { rateLimiters } from '../lib/security.js'
import { upload, TEXT_EXT, UNSUPPORTED_HINT, dbg } from './shared.js'

/**
 * routes/docProcessor —— 文档处理智能体的 REST 操作端点（前端底部操作栏直调，非流式）
 *
 * 端点：
 *  - POST   /api/doc-processor/upload           上传文件 → 提取文本 → 建 doc（不入库，等确认）
 *  - POST   /api/doc-processor/preview          预览切片（含质量评分，不 embed 不入库）
 *  - POST   /api/doc-processor/adjust           自然语言调整指令 → 应用到缓存切片
 *  - POST   /api/doc-processor/commit           入库（embed + 去重 + 写 Milvus；409 防重复）
 *  - POST   /api/doc-processor/commit-batch     批量入库（单份失败不中断整批）
 *  - POST   /api/doc-processor/export           导出当前切片为 Markdown
 *  - GET    /api/doc-processor/templates        模板列表
 *  - POST   /api/doc-processor/templates        新建/更新模板
 *  - DELETE /api/doc-processor/templates/:id    删除模板
 *  - POST   /api/doc-processor/templates/apply       套用模板（重切写入预览缓存）
 *  - POST   /api/doc-processor/templates/apply-batch 批量套用模板
 *
 * 与 /api/chat 的 doc-processor 分支共享同一份预览缓存（docProcessor.getCachedPreview），
 * 因此「操作栏预览 → 对话里说入库」与「对话框里调整 → 操作栏入库」两侧看到的切片始终一致。
 * 入库在按钮点击（即用户明确确认）时执行，无需聊天守卫。
 *
 * 依赖：docProcessor（切片/评分/模板/缓存）/ tools.docTools（入库准备+去重，与
 * 聊天侧 CommitToStore 工具同口径）/ vectorStore（文档与切片存储）。
 */

export const docProcessorRouter = Router()

// ---------- 上传文件 → 提取文本 → 建 doc（不入库，等用户确认）----------
// 与知识库上传的区别：这里只做"提取 + 建文档"，不切片不入库，留给后续 analyze/preview/confirm 流程。
docProcessorRouter.post('/api/doc-processor/upload', rateLimiters.upload, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: '缺少 file 字段' })
    const originalName = decodeFilename(req.file.originalname)

    if (!TEXT_EXT.test(originalName)) {
      return res.status(400).json({
        message: `${originalName} 暂不支持；${UNSUPPORTED_HINT}`,
      })
    }

    let parsed
    try {
      parsed = await extractDocumentTextAsync(req.file.buffer, originalName)
    } catch (e) {
      return res.status(400).json({ message: `${originalName} 解析失败：${e.message}` })
    }
    const { text, format } = parsed
    if (!text || !text.trim()) {
      return res.status(400).json({ message: '文档内容为空，无法处理' })
    }

    const features = analyzeDocFeatures(text)
    const doc = await store.createDocument({
      title: originalName,
      category: '',
      tags: [],
      size: req.file.buffer.length,
      content: text,
      source: 'doc-processor',
      ownerId: req.principal.userId,
    })

    // 初始化预览缓存（文本 + 推荐策略，chunks 待 preview 填充）
    setCachedPreview(doc.id, { ownerId: req.principal.userId, text, chunks: null, strategy: features.suggestedStrategy, opts: { maxChars: features.maxChars } })

    dbg(`[doc-processor] 上传 ${originalName} → doc ${doc.id} | ${features.chars} 字 / ${features.paragraphs} 段 | format=${format} | 推荐 strategy=${features.suggestedStrategy}`)

    res.status(201).json({
      docId: doc.id,
      title: originalName,
      format,
      chars: features.chars,
      paragraphs: features.paragraphs,
      headings: features.headings,
      hasCode: features.hasCode,
      hasQa: features.hasQa,
      hasTable: features.hasTable,
      suggestedStrategy: features.suggestedStrategy,
      suggestedMaxChars: features.maxChars,
    })
  } catch (err) {
    next(err)
  }
})

/** 解析文档正文与预览缓存（preview/adjust/commit/export 共用） */
function resolveDocContext(docId, ownerId) {
  if (!docId || typeof docId !== 'string') return { error: 400, message: '缺少 docId' }
  const cached = getCachedPreview(docId)
  // 预览缓存按 owner 隔离：他人上传的文档解析不到缓存正文，getDocument 也会 404
  const doc = store.getDocument(docId, ownerId)
  if (cached && cached.ownerId !== ownerId) return { error: 404, message: '文档不存在或内容为空，请重新上传' }
  const text = cached?.text || doc?.content || ''
  if (!text.trim()) return { error: 404, message: '文档不存在或内容为空，请重新上传' }
  return { cached, doc, text }
}

/** 预览：返回当前切片（缓存优先，含用户已做的调整；无缓存则按推荐策略切一次），带质量评分 */
docProcessorRouter.post('/api/doc-processor/preview', async (req, res, next) => {
  try {
    const docId = String(req.body?.docId ?? '').trim()
    const ctx = resolveDocContext(docId, req.principal.userId)
    if (ctx.error) return res.status(ctx.error).json({ message: ctx.message })
    let chunks = ctx.cached?.chunks
    if (!chunks) {
      chunks = await previewChunks(ctx.text, { strategy: ctx.cached?.strategy, ...(ctx.cached?.opts || {}) })
      setCachedPreview(docId, { ownerId: req.principal.userId, text: ctx.text, chunks, strategy: ctx.cached?.strategy || 'semantic', opts: ctx.cached?.opts || {} })
    }
    // 返回带评分的副本（启发式 + 语义混合评分）；缓存里仍存未评分切片
    const scored = await attachChunkScoresAsync(chunks)
    const totalChars = chunks.reduce((s, c) => s + (c.chars || 0), 0)
    dbg(`[doc-processor:rest] preview doc ${docId} → ${chunks.length} 块 | 均分 ${scored.avgScore} | ${scored.scoreMode}`)
    res.json({ docId, title: ctx.doc?.title ?? '', chunks: scored.chunks, totalChunks: chunks.length, totalChars, avgScore: scored.avgScore, scoreMode: scored.scoreMode })
  } catch (err) {
    next(err)
  }
})

/** 调整：自然语言指令（与聊天同口径，复用 parseAdjustmentInstruction）→ 应用到缓存切片 */
docProcessorRouter.post('/api/doc-processor/adjust', async (req, res, next) => {
  try {
    const docId = String(req.body?.docId ?? '').trim()
    const instruction = String(req.body?.instruction ?? '').trim()
    const ctx = resolveDocContext(docId, req.principal.userId)
    if (ctx.error) return res.status(ctx.error).json({ message: ctx.message })
    const adj = parseAdjustmentInstruction(instruction)
    if (!adj) {
      return res.status(400).json({ message: '无法解析调整指令，支持"合并第2、3块"、"拆分第5块"、"maxChars 改成 1000"' })
    }
    let chunks = ctx.cached?.chunks
    if (!chunks) {
      chunks = await previewChunks(ctx.text, { strategy: ctx.cached?.strategy, ...(ctx.cached?.opts || {}) })
    }
    let newChunks
    let opts = ctx.cached?.opts || {}
    if (adj.op === 'reparam') {
      opts = { ...opts, maxChars: adj.maxChars }
      newChunks = await previewChunks(ctx.text, { strategy: ctx.cached?.strategy || 'semantic', ...opts })
    } else {
      newChunks = applyChunkAdjustment(chunks, adj)
    }
    setCachedPreview(docId, { text: ctx.text, chunks: newChunks, strategy: ctx.cached?.strategy || 'semantic', opts })
    // 合并/拆分后评分已过期，重新混合评分再返回
    const scored = await attachChunkScoresAsync(newChunks)
    const totalChars = newChunks.reduce((s, c) => s + (c.chars || 0), 0)
    dbg(`[doc-processor:rest] adjust doc ${docId} ${JSON.stringify(adj)} → ${newChunks.length} 块 | ${scored.scoreMode}`)
    res.json({ docId, chunks: scored.chunks, totalChunks: newChunks.length, totalChars, avgScore: scored.avgScore, scoreMode: scored.scoreMode, adjustment: adj })
  } catch (err) {
    next(err)
  }
})

/**
 * 入库公共函数（/commit 与 /commit-batch 共用）：
 * 预览缓存优先（保留用户调整）→ 批内+跨文档去重 → 写入 Milvus → 清缓存。
 * @throws {Error & {status:number}} 业务错误（404 文档不存在 / 409 已入库）
 */
async function commitDocToStore(docId, ownerId) {
  const ctx = resolveDocContext(docId, ownerId)
  if (ctx.error) {
    const e = new Error(ctx.message)
    e.status = ctx.error
    throw e
  }
  // 防重复入库：addChunks 是追加语义，重复点击会写入重复数据
  if (store.listChunksOf(docId, ownerId).length > 0) {
    const e = new Error('该文档已入库，请勿重复操作')
    e.status = 409
    throw e
  }
  const t0 = performance.now()
  const cached = ctx.cached
  let chunkList
  let vectors
  let questionVectors
  if (cached?.chunks?.length) {
    // 有预览（含用户调整）→ 直接用，保留合并/拆分结果
    ;({ chunkList, vectors, questionVectors } = await prepareAdjustedChunks(cached.chunks))
  } else {
    ;({ chunkList, vectors, questionVectors } = await prepareDocChunksAndVectors(ctx.text, {
      strategy: cached?.strategy,
      delimiter: cached?.strategy === 'delimiter' ? cached.opts?.delimiter : undefined,
      maxChars: cached?.opts?.maxChars,
    }))
  }
  // 文档去重（与聊天侧 CommitToStore 工具同口径）：批内余弦 + 跨文档 Milvus 检索
  const deduped = await dedupPreparedChunks(chunkList, vectors, questionVectors)
  chunkList = deduped.chunkList
  vectors = deduped.vectors
  questionVectors = deduped.questionVectors
  await store.addChunks(docId, chunkList, vectors, { category: ctx.doc?.category || '', tags: ctx.doc?.tags || [], ownerId, questionVectors })
  // 记录切片策略：后续编辑正文 / reindex 重切时按此恢复，切片格式不漂移
  store.setDocStrategy(docId, {
    strategy: cached?.strategy === 'delimiter' ? 'delimiter' : 'semantic',
    delimiter: cached?.strategy === 'delimiter' ? cached.opts?.delimiter : undefined,
    maxChars: cached?.opts?.maxChars,
    overlapChars: cached?.opts?.overlapChars,
  })
  clearCachedPreview(docId)
  const totalChars = chunkList.reduce((s, c) => s + (typeof c.text === 'string' ? c.text.length : 0), 0)
  const ms = Math.round(performance.now() - t0)
  dbg(
    `[doc-processor:rest] commit doc ${docId} | ${chunkList.length} 块 | ${ms}ms | 去重跳过 批内${deduped.skippedWithin} 跨文档${deduped.skippedCross}`,
  )
  return {
    docId,
    title: ctx.doc?.title ?? '',
    chunkCount: chunkList.length,
    totalChars,
    ms,
    skippedWithin: deduped.skippedWithin,
    skippedCross: deduped.skippedCross,
  }
}

/** 入库：把当前切片（含调整）embed + 标注 + 去重后写入 Milvus；已入库的文档返回 409 防重复 */
docProcessorRouter.post('/api/doc-processor/commit', async (req, res, next) => {
  try {
    const docId = String(req.body?.docId ?? '').trim()
    res.json(await commitDocToStore(docId, req.principal.userId))
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message, docId: req.body?.docId })
    next(err)
  }
})

/** 批量入库：多文档依次入库（前端「全部入库」按钮）。单个文档失败不中断整批（如 409 已入库跳过） */
docProcessorRouter.post('/api/doc-processor/commit-batch', async (req, res, next) => {
  try {
    const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds.map((x) => String(x ?? '').trim()).filter(Boolean) : []
    if (docIds.length === 0) return res.status(400).json({ message: '缺少 docIds（数组）' })
    const results = []
    for (const docId of docIds) {
      try {
        const r = await commitDocToStore(docId, req.principal.userId)
        results.push({ docId, ok: true, ...r })
      } catch (err) {
        results.push({ docId, ok: false, error: err.message || '入库失败', status: err.status || 500 })
      }
    }
    const okCount = results.filter((r) => r.ok).length
    dbg(`[doc-processor:rest] commit-batch ${docIds.length} 个文档 → 成功 ${okCount}`)
    res.json({ total: results.length, okCount, failCount: results.length - okCount, results })
  } catch (err) {
    next(err)
  }
})

/** 导出：当前切片（含调整）拼接为 Markdown，前端生成文件供下载 */
docProcessorRouter.post('/api/doc-processor/export', async (req, res, next) => {
  try {
    const docId = String(req.body?.docId ?? '').trim()
    const ctx = resolveDocContext(docId, req.principal.userId)
    if (ctx.error) return res.status(ctx.error).json({ message: ctx.message })
    let chunks = ctx.cached?.chunks
    if (!chunks) {
      chunks = await previewChunks(ctx.text, { strategy: ctx.cached?.strategy, ...(ctx.cached?.opts || {}) })
      setCachedPreview(docId, { ...ctx.cached, ownerId: req.principal.userId, text: ctx.text, chunks, strategy: ctx.cached?.strategy || 'semantic', opts: ctx.cached?.opts || {} })
    }
    const markdown = exportChunksAsMarkdown(chunks)
    const base = (ctx.doc?.title || '文档').replace(/\.[a-z0-9]+$/i, '')
    dbg(`[doc-processor:rest] export doc ${docId} → ${chunks.length} 块 / ${markdown.length} 字`)
    res.json({ docId, markdown, filename: `${base}_整理.md`, chunkCount: chunks.length })
  } catch (err) {
    next(err)
  }
})

// ---------- 处理模板（设计文档 §9 扩展：模板保存/套用）----------
// 模板 = 常用的 strategy/maxChars/delimiter 参数组合，持久化于 data/doc-processor/templates.json。
// 预览界面可把当前参数存为模板，之后对任意文档一键套用（按模板参数重新切片）。

/** 模板列表 */
docProcessorRouter.get('/api/doc-processor/templates', async (_req, res, next) => {
  try {
    res.json({ templates: await listTemplates() })
  } catch (err) {
    next(err)
  }
})

/** 新建/更新模板（同名覆盖） */
docProcessorRouter.post('/api/doc-processor/templates', async (req, res, next) => {
  try {
    const tpl = await upsertTemplate(req.body ?? {})
    dbg(`[doc-processor:rest] upsert template "${tpl.name}" (strategy=${tpl.strategy})`)
    res.json({ template: tpl })
  } catch (err) {
    if (/模板名/.test(err.message || '')) return res.status(400).json({ message: err.message })
    next(err)
  }
})

/** 删除模板 */
docProcessorRouter.delete('/api/doc-processor/templates/:id', async (req, res, next) => {
  try {
    const removed = await removeTemplate(String(req.params?.id ?? ''))
    if (!removed) return res.status(404).json({ message: '模板不存在' })
    res.json({ removed: true, id: req.params.id })
  } catch (err) {
    next(err)
  }
})

/** 套用模板：按模板参数对文档重新切片（写入预览缓存，返回带评分的新切片） */
docProcessorRouter.post('/api/doc-processor/templates/apply', async (req, res, next) => {
  try {
    const docId = String(req.body?.docId ?? '').trim()
    const templateId = String(req.body?.templateId ?? '').trim()
    const ctx = resolveDocContext(docId, req.principal.userId)
    if (ctx.error) return res.status(ctx.error).json({ message: ctx.message })
    const tpl = (await listTemplates()).find((t) => t.id === templateId)
    if (!tpl) return res.status(404).json({ message: '模板不存在' })
    const opts = tpl.strategy === 'delimiter' ? { delimiter: tpl.delimiter, ...(tpl.maxChars ? { maxChars: tpl.maxChars } : {}) } : tpl.maxChars ? { maxChars: tpl.maxChars } : {}
    const chunks = await previewChunks(ctx.text, { strategy: tpl.strategy, ...opts })
    setCachedPreview(docId, { ownerId: req.principal.userId, text: ctx.text, chunks, strategy: tpl.strategy, opts })
    const scored = await attachChunkScoresAsync(chunks)
    const totalChars = chunks.reduce((s, c) => s + (c.chars || 0), 0)
    dbg(`[doc-processor:rest] apply template "${tpl.name}" → doc ${docId} → ${chunks.length} 块 | ${scored.scoreMode}`)
    res.json({
      docId,
      template: tpl,
      chunks: scored.chunks,
      totalChunks: chunks.length,
      totalChars,
      avgScore: scored.avgScore,
      scoreMode: scored.scoreMode,
    })
  } catch (err) {
    next(err)
  }
})

/** 批量套用模板（「统一策略处理」）：把同一模板参数套用到多份文档，逐份重切并写入预览缓存。单个文档失败不中断整批。 */
docProcessorRouter.post('/api/doc-processor/templates/apply-batch', async (req, res, next) => {
  try {
    const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds.map((x) => String(x ?? '').trim()).filter(Boolean) : []
    const templateId = String(req.body?.templateId ?? '').trim()
    if (docIds.length === 0) return res.status(400).json({ message: '缺少 docIds（数组）' })
    const tpl = (await listTemplates()).find((t) => t.id === templateId)
    if (!tpl) return res.status(404).json({ message: '模板不存在' })
    const opts = tpl.strategy === 'delimiter' ? { delimiter: tpl.delimiter, ...(tpl.maxChars ? { maxChars: tpl.maxChars } : {}) } : tpl.maxChars ? { maxChars: tpl.maxChars } : {}
    const results = []
    for (const docId of docIds) {
      try {
        const ctx = resolveDocContext(docId, req.principal.userId)
        if (ctx.error) {
          results.push({ docId, ok: false, error: ctx.message, status: ctx.error })
          continue
        }
        const chunks = await previewChunks(ctx.text, { strategy: tpl.strategy, ...opts })
        setCachedPreview(docId, { ownerId: req.principal.userId, text: ctx.text, chunks, strategy: tpl.strategy, opts })
        const scored = await attachChunkScoresAsync(chunks)
        results.push({
          docId,
          ok: true,
          totalChunks: chunks.length,
          totalChars: chunks.reduce((s, c) => s + (c.chars || 0), 0),
          avgScore: scored.avgScore,
        })
      } catch (err) {
        results.push({ docId, ok: false, error: err.message || '套用失败' })
      }
    }
    const okCount = results.filter((r) => r.ok).length
    dbg(`[doc-processor:rest] apply-batch template "${tpl.name}" → ${docIds.length} 个文档，成功 ${okCount}`)
    res.json({ template: tpl, total: results.length, okCount, failCount: results.length - okCount, results })
  } catch (err) {
    next(err)
  }
})
