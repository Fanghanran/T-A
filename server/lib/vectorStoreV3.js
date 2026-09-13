import { childLogger } from './logger.js'
import * as anchors from './anchorStore.js'
import * as files from './fileStore.js'
import * as vindex from './vectorIndexV3.js'
import { invalidateGraphCache } from './graphCache.js'

/**
 * vectorStoreV3 —— 锚点层访问器（L1，v3 三级存储）
 *
 * 与 V2（Milvus 镜像缓存：documents/chunks 两个内存 Map 承载全文与切片文本）的根本差别：
 *   - 元数据 / 切片目录 → **SQLite 锚点层**（anchorStore），不再驻留内存
 *   - 正文              → **本地文件**（fileStore），按 span 锚点切取，数据库不存文本
 *   - 向量              → **瘦集合** kb_vectors（vectorIndexV3），只返回定位三元组
 *
 * 对外 API 与 V2 **完全一致**（字段名、签名、语义），因此调用方（routes / unifiedSearch /
 * docProcessor）无需改动 —— 由 vectorStore.js 按 STORAGE_MODE 选择实现。
 *
 * 设计依据：docs/向量库重构设计书.md（D1–D10）
 */

const log = childLogger('vectorStoreV3')

const nowISO = () => new Date().toISOString()
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const newDocId = () => `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/** 内存策略表（切片策略是纯元数据，无需落库房——与文档绑定，随 doc 走） */
const _strategies = new Map()

function requireOwner(ownerId, action) {
  if (!ownerId) throw new Error(`${action} 需要 ownerId（越权防护）`)
  return ownerId
}

/** 锚点层行 → V2 兼容的 doc 结构（content 从文件读回） */
function toDoc(row, { withContent = true } = {}) {
  if (!row) return null
  let content = ''
  if (withContent) {
    try {
      content = files.readContent(row.ownerId, row.id)
    } catch {
      content = ''
    }
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    category: row.category,
    tags: row.tags,
    size: row.size,
    content,
    summary: content.slice(0, 120),
    source: 'upload',
    status: row.status,
    indexError: row.error ?? null,
    uploadedAt: row.createdAt,
    indexedAt: row.status === 'indexed' ? row.updatedAt : null,
  }
}

/** 锚点层行 + 全文 → V2 兼容的 chunk 结构（text 按 span 取，不落库） */
function toChunk(c, fullText, docMeta) {
  const text = fullText ? fullText.slice(c.spanStart, c.spanEnd) : ''
  return {
    id: c.chunkId,
    docId: c.docId,
    idx: c.idx,
    title: docMeta?.title ?? '',
    text,
    heading: c.heading ?? '',
    topic: c.topic ?? null,
    questions: c.questions ?? [],
    displayTitle: docMeta ? `${docMeta.title} § ${c.idx + 1}` : String(c.idx),
    preContext: '',
    postContext: '',
    category: docMeta?.category ?? '',
    tags: docMeta?.tags ?? [],
    status: docMeta?.status ?? 'indexed',
    indexedAt: c.updatedAt,
    _vectors: null,
  }
}

/** 读全文 + 取切片列表（同文档批量只读一次文件，避免 N 次 IO） */
function chunksWithText(docRow, rows) {
  let full = ''
  try {
    full = files.readContent(docRow.ownerId, docRow.id)
  } catch {
    full = ''
  }
  return rows.map((c) => toChunk(c, full, docRow))
}

/* ============ 生命周期（v3 无需预加载，保持签名兼容） ============ */

let _loaded = false

export function whenLoaded() {
  _loaded = true
  return Promise.resolve()
}

export async function load() {
  _loaded = true
  return stats()
}

export async function flushSync() {
  return true
}

/* ============ 统计 ============ */

export function stats() {
  return anchors.stats()
}

export function statsByOwner(ownerId) {
  requireOwner(ownerId, 'statsByOwner')
  return anchors.statsByOwner(ownerId)
}

/* ============ 文档 ============ */

export async function createDocument({
  title,
  category = '',
  tags = [],
  size = 0,
  summary,
  content = '',
  source = 'upload',
  ownerId,
}) {
  requireOwner(ownerId, 'createDocument')
  const docId = newDocId()
  // 正文落文件（持久层）
  files.writeContent(ownerId, docId, content ?? '')
  // 元数据入库（锚点层）
  const row = anchors.createDocument({
    docId,
    ownerId,
    title: title ?? '',
    ext: guessExt(title),
    size: toNum(size) || String(content ?? '').length,
    path: files.relDocDir(ownerId, docId),
    category: category ?? '',
    tags: Array.isArray(tags) ? tags : [],
    status: 'pending',
  })
  void summary
  void source
  return toDoc({ ...row, createdAt: row.createdAt }, { withContent: false })
}

export function getDocument(id, ownerId) {
  requireOwner(ownerId, 'getDocument')
  const row = anchors.getDocument(id, ownerId)
  // status='deleted' 是「物理删除被环境拒绝」时的标记隐藏态（见 deleteDocument），
  // 对上层一律表现为不存在（404 语义）
  if (!row || row.status === 'deleted') return null
  return toDoc(row)
}

export function listDocuments({
  category,
  tag,
  q,
  sort = 'uploadedAtDesc',
  ownerId,
  page,
  pageSize,
} = {}) {
  requireOwner(ownerId, 'listDocuments')
  const { items } = anchors.listDocuments(ownerId, {
    category: category ?? '',
    page: page ?? 1,
    pageSize: pageSize ?? 500,
  })
  let list = items.map((d) => toDoc(d))
  if (tag) list = list.filter((d) => (d.tags ?? []).includes(tag))
  if (q) {
    const key = String(q).toLowerCase()
    list = list.filter(
      (d) => d.title.toLowerCase().includes(key) || d.content.toLowerCase().includes(key),
    )
  }
  const sorters = {
    uploadedAtDesc: (a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)),
    uploadedAtAsc: (a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)),
    titleAsc: (a, b) => String(a.title).localeCompare(String(b.title), 'zh'),
    titleDesc: (a, b) => String(b.title).localeCompare(String(a.title), 'zh'),
    categoryAsc: (a, b) => String(a.category).localeCompare(String(b.category), 'zh'),
    sizeDesc: (a, b) => toNum(b.size) - toNum(a.size),
  }
  return list.sort(sorters[sort] ?? sorters.uploadedAtDesc)
}

export function setDocStrategy(docId, meta) {
  if (!docId) return
  _strategies.set(docId, meta ?? null)
}

export function getDocStrategy(docId) {
  return _strategies.get(docId) ?? null
}

export function findDocIdByContent(text, ownerId) {
  requireOwner(ownerId, 'findDocIdByContent')
  const key = String(text ?? '')
  if (!key) return null
  for (const d of anchors.listDocuments(ownerId, { pageSize: 1000 }).items) {
    try {
      if (files.readContent(ownerId, d.id) === key) return d.id
    } catch {
      /* 文件缺失跳过 */
    }
  }
  return null
}

export function patchMeta(id, patch = {}) {
  patchMetaAsync(id, patch).catch((err) => log.warn(`patchMeta 失败：${err.message}`))
  return undefined
}

export async function patchMetaAsync(id, patch = {}, ownerId) {
  requireOwner(ownerId, 'patchMetaAsync')
  const cur = anchors.getDocument(id, ownerId)
  if (!cur) return null
  const row = anchors.patchDocument(id, ownerId, {
    title: patch.title ?? cur.title,
    category: patch.category ?? cur.category,
    tags: patch.tags ?? cur.tags,
  })
  return toDoc(row)
}

export async function batchPatchMetaAsync(ids, opts = {}, ownerId) {
  requireOwner(ownerId, 'batchPatchMetaAsync')
  const out = []
  for (const id of ids ?? []) {
    const r = await patchMetaAsync(id, opts, ownerId)
    if (r) out.push(r)
  }
  return out
}

export function batchPatchMeta(ids, opts = {}) {
  batchPatchMetaAsync(ids, opts).catch(() => {})
  return undefined
}

export async function deleteDocument(id, ownerId) {
  requireOwner(ownerId, 'deleteDocument')
  const cur = anchors.getDocument(id, ownerId)
  if (!cur) return false

  /**
   * 统一口径的三段补偿事务（saga）：锚点层 / 索引层 / 持久层 三处要么全删、要么回滚。
   * 排序原则 = 「回滚成本从零到高」：
   *   ① 文件改名进回收站 —— 原子且零成本回滚（rename 回去）
   *   ② 删向量           —— 不可逆，但失败时回收站可直接 rename 回原位
   *   ③ SQLite 事务删锚点 —— 最可靠放最后；失败时回滚文件，向量可由 reindex 重建
   * 任一步失败即中止并回滚，绝不留下「图上有节点、文件已不在」的中间态。
   */

  // ① 持久层：改名进回收站（原子；失败 = 系统零变化，直接中止）
  const trashPath = files.removeDocToTrash(ownerId, id)
  if (trashPath === null) {
    throw new Error(`物理文件删除失败（可能被占用），已中止：锚点与向量未动`)
  }

  // ② 索引层：删除该文档全部向量（可丢弃可重建；失败 → 回滚①）
  try {
    await vindex.deleteVectorsOfDoc(id, ownerId)
  } catch (err) {
    files.restoreFromTrash(trashPath, ownerId, id)
    throw new Error(`向量删除失败，已回滚文件：${err.message}`)
  }

  // ③ 锚点层：SQLite 事务删除（chunks + doc 原子；原逻辑：不做标记删除，避免孤儿切片行）
  try {
    anchors.deleteDocument(id, ownerId)
  } catch (err) {
    files.restoreFromTrash(trashPath, ownerId, id)
    // 向量已删不可恢复，但锚点与文件完整 → reindex 即可重建，数据零丢失
    log.warn(`锚点层删除失败已回滚，向量待 reindex 重建：${err.message}`)
    throw new Error(`锚点层删除失败，文件已回滚；向量可由 reindex 重建：${err.message}`)
  }

  // ④ 全部成功：真删回收站中的物理文件 + 清切片策略缓存
  files.purgeTrash(trashPath)
  _strategies.delete(id)
  invalidateGraphCache()
  return true
}

export async function deleteChunksByIds(ids, ownerId) {
  requireOwner(ownerId, 'deleteChunksByIds')
  let n = 0
  for (const cid of ids ?? []) {
    const hit = findChunkOwner(cid, ownerId)
    if (!hit) continue
    const rows = anchors.listChunks(hit.docId, ownerId).filter((c) => c.chunkId !== cid)
    anchors.replaceChunks(hit.docId, ownerId, rows)
    n++
  }
  if (n) invalidateGraphCache()
  return n
}

export async function batchDelete(ids, ownerId) {
  requireOwner(ownerId, 'batchDelete')
  let n = 0
  for (const id of ids ?? []) if (await deleteDocument(id, ownerId)) n++
  return n
}

/* ============ 切片 ============ */

function findChunkOwner(chunkId, ownerId) {
  for (const d of anchors.listDocuments(ownerId, { pageSize: 1000 }).items) {
    const hit = anchors.listChunks(d.id, ownerId).find((c) => c.chunkId === chunkId)
    if (hit) return hit
  }
  return null
}

export function getChunkById(id, ownerId) {
  requireOwner(ownerId, 'getChunkById')
  const hit = findChunkOwner(id, ownerId)
  if (!hit) return null
  const doc = anchors.getDocument(hit.docId, ownerId)
  return chunksWithText(doc, [hit])[0]
}

export function listChunksOf(docId, ownerId) {
  requireOwner(ownerId, 'listChunksOf')
  const doc = anchors.getDocument(docId, ownerId)
  if (!doc) return []
  return chunksWithText(doc, anchors.listChunks(docId, ownerId))
}

export async function countChunksOfDoc(docId, ownerId) {
  requireOwner(ownerId, 'countChunksOfDoc')
  if (!anchors.getDocument(docId, ownerId)) return 0
  return anchors.countChunksOfDoc(docId)
}

export function listChunkVectorsOfDoc(docId, ownerId) {
  requireOwner(ownerId, 'listChunkVectorsOfDoc')
  if (!anchors.getDocument(docId, ownerId)) return []
  return anchors.listChunks(docId, ownerId).map((c) => ({
    id: c.chunkId,
    idx: c.idx,
    vecModel: c.vecModel,
    hasQuestionVector: !!c.vecQuest,
  }))
}

export function listOrphanDocs() {
  // v3 的孤儿判据：锚点层有行但文件缺失，或文件在而锚点层无行
  const out = []
  for (const d of anchors.listDocuments('local', { pageSize: 1000 }).items) {
    if (!files.docDirExists(d.ownerId, d.id)) out.push({ id: d.id, title: d.title, reason: 'file-missing' })
  }
  return out
}

export async function addChunks(docId, chunkList = [], vectors = [], opts = {}) {
  const ownerId = opts.ownerId
  requireOwner(ownerId, 'addChunks')
  const doc = anchors.getDocument(docId, ownerId)
  if (!doc) throw new Error(`文档不存在或无权访问：${docId}`)

  // 1. 计算 span 锚点：切片文本在正文中的位置（顺序推进，容忍重叠）
  let full = ''
  try {
    full = files.readContent(ownerId, docId)
  } catch {
    full = ''
  }
  let cursor = 0
  const rows = []
  const vecRows = []
  for (let i = 0; i < chunkList.length; i++) {
    const ch = chunkList[i]
    const text = String(ch?.text ?? '')
    let start = full.indexOf(text, Math.max(0, cursor - 200))
    if (start < 0) start = full.indexOf(text)
    if (start < 0) start = cursor // 兜底：定位失败时顺序占位（不阻断入库）
    const end = start + text.length
    cursor = start + 1
    const chunkId = ch?.id ?? `chk_${docId}_${i}`
    rows.push({
      chunkId,
      idx: Number.isInteger(ch?.idx) ? ch.idx : i,
      spanStart: start,
      spanEnd: end,
      heading: ch?.heading ?? '',
      questions: ch?.questions ?? [],
      topic: ch?.topic ?? null,
      vecText: chunkId,
      vecQuest: Array.isArray(opts.questionVectors?.[i]) ? chunkId : null,
      vecModel: opts.vecModel ?? null,
    })
    if (Array.isArray(vectors?.[i]) && vectors[i].length) {
      vecRows.push({
        vec_id: chunkId,
        owner_id: ownerId,
        doc_id: docId,
        idx: Number.isInteger(ch?.idx) ? ch.idx : i,
        text_vector: vectors[i],
        question_vector: Array.isArray(opts.questionVectors?.[i])
          ? opts.questionVectors[i]
          : new Array(vectors[i].length).fill(0),
      })
    }
  }

  // 2. 目录入库（锚点层，含 span 与向量引用）
  anchors.replaceChunks(docId, ownerId, rows)
  // 3. 向量入索引层（可丢弃可重建）
  try {
    if (vecRows.length) {
      await vindex.insertVectors(vecRows)
      // 立即 flush 落盘：growing segment 数据在 Milvus 异常重启时会丢失
      //（2026-09-11 实测教训：未 flush 的 122 条向量随进程退出丢失）
      await vindex.flush()
    }
  } catch (err) {
    log.warn(`向量写入失败（目录已入库，可由 reindex 重建）：${err.message}`)
  }
  // 4. 状态推进（图缓存同步失效：节点/边集已变化，避免 TTL 内返回旧图）
  anchors.setDocumentStatus(docId, ownerId, 'indexed')
  invalidateGraphCache()
  return rows.length
}

export async function updateContentWithPrepared(docId, newContent, chunkList = [], vectors = [], opts = {}) {
  const ownerId = opts.ownerId
  requireOwner(ownerId, 'updateContentWithPrepared')
  const doc = anchors.getDocument(docId, ownerId)
  if (!doc) throw new Error(`文档不存在或无权访问：${docId}`)
  // 正文重写 → 锚点必然失效 → 必须重切（设计书 R1 对策）
  files.writeContent(ownerId, docId, newContent ?? '')
  try {
    await vindex.deleteVectorsOfDoc(docId, ownerId)
  } catch (err) {
    log.warn(`旧向量清理失败：${err.message}`)
  }
  await addChunks(docId, chunkList, vectors, opts)
  return getDocument(docId, ownerId)
}

export async function updateContent(id, newContent = '', embedFn, chunkFn, ownerId) {
  requireOwner(ownerId, 'updateContent')
  const content = String(newContent ?? '')
  const chunkList = typeof chunkFn === 'function' ? await chunkFn(content) : []
  const vectors =
    typeof embedFn === 'function' ? await embedFn(chunkList.map((c) => c.text ?? '')) : []
  return updateContentWithPrepared(id, content, chunkList, vectors, { ownerId })
}

/* ============ 分类 / 标签统计 ============ */

export function statsByCategory(ownerId) {
  requireOwner(ownerId, 'statsByCategory')
  const map = new Map()
  for (const d of anchors.listDocuments(ownerId, { pageSize: 1000 }).items) {
    const key = d.category || ''
    const cur = map.get(key) ?? { name: key, count: 0, chunks: 0 }
    cur.count += 1
    cur.chunks += anchors.countChunksOfDoc(d.id)
    map.set(key, cur)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

export function statsByCategoryAll() {
  return { items: statsByCategory('local'), ...anchors.stats() }
}

export function listCategories(ownerId) {
  return statsByCategory(ownerId).map((c) => c.name).filter(Boolean)
}

export function listTags(ownerId) {
  requireOwner(ownerId, 'listTags')
  const set = new Set()
  for (const d of anchors.listDocuments(ownerId, { pageSize: 1000 }).items) {
    for (const t of d.tags ?? []) set.add(t)
  }
  return [...set]
}

/* ============ 检索 ============ */

/**
 * 向量检索（v3）：瘦集合只给定位三元组，正文由锚点 span 回读。
 * 返回结构与 V2 对齐：{ id, docId, text, score, ... }
 */
export async function search(queryVector, opts = {}) {
  const ownerId = opts.ownerId
  requireOwner(ownerId, 'search')
  const topK = Number(opts.topK) || 10
  const field = opts.field === 'question' ? 'question' : 'text'
  const hits = await vindex.searchVectors(queryVector, {
    ownerId,
    topK,
    field,
    docIds: opts.docIds,
  })

  const out = []
  const contentCache = new Map()
  for (const h of hits) {
    const c = anchors.getChunk(h.docId, h.idx, ownerId)
    if (!c) continue
    if (!contentCache.has(h.docId)) {
      const doc = anchors.getDocument(h.docId, ownerId)
      try {
        contentCache.set(h.docId, files.readContent(ownerId, h.docId))
      } catch {
        contentCache.set(h.docId, '')
      }
      void doc
    }
    const full = contentCache.get(h.docId) ?? ''
    const doc = anchors.getDocument(h.docId, ownerId)
    out.push({
      ...toChunk(c, full, doc),
      score: h.score,
    })
  }
  return out
}

function guessExt(title) {
  const m = String(title ?? '').match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : 'md'
}

/**
 * 知识网络图（v3）：节点 = 锚点层切片目录，边 = kb_vectors 余弦相似度 ≥ threshold。
 * 与 v2 版（milvusStore.buildChunkGraph，读旧集合 kb_chunks）返回结构一致，前端零改动。
 * kNN 用内存精确余弦（向量已归一化，点积即相似度；万级以下规模毫秒级），不依赖 HNSW。
 */
export async function buildChunkGraph({ threshold = 0.55, topK = 6, ownerId = 'local' } = {}) {
  requireOwner(ownerId, 'buildChunkGraph')

  // 1. 节点：锚点层全量切片目录 + 文档元信息
  //    '*'（admin 聚合视图）：跨 owner 收集文档；正文/切片读取按文档自身 owner
  const docLists = ownerId === '*' ? anchors.listOwnerIds().map((o) => anchors.listDocuments(o, { pageSize: 200 }).items) : [anchors.listDocuments(ownerId, { pageSize: 200 }).items]
  const docs = docLists.flat()
  const docTitle = new Map()
  const docCategory = new Map()
  const contentById = new Map()
  const rows = []
  for (const d of docs) {
    docTitle.set(d.id, d.title || d.id)
    docCategory.set(d.id, d.category ?? '')
    let full = ''
    try {
      full = files.readContent(d.ownerId, d.id)
    } catch {
      full = ''
    }
    contentById.set(d.id, full)
    for (const c of anchors.listChunks(d.id, d.ownerId)) {
      rows.push({ c, doc: d })
    }
  }

  // 2. 向量：kb_vectors 全量读取（vec_id = chunkId；'*' 时跨 owner）
  const vecMap = await vindex.listOwnerTextVectors(ownerId)
  const dim = (vecMap.values().next().value ?? []).length
  const norm = new Array(rows.length)
  const isZero = new Array(rows.length).fill(true)
  for (let i = 0; i < rows.length; i++) {
    const v = vecMap.get(rows[i].c.chunkId)
    if (Array.isArray(v) && v.length === dim && v.some((x) => x !== 0)) {
      let s = 0
      for (const x of v) s += x * x
      norm[i] = s > 0 ? Math.sqrt(s) : null
      isZero[i] = false
    }
  }

  // 3. 精确余弦 kNN（无向去重：每节点保留 topK 个 sim≥threshold 的邻居）
  const edgeMap = new Map()
  for (let i = 0; i < rows.length; i++) {
    if (isZero[i]) continue
    const vi = vecMap.get(rows[i].c.chunkId)
    const cand = []
    for (let j = 0; j < rows.length; j++) {
      if (j === i || isZero[j]) continue
      const vj = vecMap.get(rows[j].c.chunkId)
      let dot = 0
      for (let k = 0; k < dim; k++) dot += vi[k] * vj[k]
      const sim = dot / (norm[i] * norm[j])
      if (sim >= threshold) cand.push([j, sim])
    }
    cand.sort((a, b) => b[1] - a[1])
    for (const [j, sim] of cand.slice(0, topK)) {
      const key = i < j ? `${i}|${j}` : `${j}|${i}`
      const prev = edgeMap.get(key)
      if (!prev || sim > prev.sim) edgeMap.set(key, { i: Math.min(i, j), j: Math.max(i, j), sim })
    }
  }

  // 4. 组装（结构与 v2 版一致）
  const degree = new Array(rows.length).fill(0)
  const edges = [...edgeMap.values()].map(({ i, j, sim }) => {
    degree[i]++
    degree[j]++
    return {
      source: rows[i].c.chunkId,
      target: rows[j].c.chunkId,
      similarity: Math.round(sim * 1e4) / 1e4,
    }
  })
  const nodes = rows.map(({ c, doc }, i) => {
    const full = contentById.get(c.docId) ?? ''
    return {
      type: 'chunk',
      id: c.chunkId,
      docId: c.docId,
      docTitle: docTitle.get(c.docId) ?? c.docId,
      idx: Number(c.idx ?? 0),
      heading: c.heading ?? '',
      topic: c.topic ?? '',
      snippet: full.slice(c.spanStart ?? 0, c.spanEnd ?? 0).slice(0, 120),
      category: docCategory.get(c.docId) ?? '',
      status: doc.status ?? 'indexed',
      isZeroVector: isZero[i],
      degree: degree[i],
    }
  })
  return {
    threshold,
    topK,
    docs: docs.map((d) => ({ id: d.id, title: d.title || d.id, category: d.category })),
    nodes,
    edges,
  }
}
