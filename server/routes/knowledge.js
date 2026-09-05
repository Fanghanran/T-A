import { Router } from 'express'
import { createHash } from 'node:crypto'
import { splitDocumentIntoChunks } from '../lib/chunker.js'
import * as store from '../lib/vectorStore.js'
import { createTtlLruCache } from '../lib/cache.js'
import { streamRagAnswer } from '../lib/llm.js'
import {
  prepareDocChunksAndVectors,
  decodeFilename,
  extractDocumentTextAsync,
  attachChunkScores,
  attachChunkScoresAsync,
} from '../lib/docProcessor.js'
import { scanDuplicateChunks } from '../lib/chunkAudit.js'
import { chunkerConfig } from '../lib/config.js'
import { unifiedSearch } from '../lib/unifiedSearch.js'
import { validateKnowledgeBody, rateLimiters } from '../lib/security.js'
import {
  upload,
  jsonLimits,
  TEXT_EXT,
  UNSUPPORTED_HINT,
  parseTags,
  dbg,
} from './shared.js'

/**
 * routes/knowledge —— 知识库文档管理与检索
 *
 * 端点（均挂 /api/knowledge 前缀语义下，路径按原契约保持绝对写法）：
 *  - POST   /documents             上传文档 → 抽文本 → 切片 → embedding → 入库
 *  - POST   /documents/prepare     两段式上传·第一阶段：抽文本+切片+评分，返回预览（PDF/DOCX 也可预览）
 *  - POST   /documents/commit      两段式上传·第二阶段：确认入库（支持异步 job）
 *  - GET    /documents/jobs/:id    查询异步入库任务进度（stage: chunking→embedding→indexing→done/error）
 *  - POST   /preview-chunks        预览切片（不入库，零副作用）
 *  - GET    /documents             列表（category/tag/q 过滤 + sort + 分页）
 *  - GET    /documents/:id         详情（含正文）
 *  - GET    /documents/:id/chunks  切片列表（含 displayTitle）
 *  - DELETE /documents/:id         删除（同步移除向量）
 *  - PATCH  /documents/:id         编辑（元数据 或 正文重切片重嵌入）
 *  - POST   /documents/batch       批量操作（delete/setCategory/addTags/removeTag）
 *  - GET    /categories, /tags     分类/标签聚合
 *  - POST   /categories/rename     分类重命名（to='' 并入未分类）
 *  - POST   /tags/merge            标签合并（from: string|array → to）
 *  - POST   /duplicates/scan       库内查重扫描（存量切片两两余弦）
 *  - POST   /duplicates/delete     清理选中的重复块
 *  - POST   /documents/manual      手动录入单条知识
 *  - POST   /search                纯语义检索（返回片段 + 相似度）
 *  - POST   /ask                   RAG 流式回答（AI SDK data-stream）
 *  - POST   /api/search/query      统一知识检索（面试题 + 知识库，scope 切换）
 *
 * 依赖：vectorStore（存储）/ docProcessor（切片+标注链路）/ chunker（纯切片）/
 *       unifiedSearch（改写+多query检索）/ llm（RAG 流式回答）。
 */

export const knowledgeRouter = Router()

