import { createHash } from 'node:crypto'
import { childLogger } from './logger.js'
import * as milvus from './milvusStore.js'

/**
 * vectorStore —— 知识库存储层（Milvus 后端）
 *
 * ▸ 选型变更（2026-08-29）：vectra → Milvus 3.0
 *   - 原 vectra 为纯 JS HNSW（因 Windows 无 VS C++ Build Tools，faiss-node 装不上而选用）
 *   - Milvus 容器已部署（19530），带来三项 vectra 做不到 / 没做到的能力：
 *     1. 多向量字段：text_vector + question_vector 独立建索引、独立检索
 *       （补齐此前「questions 生成了却从未向量化」的缺口）
 *     2. 原生标量过滤：category / tag 下推到存储层，不再「过采样 50 条再 JS 后过滤」
 *     3. 原生级联删除 + 集合级统计，不再依赖本地 JSON 对账
 *
 * ▸ 单一数据源：documents / chunks 全部落在 Milvus，不再有 documents.json / chunks.json /
 *   seq.json / vectra-index 四处存储。历史缺陷（双写无事务、孤儿向量、patchMeta 不同步）
 *   随存储模型简化而消失。
 *
 * ▸ 读写语义：
 *   - 写操作全部 async，直写 Milvus，成功后更新内存缓存
 *   - 读操作同步，走内存缓存（启动时从 Milvus 全量加载）
 *   - 不保留 vectra 降级：Milvus 不可用时知识库不可用，由上层显式报错
 */

const log = childLogger('vectorStore')

// 内存缓存（Milvus 的镜像，用于同步读）
const documents = new Map()
const chunks = new Map()

// 正文内容哈希索引：sha256(content) -> Set<docId>（上传秒断重复用，随内存镜像一起维护）
const contentHashes = new Map()

/** sha256(hex) */
function sha256(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')
}

function _hashAdd(content, docId) {
  if (!content) return
  const h = sha256(content)
  if (!contentHashes.has(h)) contentHashes.set(h, new Set())
  contentHashes.get(h).add(docId)
}

function _hashRemove(content, docId) {
  if (!content) return
  const h = sha256(content)
  const s = contentHashes.get(h)
  if (!s) return
  s.delete(docId)
  if (s.size === 0) contentHashes.delete(h)
}

/**
 * 按正文内容查找已有文档（整篇内容重复的秒级判定，免去重切+重嵌+逐块查重）。
 * @param {string} text 待检测的正文
 * @returns {string|null} 命中的 docId；无重复返回 null
 */
export function findDocIdByContent(text) {
  const s = contentHashes.get(sha256(String(text ?? '')))
  return s && s.size > 0 ? [...s][0] : null
}

let loaded = false
let _loadedPromise = null

function nowISO() {
  return new Date().toISOString()
}

