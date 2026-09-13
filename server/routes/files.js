import { Router } from 'express'
import * as anchors from '../lib/anchorStore.js'
import * as files from '../lib/fileStore.js'

/**
 * files —— 文件管理（v3 三级存储的数据面）
 *
 * 依据 docs/向量库重构设计书.md §10.2：文件树 / 切片目录 / 阅读器 / 知识网络四视图同源。
 * 本路由提供前三个视图的数据端点（前端界面另行排期）。
 *
 * 数据按 owner 隔离：普通用户只见自己的文档；admin 角色 = '*' 聚合视图（可见全部，
 * 文件正文/原件读取一律用文档自身 owner 的目录，而非请求者 id）。跨用户一律 404（不泄露存在性）。
 * 分层：L8 路由，依赖 L1 anchorStore（锚点）+ L1 fileStore（持久层）。
 */

const router = Router()

const notFound = (res) => res.status(404).json({ message: '文档不存在' })

/** 读语义 scope：admin 聚合全部，普通用户仅自己 */
function readScope(req) {
  return req.principal?.role === 'admin' ? '*' : req.principal?.userId
}

/** 解析出该 scope 下的文档，取不到即 404（越权与不存在同语义） */
function owned(req, res) {
  const doc = anchors.getDocument(req.params.docId, readScope(req))
  if (!doc) {
    notFound(res)
    return null
  }
  return doc
}

/** GET /api/files —— 文件树（文档列表 + 实存对账） */
router.get('/api/files', (req, res) => {
  const scope = readScope(req)
  const page = Number(req.query?.page) || 1
  const pageSize = Number(req.query?.pageSize) || 50
  const category = typeof req.query?.category === 'string' ? req.query.category : ''
  const { items, total } = anchors.listDocuments(scope, { category, page, pageSize })
  res.json({
    items: items.map((d) => ({
      docId: d.id,
      title: d.title,
      ext: d.ext,
      size: d.size,
      category: d.category,
      tags: d.tags,
      status: d.status,
      chunkCount: anchors.countChunksOfDoc(d.id),
      // 实存对账：锚点层有记录但文件缺失时前端可高亮告警（按文档自身 owner 目录）
      fileExists: files.docDirExists(d.ownerId, d.id),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    total,
    page,
    pageSize,
  })
})

/** GET /api/files/:docId/manifest —— 切片目录（正式产物的库内形态） */
router.get('/api/files/:docId/manifest', (req, res) => {
  const doc = owned(req, res)
  if (!doc) return
  const chunks = anchors.listChunks(doc.id, doc.ownerId).map((c) => ({
    idx: c.idx,
    chunkId: c.chunkId,
    heading: c.heading,
    charCount: c.spanEnd - c.spanStart,
    span: { start: c.spanStart, end: c.spanEnd },
    questions: c.questions,
    topic: c.topic,
    vector: c.vecText
      ? { collection: 'kb_vectors', id: c.vecText, hasQuestion: !!c.vecQuest, model: c.vecModel }
      : null,
  }))
  res.json({
    docId: doc.id,
    title: doc.title,
    ext: doc.ext,
    size: doc.size,
    path: doc.path,
    category: doc.category,
    tags: doc.tags,
    strategy: doc.strategy,
    status: doc.status,
    total: chunks.length,
    chunks,
  })
})

/**
 * GET /api/files/:docId/content —— 正文
 * 不带参数返回全文；带 ?start=&end= 时按锚点返回该区间（阅读器高亮用）
 */
router.get('/api/files/:docId/content', (req, res) => {
  const doc = owned(req, res)
  if (!doc) return
  const hasRange = req.query?.start !== undefined || req.query?.end !== undefined
  try {
    if (hasRange) {
      const start = Number(req.query.start) || 0
      const end = req.query.end === undefined ? undefined : Number(req.query.end)
      return res.json({ docId: doc.id, start, end: end ?? null, text: files.readSpan(doc.ownerId, doc.id, start, end) })
    }
    const text = files.readContent(doc.ownerId, doc.id)
    return res.json({ docId: doc.id, length: text.length, text })
  } catch (err) {
    return res.status(404).json({ message: `正文不可读：${err.message}` })
  }
})

/** GET /api/files/:docId/download —— 原件下载（保真字节） */
router.get('/api/files/:docId/download', (req, res) => {
  const doc = owned(req, res)
  if (!doc) return
  const buf = files.readSource(doc.ownerId, doc.id)
  if (!buf) return notFound(res)
  const found = files.findSource(doc.ownerId, doc.id)
  const name = doc.title || `document.${found?.ext ?? 'bin'}`
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.send(buf)
})

/** GET /api/files/stats —— 知识库用量（文件树头部展示；admin = 全库聚合） */
router.get('/api/files/stats', (req, res) => {
  const scope = readScope(req)
  const s = anchors.statsByOwner(scope)
  res.json({ ownerId: scope, documents: s.documents, chunks: s.chunks, filesRoot: files.rootDir() })
})

export default router