// ---------- 统一知识检索（面试题 + 知识库向量，scope 切换）----------
knowledgeRouter.post(
  '/api/search/query',
  rateLimiters.search,
  jsonLimits.search,
  validateKnowledgeBody,
  async (req, res, next) => {
    try {
      const { q } = req.body ?? {}
      if (typeof q !== 'string' || !q.trim()) {
        return res.status(400).json({ message: '缺少 q（查询文本）' })
      }
      const t0 = performance.now()
      const result = await unifiedSearch(req.body ?? {})
      const searchMs = Math.round(performance.now() - t0)
      res.json({ searchMs, ...result })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 文档上传 ----------
knowledgeRouter.post(
  '/api/knowledge/documents',
  rateLimiters.upload,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ message: '缺少 file 字段' })

      // 解码文件名，处理 multer 解析中文文件名时的编码问题
      const originalName = decodeFilename(req.file.originalname)

      if (!TEXT_EXT.test(originalName)) {
        return res.status(400).json({
          message: `${originalName} 暂不支持；${UNSUPPORTED_HINT}`,
        })
      }

      // 统一走异步提取：纯文本格式内部仍用 decodeText，PDF/DOCX 走 pdfjs / mammoth
      let extracted
      try {
        extracted = await extractDocumentTextAsync(
          req.file.buffer,
          originalName,
        )
      } catch (e) {
        return res
          .status(400)
          .json({ message: `${originalName} 解析失败：${e.message}` })
      }
      const text = extracted.text
      const category = req.body.category || ''
      const tags = parseTags(req.body.tags)

      // ② 整篇内容哈希秒断重复：同一文件重复上传不再走完整切片+embedding 链路
      const dupId = store.findDocIdByContent(text)
      if (dupId) {
        const existed = store.getDocument(dupId)
        return res.status(409).json({
          message: `内容与已有文档「${existed?.title ?? dupId}」重复，已取消入库`,
          duplicate: true,
          existingId: dupId,
        })
      }
      // 切片策略：默认 semantic；delimiter 模式按用户分隔符切，maxChars 覆盖默认值
      // 注意 delimiter 不 trim：预设策略里有 \n / \n\n 这类纯空白分隔符
      const chunkStrategy =
        req.body.chunkStrategy === 'delimiter' ? 'delimiter' : 'semantic'
      const delimiter =
        chunkStrategy === 'delimiter'
          ? typeof req.body.delimiter === 'string' &&
            req.body.delimiter.length > 0
            ? req.body.delimiter
            : undefined
          : undefined
      const maxChars =
        chunkStrategy === 'delimiter' && req.body.maxChars
          ? Number(req.body.maxChars)
          : undefined
      // 相邻块滑动窗口重叠字符数（0 = 不重叠，默认 0）
      const overlapChars =
        chunkStrategy === 'delimiter' &&
        req.body.overlapChars != null &&
        req.body.overlapChars !== ''
          ? Number(req.body.overlapChars)
          : 0
      if (chunkStrategy === 'delimiter' && !delimiter) {
        return res
          .status(400)
          .json({ message: 'chunkStrategy=delimiter 时 delimiter 必填' })
      }
      if (Number.isFinite(maxChars) && (maxChars < 50 || maxChars > 5000)) {
        return res.status(400).json({ message: 'maxChars 范围 50~5000' })
      }
      if (
        !Number.isInteger(overlapChars) ||
        overlapChars < 0 ||
        overlapChars > 500
      ) {
        return res
          .status(400)
          .json({ message: 'overlapChars 范围 0~500（整数）' })
      }

      // 阶段 1：切片（按策略）→ 句子向量平均 → topic/questions 标注 → 入库（失败全降级，永不抛）
      const { chunkList, vectors } = await prepareDocChunksAndVectors(text, {
        strategy: chunkStrategy,
        delimiter,
        maxChars,
        overlapChars,
      })
      const doc = await store.createDocument({
        title: originalName,
        category,
        tags,
        size: req.file.buffer.length,
        content: text,
      })
      await store.addChunks(doc.id, chunkList, vectors, { category, tags })

      res.status(201).json(doc)
    } catch (err) {
      next(err)
    }
  },
)

// ===================== 两段式上传：prepare → 预览确认 → commit =====================
// 动机：旧的一口气上传无法预览 PDF/DOCX（前端读不了二进制），切得不好只能删了重传。
// prepare 只做抽文本+切片+启发式评分（快、零 LLM/向量开销），正文缓存在进程内；
// commit 才做 embedding+标注+入库（慢），支持异步 job 供前端轮询进度。

/** prepare 缓存：previewId -> { title, text, size, strategy, delimiter, maxChars, createdAt } */
const uploadPreviews = new Map()
/** 异步入库任务：jobId -> { id, title, stage, chunkCount, doc, error, updatedAt } */
const uploadJobs = new Map()
const PREVIEW_TTL_MS = 30 * 60 * 1000 // 预览缓存 30 分钟
const PREVIEW_MAX = 50 // 最多缓存 50 份（防内存滥用）
const JOB_TTL_MS = 10 * 60 * 1000 // 完成任务保留 10 分钟供查询

function _prunePreviews() {
  const now = Date.now()
  for (const [k, v] of uploadPreviews) {
    if (now - v.createdAt > PREVIEW_TTL_MS) uploadPreviews.delete(k)
  }
  while (uploadPreviews.size > PREVIEW_MAX) {
    uploadPreviews.delete(uploadPreviews.keys().next().value)
  }
}

function _pruneJobs() {
  const now = Date.now()
  for (const [k, v] of uploadJobs) {
    if (
      (v.stage === 'done' || v.stage === 'error') &&
      now - v.updatedAt > JOB_TTL_MS
    ) {
      uploadJobs.delete(k)
    }
  }
}