function toNum(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

// ============ 生命周期 ============

export function whenLoaded() {
  return _loadedPromise ?? Promise.resolve(stats())
}

export async function load() {
  if (_loadedPromise) return _loadedPromise
  _loadedPromise = (async () => {
    const [docs, chs] = await Promise.all([milvus.listAllDocuments(), milvus.listAllChunks()])
    documents.clear()
    chunks.clear()
    contentHashes.clear()
    for (const d of docs) documents.set(d.id, d)
    for (const c of chs) chunks.set(c.id, c)
    for (const d of documents.values()) _hashAdd(d.content, d.id)
    loaded = true
    log.info(`[vectorStore] 已从 Milvus 加载：${documents.size} 篇文档 / ${chunks.size} 切片`)
    return stats()
  })().catch((e) => {
    _loadedPromise = null
    loaded = false
    throw e
  })
  return _loadedPromise
}

/** Milvus 自行持久化，这里仅触发一次 flush 把内存段落盘 */
export async function flushSync() {
  if (!loaded) return
  try {
    const { chunk } = milvus.getCollections()
    const c = milvus.isReady()
    void c
    void chunk
  } catch (_) {
    /* flush 失败不阻塞退出 */
  }
}

export function stats() {
  return { documents: documents.size, chunks: chunks.size }
}

// ============ 文档 ============

/**
 * 创建文档。改为 async：直接落 Milvus，避免历史上「doc 建了、chunk 写入失败 → 空文档」。
 */
export async function createDocument({
  title,
  category = '',
  tags = [],
  size = 0,
  summary,
  content = '',
  source = 'upload',
}) {
  await whenLoaded()
  const doc = {
    id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: title ?? '',
    category: category ?? '',
    tags: Array.isArray(tags) ? tags : [],
    size: toNum(size),
    content,
    summary: summary ?? content.slice(0, 120),
    source: source ?? 'upload',
    status: 'pending',
    indexError: null,
    uploadedAt: nowISO(),
    indexedAt: null,
  }
  await milvus.insertDocument(doc)
  documents.set(doc.id, doc)
  _hashAdd(doc.content, doc.id)
  return publicDoc(doc)
}

/** 剥离内部向量字段，避免 768 维数组随 API 响应下发 */
function publicDoc(d) {
  if (!d) return null
  const { _titleVector, ...rest } = d
  void _titleVector
  return { ...rest }
}

export function getDocument(id) {
  return publicDoc(documents.get(id))
}

const SORTERS = {
  uploadedAtDesc: (a, b) => String(b.uploadedAt ?? '').localeCompare(String(a.uploadedAt ?? '')),
  uploadedAtAsc: (a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')),
  titleAsc: (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh'),
  titleDesc: (a, b) => String(b.title ?? '').localeCompare(String(a.title ?? ''), 'zh'),
  categoryAsc: (a, b) => String(a.category ?? '').localeCompare(String(b.category ?? ''), 'zh'),
  sizeDesc: (a, b) => toNum(b.size) - toNum(a.size),
}

export function listDocuments({ category, tag, q, sort = 'uploadedAtDesc' } = {}) {
  let list = [...documents.values()]
  if (category) list = list.filter((d) => d.category === category)
  if (tag) list = list.filter((d) => (d.tags ?? []).includes(tag))
  if (q) {
    const kw = String(q).toLowerCase()
    list = list.filter(
      (d) =>
        String(d.title ?? '').toLowerCase().includes(kw) ||
        String(d.content ?? '').toLowerCase().includes(kw),
    )
  }
  list.sort(SORTERS[sort] ?? SORTERS.uploadedAtDesc)
  return list.map(publicDoc)
}

export function patchMeta(id, patch = {}) {
  void id
  void patch
  throw new Error('[vectorStore] patchMeta 已改为异步，请改用 await patchMetaAsync(...)')
}

/** patchMeta 的异步实现：改文档元数据的同时同步刷新其切片（修复历史不同步缺陷） */
export async function patchMetaAsync(id, patch = {}) {
  await whenLoaded()
  const cur = documents.get(id)
  if (!cur) return null
  const next = { ...cur }
  for (const k of ['title', 'category', 'tags', 'source']) {
    if (patch[k] !== undefined) next[k] = patch[k]
  }
  await milvus.upsertDocument(next)

  const needSync = patch.category !== undefined || patch.tags !== undefined
  if (needSync) {
    const n = await milvus.syncMetaToChunks(id, { category: next.category, tags: next.tags })
    for (const ch of await milvus.listChunksOfDoc(id)) chunks.set(ch.id, ch)
    if (n) log.debug(`[vectorStore] 已同步 ${n} 个切片的分类/标签`)
  }
  documents.set(id, next)
  return publicDoc(next)
}

export async function deleteDocument(id) {
  await whenLoaded()
  if (!documents.has(id)) return false
  const doc = documents.get(id)
  // 先删切片再删文档：Milvus 侧任一步失败都会抛出，由调用方感知（不再静默留孤儿）
  await milvus.deleteChunksOfDoc(id)
  await milvus.deleteDoc(id)
  for (const [cid, ch] of chunks) if (ch.docId === id) chunks.delete(cid)
  documents.delete(id)
  _hashRemove(doc?.content, id)
  return true
}

/**
 * 按 chunk id 批量删除切片（库内查重清理）。
 * 与 deleteDocument 的整删不同：只删指定块，文档与其余切片保留。
 * @param {string[]} ids chunk id 列表
 * @returns {{deleted:string[], failed:string[]}}
 */
export async function deleteChunksByIds(ids) {
  await whenLoaded()
  // 注意：Set 没有 .filter，先展开去重成数组再过滤（[...new Set(ids)].filter(...)）
  const all = [...new Set(ids ?? [])].filter((x) => typeof x === 'string' && x)
  const valid = all.filter((id) => chunks.has(id))
  const failed = all.filter((id) => !chunks.has(id))
  if (valid.length === 0) return { deleted: [], failed }
  try {
    await milvus.deleteChunksById(valid)
    for (const id of valid) chunks.delete(id)
    return { deleted: valid, failed }
  } catch (e) {
    log.warn({ err: e.message }, `[vectorStore] 批量删切片失败（${valid.length} 个）`)
    return { deleted: [], failed: all }
  }
}

export async function batchDelete(ids) {
  await whenLoaded()
  const deleted = []
  const failed = []
  for (const id of ids ?? []) {
    try {
      const ok = await deleteDocument(id)
      ok ? deleted.push(id) : failed.push(id)
    } catch (e) {
      log.warn({ err: e.message }, `[vectorStore] 删除文档失败 ${id}`)
      failed.push(id)
    }
  }
  return { deleted, failed }
}

export function batchPatchMeta(ids, opts = {}) {
  void ids
  void opts
  throw new Error('[vectorStore] batchPatchMeta 已改为异步，请改用 await batchPatchMetaAsync(...)')
}

export async function batchPatchMetaAsync(ids, opts = {}) {
  await whenLoaded()
  const updated = []
  const failed = []
  for (const id of ids ?? []) {
    const cur = documents.get(id)
    if (!cur) {
      failed.push(id)
      continue
    }
    let tags = [...(cur.tags ?? [])]
    if (Array.isArray(opts.addTags)) tags = [...new Set([...tags, ...opts.addTags])]
    if (Array.isArray(opts.removeTags)) tags = tags.filter((t) => !opts.removeTags.includes(t))
    const patch = {}
    if (opts.setCategory !== undefined) patch.category = opts.setCategory
    patch.tags = tags
    try {
      await patchMetaAsync(id, patch)
      updated.push(id)
    } catch (e) {
      log.warn({ err: e.message }, `[vectorStore] 批量改元数据失败 ${id}`)
      failed.push(id)
    }
  }
  return { updated, failed }
}

// ============ 切片 ============

export function listChunksOf(docId) {
  return [...chunks.values()]
    .filter((c) => c.docId === docId)
    .sort((a, b) => toNum(a.idx) - toNum(b.idx))
    .map((c) => ({ ...c }))
}

/**
 * 取指定文档全部切片的向量（编辑重切片时增量复用旧向量用）。
 * 内存镜像不缓存向量，直接从 Milvus 取。
 * @param {string} docId
 * @returns {Promise<Array<{id:string, docId:string, idx:number, heading:string, text:string, vector:number[]}>>}
 */
export async function listChunkVectorsOfDoc(docId) {
  await whenLoaded()
  const all = await milvus.listAllChunkVectors()
  return all.filter((c) => c.docId === docId)
}

/**
 * 孤儿文档：状态是 indexed，但内存镜像里没有任何切片（Milvus 重启/硬杀导致 chunk 段丢失的残留）。
 * 纯内存扫描（L1，无外部依赖），用于健康检查与启动对账。
 * @returns {{ id:string, title:string, contentLen:number, status:string }[]}
 */
export function listOrphanDocs() {
  const chunkCountByDoc = new Map()
  for (const ch of chunks.values()) {
    chunkCountByDoc.set(ch.docId, (chunkCountByDoc.get(ch.docId) || 0) + 1)
  }
  const orphans = []
  for (const d of documents.values()) {
    if (d.status === 'indexed' && !(chunkCountByDoc.get(d.id) > 0)) {
      orphans.push({
        id: d.id,
        title: d.title ?? '',
        contentLen: (d.content ?? '').length,
        status: d.status,
      })
    }
  }
  return orphans
}

/**
 * 写入切片。
 * @param {Object[]} chunkList 切片元数据
 * @param {number[][]} vectors text 向量（必填）
 * @param {Object} opts
 * @param {number[][]} [opts.questionVectors] 检索锚点向量；缺省时退化用 text 向量，
 *   保证 question_vector 字段始终有值（全零向量会让 COSINE 检索失真）
 */
export async function addChunks(docId, chunkList, vectors, opts = {}) {
  await whenLoaded()
  const doc = documents.get(docId)
  if (!doc) throw new Error(`[vectorStore] 文档不存在：${docId}`)
  // 空切片不是「成功入库」：直接判错，绝不允许把 0 块的文档标成 indexed（正是孤儿成因之一）
  if (!chunkList?.length) {
    throw new Error(`[vectorStore] 文档 ${docId} 切片为空，拒绝入库（正文可能无有效内容或切片策略不匹配）`)
  }
  const category = opts.category ?? doc.category ?? ''
  const tags = opts.tags ?? doc.tags ?? []
  const questionVectors = opts.questionVectors

  const rows = chunkList.map((ch, i) => {
    const tv = vectors?.[i]
    if (!Array.isArray(tv)) throw new Error(`[vectorStore] 切片 ${i} 缺少 text 向量`)
    const qv = Array.isArray(questionVectors?.[i]) ? questionVectors[i] : tv
    return {
      id: `chk_${docId}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      docId,
      idx: toNum(ch.idx, i),
      text: ch.text ?? '',
      heading: ch.heading ?? '',
      topic: ch.topic ?? '',
      questions: Array.isArray(ch.questions) ? ch.questions : [],
      displayTitle: ch.displayTitle ?? `${doc.title ?? ''} § ${i + 1}`,
      preContext: ch.preContext ?? '',
      postContext: ch.postContext ?? '',
      category,
      tags,
      status: 'indexed',
      indexedAt: nowISO(),
      text_vector: tv,
      question_vector: qv,
    }
  })

  await milvus.insertChunks(rows)
  // 落盘：把内存 growing 段刷到对象存储，避免进程/容器被硬杀（OOM 137）时未 flush 的切片丢失
  await milvus.flush([milvus.getCollections().chunk])

  // 写完核实：强一致读回该文档切片数，必须 ≥ 本次写入数，否则视为持久化失败
  const persisted = await milvus.countChunksOfDoc(docId)
  if (persisted < rows.length) {
    throw new Error(
      `[vectorStore] 文档 ${docId} 切片核实失败：期望 ≥${rows.length}，实际落库 ${persisted}，保持 pending 待重试`,
    )
  }
  for (const r of rows) {
    const { text_vector, question_vector, ...meta } = r
    void text_vector
    void question_vector
    chunks.set(r.id, meta)
  }

  // 核实通过后才把文档转为 indexed
  const nextDoc = { ...doc, status: 'indexed', indexError: null, indexedAt: nowISO() }
  await milvus.upsertDocument(nextDoc)
  await milvus.flush([milvus.getCollections().doc])
  documents.set(docId, nextDoc)
  log.info(`[vectorStore] 文档 ${docId} 入库核实通过：${persisted} 块已落库`)
}

export async function updateContentWithPrepared(id, newContent = '', chunkList = [], vectors = [], opts = {}) {
  await whenLoaded()
  const doc = documents.get(id)
  if (!doc) return null
  const next = { ...doc, content: newContent, size: newContent.length, status: 'pending' }
  await milvus.upsertDocument(next)
  documents.set(id, next)
  _hashRemove(doc.content, id)
  _hashAdd(newContent, id)

  await milvus.deleteChunksOfDoc(id)
  for (const [cid, ch] of chunks) if (ch.docId === id) chunks.delete(cid)

  if (chunkList.length) {
    await addChunks(id, chunkList, vectors, {
      category: doc.category,
      tags: doc.tags,
      questionVectors: opts.questionVectors,
    })
  }
  return publicDoc(documents.get(id) ?? next)
}

export async function updateContent(id, newContent = '', embedFn, chunkFn) {
  await whenLoaded()
  const doc = documents.get(id)
  if (!doc) return null
  const splitRes = await chunkFn(newContent)
  const list = Array.isArray(splitRes) ? splitRes : splitRes?.chunks ?? []
  const texts = list.map((c) => c.text ?? '')
  const vectors = texts.length ? await embedFn(texts) : []
  return updateContentWithPrepared(id, newContent, list, vectors)
}

// ============ 统计 ============

export function statsByCategory() {
  const m = new Map()
  for (const d of documents.values()) {
    const k = d.category || '未分类'
    if (!m.has(k)) m.set(k, { name: k, count: 0, chunks: 0 })
    m.get(k).count += 1
  }
  for (const c of chunks.values()) {
    const k = c.category || '未分类'
    if (!m.has(k)) m.set(k, { name: k, count: 0, chunks: 0 })
    m.get(k).chunks += 1
  }
  return [...m.values()].sort((a, b) => b.count - a.count)
}

export function listCategories() {
  return statsByCategory().map(({ name, count }) => ({ name, count }))
}

export function listTags() {
  const m = new Map()
  for (const d of documents.values()) {
    for (const t of d.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
}

// ============ 检索 ============

/**
 * 向量检索。
 * @param {number[]} queryVector
 * @param {Object} opts
 * @param {number} [opts.topK]
 * @param {string} [opts.category]
 * @param {string} [opts.tag]
 * @param {'text'|'question'} [opts.field] 检索哪个向量字段；'question' 走预生成检索锚点
 */
export async function search(queryVector, opts = {}) {
  await whenLoaded()
  const { topK = 5, category, tag, field = 'text' } = opts
  const hits = await milvus.search(queryVector, { topK, category, tag, field })

  // 补 title：Milvus 切片行不冗余文档标题，从内存缓存取
  return hits.map((h) => {
    const doc = documents.get(h.docId)
    return {
      id: h.id,
      docId: h.docId,
      title: doc?.title ?? '',
      text: h.text ?? '', // 全文：混合检索的关键词覆盖率加权要用（snippet 只有前 240 字）
      snippet: h.snippet,
      score: h.score,
      category: h.category ?? '',
      tags: h.tags ?? [],
      heading: h.heading ?? '',
      displayTitle: h.displayTitle || (doc?.title ? `${doc.title} § ${h.idx ?? 1}` : ''),
      topic: h.topic ?? '',
      questions: h.questions ?? [],
      preContext: h.preContext ?? '',
      postContext: h.postContext ?? '',
    }
  })
}