// ---------- 两段式·一：prepare（抽文本+切片+评分，不入库不嵌向量） ----------
knowledgeRouter.post(
  '/api/knowledge/documents/prepare',
  rateLimiters.upload,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ message: '缺少 file 字段' })
      const originalName = decodeFilename(req.file.originalname)
      if (!TEXT_EXT.test(originalName)) {
        return res
          .status(400)
          .json({ message: `${originalName} 暂不支持；${UNSUPPORTED_HINT}` })
      }
      let extracted
      try {
        extracted = await extractDocumentTextAsync(
          req.file.buffer,
          originalName,
        )
      } catch (e) {
        return res
          .status(400)
          .json({ message: `${originalName} 解析失败：${e.message}` })
      }
      const text = extracted.text

      // ② 哈希秒断：prepare 阶段就告知重复，用户不必走到 commit 才发现
      const dupId = store.findDocIdByContent(text)
      if (dupId) {
        const existed = store.getDocument(dupId)
        return res.status(409).json({
          message: `内容与已有文档「${existed?.title ?? dupId}」重复`,
          duplicate: true,
          existingId: dupId,
        })
      }

      // 切片策略参数（与旧上传端点同一套校验口径；delimiter 不 trim，见旧端点注释）
      const chunkStrategy =
        req.body.chunkStrategy === 'delimiter' ? 'delimiter' : 'semantic'
      const delimiter =
        chunkStrategy === 'delimiter' &&
        typeof req.body.delimiter === 'string' &&
        req.body.delimiter.length > 0
          ? req.body.delimiter
          : undefined
      const maxChars =
        chunkStrategy === 'delimiter' && req.body.maxChars
          ? Number(req.body.maxChars)
          : undefined
      // 相邻块滑动窗口重叠字符数（0 = 不重叠，默认 0）
      const overlapChars =
        chunkStrategy === 'delimiter' &&
        req.body.overlapChars != null &&
        req.body.overlapChars !== ''
          ? Number(req.body.overlapChars)
          : 0
      if (chunkStrategy === 'delimiter' && !delimiter) {
        return res
          .status(400)
          .json({ message: 'chunkStrategy=delimiter 时 delimiter 必填' })
      }
      if (Number.isFinite(maxChars) && (maxChars < 50 || maxChars > 5000)) {
        return res.status(400).json({ message: 'maxChars 范围 50~5000' })
      }
      if (
        !Number.isInteger(overlapChars) ||
        overlapChars < 0 ||
        overlapChars > 500
      ) {
        return res
          .status(400)
          .json({ message: 'overlapChars 范围 0~500（整数）' })
      }

      // 只切片 + 启发式评分（同步、零向量开销；commit 时才嵌向量）
      const cfg =
        chunkStrategy === 'delimiter' && Number.isFinite(maxChars)
          ? { maxChars }
          : undefined
      const { chunks } = await splitDocumentIntoChunks(text, {
        strategy: chunkStrategy,
        delimiter,
        overlapChars,
        config: cfg,
      })
      const scored = attachChunkScores(chunks)

      const previewId = `pv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      uploadPreviews.set(previewId, {
        title: originalName,
        text,
        size: req.file.buffer.length,
        strategy: chunkStrategy,
        delimiter,
        maxChars,
        overlapChars,
        createdAt: Date.now(),
      })
      _prunePreviews()

      res.json({
        previewId,
        title: originalName,
        size: req.file.buffer.length,
        chunkCount: chunks.length,
        avgScore: scored.avgScore,
        chunks: scored.chunks.map((c) => ({
          idx: c.idx,
          heading: c.heading,
          text: c.text,
          chars: typeof c.text === 'string' ? c.text.length : 0,
          preContext: c.preContext || '',
          postContext: c.postContext || '',
          score: c.score,
          level: c.level,
          issues: c.issues,
        })),
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 两段式·二：commit（embedding + 标注 + 入库；支持异步 job） ----------
// Body: { previewId, category?, tags?, withQuestions?（默认 false 跳过 LLM 问题生成）, async? }
knowledgeRouter.post(
  '/api/knowledge/documents/commit',
  jsonLimits.batch,
  async (req, res, next) => {
    try {
      const { previewId, category = '', tags, withQuestions } = req.body ?? {}
      if (!previewId || typeof previewId !== 'string') {
        return res
          .status(400)
          .json({ message: '缺少 previewId（先调 /documents/prepare）' })
      }
      const entry = uploadPreviews.get(previewId)
      if (!entry) {
        return res
          .status(410)
          .json({ message: '预览不存在或已过期（30 分钟），请重新上传' })
      }
      uploadPreviews.delete(previewId) // 一次性使用，防重复提交

      // ② commit 前再查一次（多标签页可能同时 commit 同一内容）
      const dupId = store.findDocIdByContent(entry.text)
      if (dupId) {
        const existed = store.getDocument(dupId)
        return res.status(409).json({
          message: `内容与已有文档「${existed?.title ?? dupId}」重复，已取消入库`,
          duplicate: true,
          existingId: dupId,
        })
      }

      const job =
        req.body?.async === true
          ? {
              id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              title: entry.title,
              stage: 'chunking',
              chunkCount: null,
              doc: null,
              error: null,
              updatedAt: Date.now(),
            }
          : null

      const run = async () => {
        job && (job.stage = 'embedding')
        const { chunkList, vectors } = await prepareDocChunksAndVectors(
          entry.text,
          {
            strategy: entry.strategy,
            delimiter: entry.delimiter,
            maxChars: entry.maxChars,
            overlapChars: entry.overlapChars,
            withQuestions: withQuestions === true,
          },
        )
        if (job) {
          job.chunkCount = chunkList.length
          job.stage = 'indexing'
          job.updatedAt = Date.now()
        }
        const parsedTags = parseTags(tags)
        const safeCategory = typeof category === 'string' ? category : ''
        const doc = await store.createDocument({
          title: entry.title,
          category: safeCategory,
          tags: parsedTags,
          size: entry.size,
          content: entry.text,
        })
        await store.addChunks(doc.id, chunkList, vectors, {
          category: safeCategory,
          tags: parsedTags,
        })
        if (job) {
          job.stage = 'done'
          job.doc = doc
          job.updatedAt = Date.now()
        }
        return doc
      }

      if (job) {
        uploadJobs.set(job.id, job)
        _pruneJobs()
        run().catch((e) => {
          job.stage = 'error'
          job.error = e?.message || '入库失败'
          job.updatedAt = Date.now()
        })
        return res.status(202).json({ jobId: job.id })
      }

      const doc = await run()
      res.status(201).json(doc)
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 两段式·三：查异步 job 进度 ----------
knowledgeRouter.get('/api/knowledge/documents/jobs/:id', (req, res) => {
  _pruneJobs()
  const job = uploadJobs.get(req.params.id)
  if (!job) return res.status(404).json({ message: '任务不存在或已完成清理' })
  res.json(job)
})

// ---------- 预览切片（不入库，零副作用；前端上传前实时预览） ----------
knowledgeRouter.post(
  '/api/knowledge/preview-chunks',
  jsonLimits.preview,
  async (req, res, next) => {
    try {
      const {
        text,
        strategy = 'semantic',
        delimiter,
        maxChars,
        overlapChars,
      } = req.body ?? {}
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ message: 'text 必填且必须为字符串' })
      }
      if (
        strategy === 'delimiter' &&
        (typeof delimiter !== 'string' || delimiter.length === 0)
      ) {
        return res
          .status(400)
          .json({ message: 'strategy=delimiter 时 delimiter 必填' })
      }
      // 仅 delimiter 模式支持 maxChars 覆盖；semantic 走 chunkerConfig
      const cfg = { ...chunkerConfig }
      if (strategy === 'delimiter' && maxChars != null && maxChars !== '') {
        const n = Number(maxChars)
        if (!Number.isFinite(n) || n < 50 || n > 5000) {
          return res.status(400).json({ message: 'maxChars 范围 50~5000' })
        }
        cfg.maxChars = n
      }
      let overlap = 0
      if (
        strategy === 'delimiter' &&
        overlapChars != null &&
        overlapChars !== ''
      ) {
        const n = Number(overlapChars)
        if (!Number.isInteger(n) || n < 0 || n > 500) {
          return res
            .status(400)
            .json({ message: 'overlapChars 范围 0~500（整数）' })
        }
        overlap = n
      }
      // 只切片，不 embed 不入库（semantic 模式无 embedSentences 时，超长块走句子数硬切兜底）
      const { chunks } = await splitDocumentIntoChunks(text, {
        strategy,
        delimiter: strategy === 'delimiter' ? delimiter : undefined,
        overlapChars: strategy === 'delimiter' ? overlap : undefined,
        config: strategy === 'delimiter' ? cfg : undefined,
      })
      res.json({
        chunks: chunks.map((c) => ({
          idx: c.idx,
          heading: c.heading,
          text: c.text,
          chars: typeof c.text === 'string' ? c.text.length : 0,
          preContext: c.preContext || '',
          postContext: c.postContext || '',
        })),
        total: chunks.length,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 切片评分缓存（进程内 TTL/LRU，按 docId + 内容签名）----------
// 语义评分需 embed 全部块/句子（2 趟 embedding 往返），对大文档可达数秒；启发式均分也是 O(切片数) 纯 CPU。
// 结果只取决于内容，故缓存并让内容签名变化自然失效。列表页与切片详情共用同一份缓存。
const chunkScoreCache = createTtlLruCache({
  maxEntries: 64,
  ttlMs: 10 * 60 * 1000,
  maxBytes: 8 * 1024 * 1024,
})

function chunkSigKey(docId, rawChunks) {
  const sig = createHash('sha1')
    .update(rawChunks.map((c) => `${c.id}:${(c.text || '').length}`).join('|'))
    .digest('hex')
  return `${docId}::${sig}`
}

/** 列表页每文档的启发式均分：命中缓存则零计算，未命中用同步启发式并回填（不触发 embed）。 */
function listAvgScoreOfDoc(docId) {
  const raw = store.listChunksOf(docId)
  const cacheKey = chunkSigKey(docId, raw)
  const hit = chunkScoreCache.get(cacheKey)
  if (hit?.avgScore !== undefined) return hit.avgScore
  const { avgScore } = attachChunkScores(raw)
  chunkScoreCache.set(cacheKey, { ...(hit || {}), avgScore })
  return avgScore
}

// ---------- 文档列表（支持过滤 + 排序 + 分页）----------
knowledgeRouter.get('/api/knowledge/documents', (req, res) => {
  const { category, tag, q, sort, page = 1, pageSize = 20 } = req.query
  const all = store.listDocuments({
    category,
    tag,
    q,
    sort: typeof sort === 'string' ? sort : 'uploadedAtDesc',
  })
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.max(1, Math.min(100, Number(pageSize) || 20))
  const items = all.slice((p - 1) * ps, p * ps)
  // 每文档附带启发式评分均分（走内容签名缓存，避免每次列表对全部切片重复纯 CPU 计算），供列表质量徽标
  const scoredItems = items.map((d) => ({
    ...d,
    avgScore: listAvgScoreOfDoc(d.id),
  }))
  res.json({ items: scoredItems, total: all.length, page: p, pageSize: ps })
})

// ---------- 文档详情 ----------
knowledgeRouter.get('/api/knowledge/documents/:id', (req, res) => {
  const doc = store.getDocument(req.params.id)
  if (!doc) return res.status(404).json({ message: '文档不存在' })
  res.json(doc)
})

// ---------- 文档索引状态（轻量，不含正文）----------
// chunkCount 为强一致核实计数；orphan = 元数据标记 indexed 但库里 0 片（ADR-004 孤儿场景的单文档检测），
// 前端上传/重建后可轮询本端点精确跟踪单个文档的索引状态，无需整表刷新。
knowledgeRouter.get(
  '/api/knowledge/documents/:id/status',
  async (req, res, next) => {
    try {
      const doc = store.getDocument(req.params.id)
      if (!doc) return res.status(404).json({ message: '文档不存在' })
      const chunkCount = await store.countChunksOfDoc(req.params.id)
      res.json({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        tags: doc.tags,
        status: doc.status,
        indexError: doc.indexError ?? null,
        indexedAt: doc.indexedAt,
        uploadedAt: doc.uploadedAt,
        size: doc.size,
        chunkCount,
        orphan: doc.status === 'indexed' && chunkCount === 0,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 文档切片（含 displayTitle 独立切片标题，兜底拼接；混合评分：启发式 + 语义信号）----------
knowledgeRouter.get(
  '/api/knowledge/documents/:id/chunks',
  async (req, res, next) => {
    try {
      const doc = store.getDocument(req.params.id)
      if (!doc) return res.status(404).json({ message: '文档不存在' })
      const raw = store.listChunksOf(req.params.id)
      const cacheKey = chunkSigKey(req.params.id, raw)
      const cached = chunkScoreCache.get(cacheKey)
      if (cached && Array.isArray(cached.items)) return res.json(cached)

      // 混合评分（external embedding 可用时叠加语义信号，否则自动回退纯启发式）
      const scored = await attachChunkScoresAsync(raw)
      const payload = {
        items: scored.chunks.map((c) => ({
          id: c.id,
          displayTitle: c.displayTitle,
          heading: c.heading,
          text: c.text,
          chars: typeof c.text === 'string' ? c.text.length : 0,
          category: c.category,
          tags: c.tags,
          score: c.score,
          level: c.level,
          issues: c.issues,
        })),
        total: scored.chunks.length,
        avgScore: scored.avgScore,
        scoreMode: scored.scoreMode,
      }
      chunkScoreCache.set(cacheKey, payload)
      res.json(payload)
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 删除文档 ----------
knowledgeRouter.delete('/api/knowledge/documents/:id', async (req, res) => {
  const existed = await store.deleteDocument(req.params.id)
  if (!existed) return res.status(404).json({ message: '文档不存在' })
  res.status(204).end()
})

// ---------- 编辑文档（元数据 / 正文，统一 PATCH）----------
// Body 字段全部选填：{ title?, category?, tags?, source?, content? }
// - 只传 meta 字段 → patchMeta（0 向量计算开销，毫秒级）
// - 传了 content → 走 updateContent 重切片 + 重嵌入向量 + 同步更新 doc.content/size/summary
knowledgeRouter.patch(
  '/api/knowledge/documents/:id',
  jsonLimits.chat,
  async (req, res, next) => {
    try {
      const id = req.params.id
      if (!store.getDocument(id))
        return res.status(404).json({ message: '文档不存在' })
      const body = req.body ?? {}
      const { content, ...metaPatch } = body

      // meta 校验（如果有 meta 字段）
      const meta = {}
      if ('title' in metaPatch) {
        if (
          typeof metaPatch.title !== 'string' ||
          !metaPatch.title.trim() ||
          metaPatch.title.length > 200
        ) {
          return res.status(400).json({ message: 'title 长度 1~200 字符' })
        }
        meta.title = metaPatch.title
      }
      if ('category' in metaPatch) {
        meta.category =
          typeof metaPatch.category === 'string' ? metaPatch.category : ''
      }
      if ('tags' in metaPatch) {
        if (!Array.isArray(metaPatch.tags)) {
          return res.status(400).json({ message: 'tags 必须是字符串数组' })
        }
        if (metaPatch.tags.length > 10) {
          return res.status(400).json({ message: 'tags 最多 10 项' })
        }
        if (
          metaPatch.tags.some((t) => typeof t !== 'string' || t.length > 20)
        ) {
          return res.status(400).json({ message: '每个 tag 长度 ≤ 20 字符' })
        }
        meta.tags = metaPatch.tags
      }
      if ('source' in metaPatch) {
        meta.source =
          typeof metaPatch.source === 'string' ? metaPatch.source : ''
      }

      let doc = null
      // 先改元数据（如果带）
      if (Object.keys(meta).length > 0) {
        doc = await store.patchMetaAsync(id, meta)
        if (!doc) return res.status(500).json({ message: '元数据保存失败' })
      }
      // 再改正文（如果带）— 阶段 1 新链路：预先算好 chunkList+vectors（含 topic/questions/pre/post 上下文）
      if (typeof content === 'string') {
        if (content.trim().length < 10 || content.length > 500_000) {
          return res
            .status(400)
            .json({ message: 'content 长度 10~500,000 字符' })
        }
        // ⑥ 增量复用：正文未变的块沿用旧向量，只重嵌变化的块（改错别字不再全篇重嵌）
        let reuse = null
        try {
          const oldVecs = await store.listChunkVectorsOfDoc(id)
          if (oldVecs.length > 0) {
            reuse = new Map()
            for (const c of oldVecs) {
              if (
                Array.isArray(c.vector) &&
                c.vector.length > 0 &&
                !reuse.has(c.text)
              ) {
                reuse.set(c.text, c.vector)
              }
            }
          }
        } catch {
          reuse = null // 取旧向量失败 → 全量重嵌，不影响正确性
        }
        const { chunkList, vectors, reusedCount } =
          await prepareDocChunksAndVectors(content, { reuse })
        if (reuse && reusedCount > 0) {
          dbg(
            `[PATCH content] 增量复用 ${reusedCount}/${chunkList.length} 块旧向量`,
          )
        }
        doc = await store.updateContentWithPrepared(
          id,
          content,
          chunkList,
          vectors,
        )
        if (!doc) return res.status(500).json({ message: '正文更新失败' })
      }
      // 两者都没带 → 400
      if (doc === null) {
        return res.status(400).json({
          message:
            '未携带任何可更新字段：可选 title / category / tags / source / content',
        })
      }
      res.json(doc)
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 孤儿文档对账 / 重切片入库 ----------
// 孤儿：status=indexed 但切片为 0（多为 Milvus 硬重启/OOM 导致 chunk growing 段未落盘丢失）。
// 正文仍在 doc 行，可幂等重放：用其 content 重新 prepare + addChunks。

/** GET /api/knowledge/orphans —— 列出孤儿文档（只读，供健康/运维查看） */
knowledgeRouter.get('/api/knowledge/orphans', (_req, res) => {
  res.json({
    items: store.listOrphanDocs(),
    total: store.listOrphanDocs().length,
  })
})

/** POST /api/knowledge/documents/:id/reindex —— 用存量正文重切+重嵌，补齐丢失的切片 */
knowledgeRouter.post(
  '/api/knowledge/documents/:id/reindex',
  rateLimiters.upload,
  async (req, res, next) => {
    try {
      const { id } = req.params
      const doc = store.getDocument(id)
      if (!doc) return res.status(404).json({ message: '文档不存在' })
      const content = doc.content ?? ''
      if (content.trim().length < 10) {
        return res
          .status(400)
          .json({ message: '正文过短或为空，无法重新切片（请先删除该文档）' })
      }
      const { chunkList, vectors } = await prepareDocChunksAndVectors(content, {
        withQuestions: chunkerConfig?.questionsPerChunk > 0,
      })
      const updated = await store.updateContentWithPrepared(
        id,
        content,
        chunkList,
        vectors,
      )
      if (!updated) return res.status(500).json({ message: '重新入库失败' })
      dbg(`[reindex] 文档 ${id} 重切片入库完成：${chunkList.length} 块`)
      res.json({
        id,
        title: updated.title,
        chunkCount: chunkList.length,
        status: updated.status,
      })
    } catch (err) {
      next(err)
    }
  },
)

/** POST /api/knowledge/orphans/reconcile —— 批量对账：重放所有孤儿文档（有上限，防雪崩） */
knowledgeRouter.post(
  '/api/knowledge/orphans/reconcile',
  jsonLimits.small,
  async (req, res, next) => {
    try {
      const orphans = store.listOrphanDocs()
      const limit = Number.isFinite(Number(req.body?.limit))
        ? Math.min(Number(req.body.limit), 50)
        : 50
      const results = []
      for (const o of orphans.slice(0, limit)) {
        try {
          const { chunkList, vectors } = await prepareDocChunksAndVectors(
            o.contentLen ? (store.getDocument(o.id)?.content ?? '') : '',
            {
              withQuestions: chunkerConfig?.questionsPerChunk > 0,
            },
          )
          await store.updateContentWithPrepared(
            o.id,
            store.getDocument(o.id)?.content ?? '',
            chunkList,
            vectors,
          )
          results.push({ id: o.id, ok: true, chunkCount: chunkList.length })
        } catch (e) {
          results.push({
            id: o.id,
            ok: false,
            error: e?.message || 'reindex 失败',
          })
        }
      }
      res.json({ scanned: orphans.length, processed: results.length, results })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 批量操作 ----------
// Body: { ids, op: 'delete' | 'setCategory' | 'addTags' | 'removeTag', ... }
knowledgeRouter.post(
  '/api/knowledge/documents/batch',
  jsonLimits.batch,
  async (req, res, next) => {
    try {
      const { ids, op } = req.body ?? {}
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'ids 必填（非空字符串数组）' })
      }
      const safeIds = ids.filter((x) => typeof x === 'string' && x)
      if (safeIds.length === 0) {
        return res.status(400).json({ message: 'ids 至少含 1 个有效 id' })
      }
      switch (op) {
        case 'delete': {
          const result = await store.batchDelete(safeIds)
          return res.json({ op, ...result })
        }
        case 'setCategory': {
          const category =
            typeof req.body.category === 'string'
              ? req.body.category.trim()
              : ''
          const result = await store.batchPatchMetaAsync(safeIds, {
            setCategory: category,
          })
          return res.json({ op, ...result, category })
        }
        case 'addTags': {
          const tags = Array.isArray(req.body.tags) ? req.body.tags : []
          if (tags.length === 0)
            return res.status(400).json({ message: 'tags 必填' })
          if (tags.some((t) => typeof t !== 'string' || t.length > 20)) {
            return res.status(400).json({ message: '每个 tag 长度 ≤ 20 字符' })
          }
          const result = await store.batchPatchMetaAsync(safeIds, {
            addTags: tags,
          })
          return res.json({ op, ...result })
        }
        case 'removeTag': {
          const tags = Array.isArray(req.body.tags) ? req.body.tags : []
          if (tags.length === 0)
            return res.status(400).json({ message: 'tags 必填' })
          const result = await store.batchPatchMetaAsync(safeIds, {
            removeTags: tags,
          })
          return res.json({ op, ...result })
        }
        default:
          return res.status(400).json({
            message: `op 非法，可选：delete / setCategory / addTags / removeTag`,
          })
      }
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 分类 / 标签 ----------
knowledgeRouter.get('/api/knowledge/categories', (_req, res) =>
  res.json(store.listCategories()),
)
knowledgeRouter.get('/api/knowledge/tags', (_req, res) =>
  res.json(store.listTags()),
)

// ---------- 分类治理：重命名（to='' 表示并入「未分类」）----------
knowledgeRouter.post(
  '/api/knowledge/categories/rename',
  jsonLimits.small,
  async (req, res, next) => {
    try {
      const from =
        typeof req.body?.from === 'string' ? req.body.from.trim() : ''
      const to = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
      if (!from)
        return res.status(400).json({ message: 'from 必填（原分类名）' })
      if (to.length > 50)
        return res.status(400).json({ message: 'to 长度 ≤ 50 字符' })
      const affected = store.listDocuments({ category: from }).map((d) => d.id)
      if (affected.length === 0) return res.json({ renamed: 0, affected: [] })
      const r = await store.batchPatchMetaAsync(affected, { setCategory: to })
      res.json({
        renamed: r.updated.length,
        affected: r.updated,
        failed: r.failed,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 标签治理：合并（from: string | string[] → to；from 含 to 自动去重）----------
knowledgeRouter.post(
  '/api/knowledge/tags/merge',
  jsonLimits.small,
  async (req, res, next) => {
    try {
      const fromRaw = req.body?.from
      const from = (Array.isArray(fromRaw) ? fromRaw : [fromRaw])
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean)
      const to = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
      if (from.length === 0)
        return res
          .status(400)
          .json({ message: 'from 必填（待合并标签，字符串或数组）' })
      if (!to)
        return res.status(400).json({ message: 'to 必填（合并后的目标标签）' })
      if (to.length > 20)
        return res.status(400).json({ message: 'to 长度 ≤ 20 字符' })
      const affected = store
        .listDocuments()
        .filter((d) => (d.tags ?? []).some((t) => from.includes(t)))
        .map((d) => d.id)
      if (affected.length === 0) return res.json({ merged: 0, affected: [] })
      // removeTags 先剔除来源标签，addTags 补目标标签（batchPatchMetaAsync 内按序应用）
      const r = await store.batchPatchMetaAsync(affected, {
        removeTags: from,
        addTags: [to],
      })
      res.json({
        merged: r.updated.length,
        from,
        to,
        affected: r.updated,
        failed: r.failed,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 库内查重：扫描存量重复切片对（两两余弦，与入库去重共用阈值）----------
knowledgeRouter.post(
  '/api/knowledge/duplicates/scan',
  jsonLimits.small,
  async (req, res, next) => {
    try {
      const n = Number(req.body?.maxChunks)
      const result = await scanDuplicateChunks({
        maxChunks: Number.isFinite(n) ? Math.max(50, Math.min(2000, n)) : 800,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 库内查重：清理选中的重复块（保留一个，删其余）----------
knowledgeRouter.post(
  '/api/knowledge/duplicates/delete',
  jsonLimits.small,
  async (req, res, next) => {
    try {
      const chunkIds = Array.isArray(req.body?.chunkIds)
        ? req.body.chunkIds
        : []
      if (chunkIds.length === 0)
        return res.status(400).json({ message: '缺少 chunkIds（非空数组）' })
      const r = await store.deleteChunksByIds(chunkIds)
      res.json({ deleted: r.deleted.length, failed: r.failed })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 手动录入单条知识（与上传走同一条切片 + 向量化链路）----------
knowledgeRouter.post(
  '/api/knowledge/documents/manual',
  jsonLimits.manual,
  async (req, res, next) => {
    try {
      const { title, content, category = '', tags, source } = req.body ?? {}
      if (
        typeof title !== 'string' ||
        title.trim().length < 1 ||
        title.length > 200
      ) {
        return res.status(400).json({ message: 'title 必填，长度 1~200 字符' })
      }
      if (
        typeof content !== 'string' ||
        content.trim().length < 10 ||
        content.length > 500_000
      ) {
        return res
          .status(400)
          .json({ message: 'content 必填，长度 10~500,000 字符' })
      }
      const safeTags = Array.isArray(tags)
        ? tags
            .map((t) => String(t ?? '').trim())
            .filter(Boolean)
            .slice(0, 10)
        : []
      if (Array.isArray(tags) && tags.length > 10) {
        return res.status(400).json({ message: 'tags 最多 10 项' })
      }
      if (safeTags.some((t) => t.length > 20)) {
        return res.status(400).json({ message: '每个 tag 长度 ≤ 20 字符' })
      }
      const safeCategory = typeof category === 'string' ? category.trim() : ''
      // 阶段 1：与上传同一条切片+标注链路
      const { chunkList, vectors } = await prepareDocChunksAndVectors(content)
      const doc = await store.createDocument({
        title: title.trim(),
        category: safeCategory,
        tags: safeTags,
        size: Buffer.byteLength(content, 'utf8'),
        content,
        source:
          typeof source === 'string' && source.trim()
            ? source.trim()
            : 'manual',
      })
      await store.addChunks(doc.id, chunkList, vectors, {
        category: safeCategory,
        tags: safeTags,
      })
      res.status(201).json(doc)
    } catch (err) {
      next(err)
    }
  },
)

// ---------- 语义检索（走 unifiedSearch → query 改写 + 多 query 合并 + 支持 history）----------
knowledgeRouter.post(
  '/api/knowledge/search',
  rateLimiters.search,
  validateKnowledgeBody,
  async (req, res, next) => {
    try {
      const { query, category, tag, history } = req.body ?? {}
      if (!query?.trim()) return res.status(400).json({ message: '缺少 query' })
      const u = await unifiedSearch({
        q: query,
        scope: 'knowledge',
        category,
        tag,
        topK: 5,
        history: Array.isArray(history) ? history : [],
      })
      const results = u.knowledgeResults?.items ?? []
      res.json({
        results,
        // 调试/扩展：返回改写信息，前端未来可选消费
        rewritten: u.knowledgeResults?.rewritten ?? false,
        queries: u.knowledgeResults?.queries ?? [],
      })
    } catch (err) {
      next(err)
    }
  },
)

// ---------- RAG 流式回答（data-stream；同上走 unifiedSearch + history 改写）----------
knowledgeRouter.post(
  '/api/knowledge/ask',
  rateLimiters.search,
  validateKnowledgeBody,
  async (req, res, next) => {
    try {
      const { query, category, tag, history } = req.body ?? {}
      if (!query?.trim()) return res.status(400).json({ message: '缺少 query' })
      const t0 = performance.now()
      const u = await unifiedSearch({
        q: query,
        scope: 'knowledge',
        category,
        tag,
        topK: 5,
        history: Array.isArray(history) ? history : [],
      })
      const chunks = u.knowledgeResults?.items ?? []
      const searchMs = Math.round(performance.now() - t0)
      pipeStream(
        res,
        await streamRagAnswer({ query, chunks, searchMs, history }),
      )
    } catch (err) {
      next(err)
    }
  },
)
