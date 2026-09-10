import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node'
import { childLogger } from './logger.js'
import { usersEnabled } from './principal.js'

const log = childLogger('milvusStore')

const ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530'
const DOC_COL = process.env.MILVUS_DOC_COLLECTION || 'kb_documents'
const CHUNK_COL = process.env.MILVUS_CHUNK_COLLECTION || 'kb_chunks'
const MEM_COL = process.env.MILVUS_MEMORY_COLLECTION || 'kb_memory'
const METRIC = 'COSINE'

// VarChar 长度上限（Milvus 硬限制 65535）
const LEN = {
  id: 128,
  owner: 64,
  short: 64,
  title: 512,
  tags: 1024,
  summary: 2048,
  ctx: 8192,
  text: 60000,
}

let client = null
let ready = false
let dim = Number(process.env.EMBED_DIM) || 0
let initPromise = null

export function isReady() {
  return ready
}
export function getDim() {
  return dim
}
export function getCollections() {
  return { doc: DOC_COL, chunk: CHUNK_COL, memory: MEM_COL }
}

function getClient() {
  if (client) return client
  client = new MilvusClient({ address: ADDRESS, logLevel: 'error' })
  return client
}

/** filter 值转义，防止内容里的引号破坏 Milvus 表达式 */
function esc(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function jsonArr(v) {
  return JSON.stringify(Array.isArray(v) ? v : v ? [v] : [])
}
function parseJsonArr(s, fallback = []) {
  if (!s) return fallback
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : fallback
  } catch {
    return fallback
  }
}

// Milvus 强制每个 collection 至少一个向量字段 —— 文档集合用 title_vector 承载，
// 顺带获得「按语义搜文档」能力（当前未启用，预留）。
function docFields(d) {
  return [
    { name: 'doc_id', data_type: DataType.VarChar, max_length: LEN.id, is_primary_key: true },
    { name: 'owner_id', data_type: DataType.VarChar, max_length: LEN.owner },
    { name: 'title_vector', data_type: DataType.FloatVector, dim: d },
    { name: 'title', data_type: DataType.VarChar, max_length: LEN.title },
    { name: 'category', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'tags', data_type: DataType.VarChar, max_length: LEN.tags },
    { name: 'size', data_type: DataType.Int64 },
    { name: 'content', data_type: DataType.VarChar, max_length: LEN.text },
    { name: 'summary', data_type: DataType.VarChar, max_length: LEN.summary },
    { name: 'source', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'status', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'index_error', data_type: DataType.VarChar, max_length: LEN.title },
    { name: 'uploaded_at', data_type: DataType.Int64 },
    { name: 'indexed_at', data_type: DataType.Int64 },
  ]
}

function chunkFields(d) {
  return [
    { name: 'chunk_id', data_type: DataType.VarChar, max_length: LEN.id, is_primary_key: true },
    { name: 'owner_id', data_type: DataType.VarChar, max_length: LEN.owner },
    { name: 'doc_id', data_type: DataType.VarChar, max_length: LEN.id },
    { name: 'idx', data_type: DataType.Int64 },
    { name: 'text', data_type: DataType.VarChar, max_length: LEN.text },
    { name: 'text_vector', data_type: DataType.FloatVector, dim: d },
    { name: 'question_vector', data_type: DataType.FloatVector, dim: d },
    { name: 'heading', data_type: DataType.VarChar, max_length: LEN.title },
    { name: 'topic', data_type: DataType.VarChar, max_length: LEN.title },
    { name: 'questions', data_type: DataType.VarChar, max_length: LEN.ctx },
    { name: 'display_title', data_type: DataType.VarChar, max_length: LEN.title },
    { name: 'pre_context', data_type: DataType.VarChar, max_length: LEN.ctx },
    { name: 'post_context', data_type: DataType.VarChar, max_length: LEN.ctx },
    { name: 'category', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'tags', data_type: DataType.VarChar, max_length: LEN.tags },
    { name: 'status', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'indexed_at', data_type: DataType.Int64 },
  ]
}

/** 记忆集合字段（ADR-007：跨会话事实记忆；scope=global 跨会话共享，session 会话内） */
function memoryFields(d) {
  return [
    { name: 'mem_id', data_type: DataType.VarChar, max_length: LEN.id, is_primary_key: true },
    { name: 'owner_id', data_type: DataType.VarChar, max_length: LEN.owner },
    { name: 'scope', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'session_id', data_type: DataType.VarChar, max_length: LEN.id },
    { name: 'agent_name', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'kind', data_type: DataType.VarChar, max_length: LEN.short },
    { name: 'text', data_type: DataType.VarChar, max_length: LEN.ctx },
    { name: 'content_hash', data_type: DataType.VarChar, max_length: LEN.id },
    { name: 'ts', data_type: DataType.Int64 },
    { name: 'text_vector', data_type: DataType.FloatVector, dim: d },
  ]
}

async function describeFields(name) {
  const desc = await getClient().describeCollection({ collection_name: name })
  return new Set((desc?.schema?.fields ?? []).map((f) => f.name))
}

async function ensureCollection(name, fields, vectorFields, scalarIndexes) {
  const c = getClient()
  const { collection_names = [] } = await c.listCollections()
  // 旧 schema（无 owner_id）的集合：跳过其不存在的标量索引，等待 owner 重建（M5a）
  let existingFields = null
  if (collection_names.includes(name)) {
    existingFields = await describeFields(name)
  } else {
    await c.createCollection({ collection_name: name, fields, enable_dynamic_field: false })
    log.info(`[milvus] 已创建集合 ${name}（dim=${dim}）`)
  }
  for (const f of vectorFields) {
    await c.createIndex({
      collection_name: name,
      field_name: f,
      index_type: 'AUTOINDEX',
      metric_type: METRIC,
    }).catch((e) => {
      if (!/already exist/i.test(e.message)) throw e
    })
  }
  for (const f of scalarIndexes) {
    if (existingFields && !existingFields.has(f)) {
      log.warn(`[milvus] 集合 ${name} 缺少字段 ${f}（旧 schema），跳过其索引；请执行 owner 重建`)
      continue
    }
    await c.createIndex({ collection_name: name, field_name: f, index_type: 'INVERTED' }).catch((e) => {
      if (!/already exist/i.test(e.message)) throw e
    })
  }
  await c.loadCollection({ collection_name: name })
}

/** 探测 embedding 真实维度（避免写死；换模型也不会静默错位） */
export async function probeDim(embedFn) {
  if (dim) return dim
  const vec = await embedFn(['维度探测'])
  const d = vec?.[0]?.length
  if (!d) throw new Error('[milvus] 无法探测 embedding 维度')
  dim = d
  return dim
}

/** 校验既有集合维度与当前 embedding 模型是否一致 */
async function verifyDim(name) {
  const c = getClient()
  const desc = await c.describeCollection({ collection_name: name })
  const f = (desc?.schema?.fields ?? []).find((x) => x.name === 'text_vector')
  const existing = f?.type_params?.find((p) => p.key === 'dim')?.value
  if (existing && Number(existing) !== dim) {
    throw new Error(
      `[milvus] 维度不匹配：集合 ${name} 为 ${existing} 维，当前 embedding 模型为 ${dim} 维。` +
        `换模型需重建集合（备份后 dropCollection 再迁移）。`,
    )
  }
}

export async function init(embedFn) {
  if (initPromise) return initPromise
  initPromise = (async () => {
    await probeDim(embedFn)
    const c = getClient()
    await c.checkHealth()
    const { collection_names = [] } = await c.listCollections()
    if (collection_names.includes(CHUNK_COL)) await verifyDim(CHUNK_COL)
    if (collection_names.includes(MEM_COL)) await verifyDim(MEM_COL)

    await ensureCollection(DOC_COL, docFields(dim), ['title_vector'], ['doc_id', 'owner_id', 'category', 'status'])
    await ensureCollection(
      CHUNK_COL,
      chunkFields(dim),
      ['text_vector', 'question_vector'],
      ['chunk_id', 'owner_id', 'doc_id', 'category', 'status'],
    )
    // 记忆集合（ADR-007）：随知识库同维度初始化，换 embedding 模型同样需要重建
    await ensureCollection(
      MEM_COL,
      memoryFields(dim),
      ['text_vector'],
      ['mem_id', 'owner_id', 'scope', 'session_id', 'content_hash'],
    )
    // M5a（ADR-008）：owner 过滤是越权防线。user-token 模式下旧 schema 不可服务（fail-fast），
    // disabled 模式仅告警（数据仍归属 local，行为与历史一致）。
    const ownerReady = await ownerSchemaStatus()
    if (!ownerReady.ready) {
      const msg = '[milvus] 集合缺少 owner_id 字段（旧 schema），需执行管理端 owner 重建后才能启用用户体系'
      if (usersEnabled()) throw new Error(msg)
      log.warn(msg)
    }
    ready = true
    log.info(`[milvus] 就绪 ${ADDRESS} · ${DOC_COL} + ${CHUNK_COL} + ${MEM_COL} · dim=${dim}`)
    return { dim }
  })().catch((e) => {
    initPromise = null
    ready = false
    throw e
  })
  return initPromise
}

// ============ 文档 ============

export function rowToDoc(r) {
  return {
    id: r.doc_id,
    ownerId: r.owner_id ?? 'local',
    title: r.title ?? '',
    category: r.category ?? '',
    tags: parseJsonArr(r.tags),
    size: Number(r.size ?? 0),
    content: r.content ?? '',
    summary: r.summary ?? '',
    source: r.source ?? 'upload',
    status: r.status ?? 'indexed',
    indexError: r.index_error ?? null,
    uploadedAt: r.uploaded_at ? new Date(Number(r.uploaded_at)).toISOString() : null,
    indexedAt: r.indexed_at ? new Date(Number(r.indexed_at)).toISOString() : null,
    // 内部字段：upsert 时需原样带出，否则会被抹成零向量。对外返回前由 vectorStore 剥离。
    _titleVector: Array.isArray(r.title_vector) ? r.title_vector : undefined,
  }
}

function zeroVec() {
  return new Array(dim).fill(0)
}

function requireOwnerId(ownerId, what) {
  if (!ownerId) throw new Error(`[milvus] ${what} 缺少 ownerId（M5a 越权防护，禁止默认归属）`)
  return ownerId
}

function docToRow(d) {
  return {
    doc_id: d.id,
    owner_id: requireOwnerId(d.ownerId, '文档写入'),
    title_vector: [d.title_vector, d._titleVector].find(
      (v) => Array.isArray(v) && v.length === dim,
    ) ?? zeroVec(),
    title: d.title ?? '',
    category: d.category ?? '',
    tags: jsonArr(d.tags),
    size: Number(d.size ?? 0),
    content: d.content ?? '',
    summary: d.summary ?? '',
    source: d.source ?? 'upload',
    status: d.status ?? 'indexed',
    index_error: d.indexError ?? '',
    uploaded_at: d.uploadedAt ? new Date(d.uploadedAt).getTime() : Date.now(),
    indexed_at: d.indexedAt ? new Date(d.indexedAt).getTime() : 0,
  }
}

export async function insertDocument(doc) {
  await getClient().insert({ collection_name: DOC_COL, data: [docToRow(doc)] })
}

export async function upsertDocument(doc) {
  // doc.ownerId 由调用方（vectorStore）线程化；删除旧行时同 id 可能不存在（首次 upsert）
  const c = getClient()
  await c.delete({ collection_name: DOC_COL, filter: `doc_id == "${esc(doc.id)}" && owner_id == "${esc(doc.ownerId)}"` })
  await insertDocument(doc)
}

export async function patchDocument(docId, patch, ownerId) {
  const c = getClient()
  const own = `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '文档更新'))}"`
  const rows = await c.query({
    collection_name: DOC_COL,
    filter: own,
    output_fields: ['doc_id'],
    limit: 1,
  })
  if (!rows?.data?.length) return null
  const [cur] = await c.query({
    collection_name: DOC_COL,
    filter: own,
    output_fields: ['*'],
    limit: 1,
  }).then((r) => (r?.data ?? []).map(rowToDoc))
  if (!cur) return null
  const next = { ...cur, ...patch, id: docId }
  await upsertDocument(next)
  return next
}

export async function deleteDoc(docId, ownerId) {
  await getClient().delete({
    collection_name: DOC_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '文档删除'))}"`,
  })
}

export async function listAllDocuments() {
  const c = getClient()
  const r = await c.query({
    collection_name: DOC_COL,
    filter: 'doc_id != ""',
    output_fields: ['*'],
    limit: 16384,
  })
  return (r?.data ?? []).map(rowToDoc)
}

// ============ 向量库浏览（管理端只读，Admin 视角跨 owner） ============

/** Milvus 时间戳精度不固定（ns/μs/ms 均有），按位数归一到毫秒再转 ISO */
function tsToIso(v) {
  const n = Number(v ?? 0)
  if (!n) return null
  if (n > 1e17) return new Date(Math.round(n / 1e6)).toISOString()
  if (n > 1e14) return new Date(Math.round(n / 1e3)).toISOString()
  return new Date(n).toISOString()
}

/** 强一致统计集合行数（与 getStats 同口径：Strong 查询主键，未 flush 的写入也可见） */
async function countRowsStrong(name, pk) {
  const r = await getClient().query({
    collection_name: name,
    filter: `${pk} != ""`,
    output_fields: [pk],
    limit: 16384,
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).length
}

/**
 * 向量库存储总览：连接信息 + 三个集合的结构描述。
 * 每个集合含：Strong 口径行数、字段列表（含向量维度）、索引描述、创建时间。
 * 供管理端「向量库浏览」展示集合卡片（只读，不触碰数据）。
 */
export async function describeStoreInfo() {
  const c = getClient()
  const collections = []
  for (const name of [DOC_COL, CHUNK_COL, MEM_COL]) {
    const desc = await c.describeCollection({ collection_name: name })
    const d = desc?.data ?? desc ?? {}
    // 字段结构：data_type 为字符串名（如 VarChar），type_params 携带 max_length/dim
    const fields = (d.schema?.fields ?? []).map((f) => {
      const params = {}
      for (const p of f.type_params ?? []) params[p.key] = p.value
      return {
        name: f.name,
        type: f.data_type ?? '',
        isVector: f.data_type === 'FloatVector',
        isPrimaryKey: !!f.is_primary_key,
        dim: params.dim ? Number(params.dim) : null,
        maxLength: params.max_length ? Number(params.max_length) : null,
      }
    })
    // 索引描述：params 为 [{key,value}] 数组，取 index_type / metric_type
    let indexes = []
    try {
      const idxR = await c.describeIndex({ collection_name: name })
      indexes = (idxR?.index_descriptions ?? []).map((x) => {
        const kv = {}
        for (const p of x.params ?? []) kv[p.key] = p.value
        return {
          field: x.field_name ?? '',
          indexType: kv.index_type ?? '',
          metricType: kv.metric_type ?? '',
          indexedRows: Number(x.indexed_rows ?? 0),
          state: x.state ?? '',
        }
      })
    } catch {
      // 集合无索引时 describeIndex 报错，浏览场景按空索引处理
    }
    collections.push({
      name,
      rowCount: await countRowsStrong(name, name === DOC_COL ? 'doc_id' : name === CHUNK_COL ? 'chunk_id' : 'mem_id'),
      fields,
      indexes,
      createdTime: tsToIso(d.created_utc_timestamp),
    })
  }
  return {
    address: ADDRESS,
    ready,
    dim,
    metric: METRIC,
    collections,
  }
}

/**
 * 轻量文档行（不含 content / title_vector 大字段），管理端浏览列表用。
 */
export async function listDocRowsLite() {
  const r = await getClient().query({
    collection_name: DOC_COL,
    filter: 'doc_id != ""',
    output_fields: [
      'doc_id', 'owner_id', 'title', 'category', 'tags',
      'size', 'source', 'status', 'uploaded_at', 'indexed_at',
    ],
    limit: 16384,
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).map((row) => ({
    id: row.doc_id,
    ownerId: row.owner_id ?? 'local',
    title: row.title ?? '',
    category: row.category ?? '',
    tags: parseJsonArr(row.tags),
    size: Number(row.size ?? 0),
    source: row.source ?? 'upload',
    status: row.status ?? 'indexed',
    uploadedAt: row.uploaded_at ? new Date(Number(row.uploaded_at)).toISOString() : null,
    indexedAt: row.indexed_at ? new Date(Number(row.indexed_at)).toISOString() : null,
  }))
}

/** 全量切片按 doc_id 计数聚合（浏览列表展示每篇文档的切片数） */
export async function countChunksByDoc() {
  const r = await getClient().query({
    collection_name: CHUNK_COL,
    filter: 'chunk_id != ""',
    output_fields: ['doc_id'],
    limit: 16384,
    consistency_level: 'Strong',
  })
  const map = new Map()
  for (const row of r?.data ?? []) {
    const k = row.doc_id ?? ''
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return map
}

/** 向量预览：维度 / 范数 / 是否零向量 / 前 8 维值（4 位小数），避免全量向量出网 */
function vectorPreview(v) {
  const arr = Array.isArray(v) ? v : []
  let sumSq = 0
  let allZero = true
  for (const x of arr) {
    sumSq += x * x
    if (x !== 0) allZero = false
  }
  return {
    dim: arr.length,
    norm: Math.round(Math.sqrt(sumSq) * 1e4) / 1e4,
    isZero: allZero,
    preview: arr.slice(0, 8).map((x) => Math.round(x * 1e4) / 1e4),
  }
}

/**
 * 指定文档的全部切片（Admin 视角，跨 owner），携带双向量预览。
 * 向量只出预览（dim/范数/前 8 维），全量 1024 维值不出网，payload 可控。
 */
export async function listChunkRowsOfDocWithVectors(docId) {
  const LIMIT = 500
  const r = await getClient().query({
    collection_name: CHUNK_COL,
    filter: `doc_id == "${esc(docId)}"`,
    output_fields: [
      'chunk_id', 'owner_id', 'doc_id', 'idx', 'text',
      'text_vector', 'question_vector',
      'heading', 'topic', 'questions', 'display_title',
      'category', 'tags', 'status', 'indexed_at',
    ],
    limit: LIMIT,
    consistency_level: 'Strong',
  })
  const items = (r?.data ?? []).map((row) => ({
    id: row.chunk_id,
    ownerId: row.owner_id ?? 'local',
    idx: Number(row.idx ?? 0),
    text: row.text ?? '',
    heading: row.heading ?? '',
    topic: row.topic ?? '',
    questions: parseJsonArr(row.questions),
    displayTitle: row.display_title ?? '',
    category: row.category ?? '',
    tags: parseJsonArr(row.tags),
    status: row.status ?? 'indexed',
    indexedAt: row.indexed_at ? new Date(Number(row.indexed_at)).toISOString() : null,
    textVector: vectorPreview(row.text_vector),
    questionVector: vectorPreview(row.question_vector),
  }))
  items.sort((a, b) => a.idx - b.idx)
  return { items, truncated: items.length >= LIMIT }
}

/**
 * 知识网络图：切片 kNN 相似网络构图（Admin 跨 owner 视角，只读）。
 *
 * 节点 = 知识切片（按文档着色），边 = text_vector 余弦相似度。
 * 采用 Milvus 向量索引批量 kNN 检索（AUTOINDEX/HNSW，O(n·log n)）替代
 * JS 全对计算（O(n²·d)，万级切片不可行）：每条切片以自身向量查
 * top(K+1) 近邻，过滤自身与低于 threshold 的命中，无向去重。
 * 语义与「全对 + 每节点 topK」等价：全局 topK+1 近邻中 ≥ threshold
 * 的子集 = 该节点 threshold 之上最强 topK 邻居。
 * 向量仅作为查询输入在服务端内存流转，不出网。
 *  - threshold：边的相似度下限，低于该值的命中不成边
 *  - topK：每个节点保留的最强邻居数（无向去重前），控制图密度上限
 */
export async function buildChunkGraph({ threshold = 0.55, topK = 6 } = {}) {
  const c = getClient()
  // 1. 全量切片（text_vector 仅作批量查询输入）
  const r = await c.query({
    collection_name: CHUNK_COL,
    filter: 'chunk_id != ""',
    output_fields: [
      'chunk_id', 'doc_id', 'idx', 'heading', 'topic', 'text',
      'category', 'status', 'text_vector',
    ],
    limit: 16384,
    consistency_level: 'Strong',
  })
  const rows = r?.data ?? []
  const n = rows.length

  // 2. 文档元信息（节点着色 / 图例 / 检索用标题）
  const docRows = await listDocRowsLite()
  const docIdsWithChunks = new Set(rows.map((row) => row.doc_id ?? ''))
  const docs = docRows
    .filter((d) => docIdsWithChunks.has(d.id))
    .map((d) => ({ id: d.id, title: d.title || d.id, category: d.category }))
  const docTitle = new Map(docs.map((d) => [d.id, d.title]))

  // 3. 批量 kNN 检索近邻（零向量切片不查询，作为孤立节点保留）
  const idxById = new Map(rows.map((row, i) => [row.chunk_id, i]))
  const isZero = rows.map(
    (row) =>
      !Array.isArray(row.text_vector) ||
      row.text_vector.length === 0 ||
      row.text_vector.every((x) => x === 0),
  )
  const queryIdx = []
  for (let i = 0; i < n; i++) {
    if (!isZero[i]) queryIdx.push(i)
  }
  const edgeMap = new Map()
  const BATCH = 256
  for (let s = 0; s < queryIdx.length; s += BATCH) {
    const batch = queryIdx.slice(s, s + BATCH)
    const sr = await c.search({
      collection_name: CHUNK_COL,
      data: batch.map((i) => rows[i].text_vector),
      anns_field: 'text_vector',
      limit: topK + 1,
      consistency_level: 'Strong',
      output_fields: ['chunk_id'],
    })
    // 批量查询：results[queryIndex] 为该查询向量的命中列表
    const results = sr?.results ?? []
    batch.forEach((i, q) => {
      for (const hit of results[q] ?? []) {
        if (hit.chunk_id === rows[i].chunk_id) continue
        const j = idxById.get(hit.chunk_id)
        if (j === undefined) continue
        const sim = Number(hit.score ?? 0)
        if (sim < threshold) continue
        const key = i < j ? `${i}|${j}` : `${j}|${i}`
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            i: Math.min(i, j),
            j: Math.max(i, j),
            sim,
          })
        }
      }
    })
  }

  // 4. 组装输出（节点携带度数，前端按度数映射节点大小）
  const degree = new Array(n).fill(0)
  const edges = [...edgeMap.values()].map(({ i, j, sim }) => {
    degree[i]++
    degree[j]++
    return {
      source: rows[i].chunk_id,
      target: rows[j].chunk_id,
      similarity: Math.round(sim * 1e4) / 1e4,
    }
  })
  const nodes = rows.map((row, i) => ({
    // 节点类型预留：LLM Wiki 词条节点将以 type='wiki' 进入同一数据结构
    type: 'chunk',
    id: row.chunk_id,
    docId: row.doc_id ?? '',
    docTitle: docTitle.get(row.doc_id) ?? row.doc_id ?? '',
    idx: Number(row.idx ?? 0),
    heading: row.heading ?? '',
    topic: row.topic ?? '',
    snippet: (row.text ?? '').slice(0, 120),
    category: row.category ?? '',
    status: row.status ?? 'indexed',
    isZeroVector: isZero[i],
    degree: degree[i],
  }))
  return {
    threshold,
    topK,
    docs,
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  }
}

// ============ 切片 ============

export function rowToChunk(r) {
  return {
    id: r.chunk_id,
    ownerId: r.owner_id ?? 'local',
    docId: r.doc_id,
    idx: Number(r.idx ?? 0),
    text: r.text ?? '',
    heading: r.heading ?? '',
    topic: r.topic ?? '',
    questions: parseJsonArr(r.questions),
    displayTitle: r.display_title ?? '',
    preContext: r.pre_context ?? '',
    postContext: r.post_context ?? '',
    category: r.category ?? '',
    tags: parseJsonArr(r.tags),
    status: r.status ?? 'indexed',
    indexedAt: r.indexed_at ? new Date(Number(r.indexed_at)).toISOString() : null,
  }
}

function chunkToRow(ch) {
  return {
    chunk_id: ch.id,
    owner_id: requireOwnerId(ch.ownerId, '切片写入'),
    doc_id: ch.docId,
    idx: Number(ch.idx ?? 0),
    text: ch.text ?? '',
    text_vector: ch.text_vector,
    question_vector: ch.question_vector,
    heading: ch.heading ?? '',
    topic: ch.topic ?? '',
    questions: jsonArr(ch.questions),
    display_title: ch.displayTitle ?? '',
    pre_context: ch.preContext ?? '',
    post_context: ch.postContext ?? '',
    category: ch.category ?? '',
    tags: jsonArr(ch.tags),
    status: ch.status ?? 'indexed',
    indexed_at: ch.indexedAt ? new Date(ch.indexedAt).getTime() : Date.now(),
  }
}

export async function insertChunks(chunks) {
  if (!chunks?.length) return
  const BATCH = 64
  for (let i = 0; i < chunks.length; i += BATCH) {
    await getClient().insert({
      collection_name: CHUNK_COL,
      data: chunks.slice(i, i + BATCH).map(chunkToRow),
    })
  }
}

/**
 * 强制把内存 growing 段刷到对象存储（MinIO）。
 * 背景：写入进 Milvus 只代表「服务端已接受」，未 flush 的数据在进程/容器被硬杀（OOM 137）时
 * 可能随 growing 段一起丢失（WAL 恢复不一定接回），导致「文档在、切片没了」的孤儿。
 * commit 后主动 flush，把「已接受」升级为「已落盘」。
 */
export async function flush(collections = [DOC_COL, CHUNK_COL, MEM_COL]) {
  await getClient().flush({ collection_names: collections })
}

/**
 * 按 docId 强一致统计切片数（用于写入后核实与孤儿检测）。
 * consistency_level Strong：读取一定包含此前已提交的写入，能真实反映是否落库。
 */
export async function countChunksOfDoc(docId, ownerId) {
  const r = await getClient().query({
    collection_name: CHUNK_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '切片计数'))}"`,
    output_fields: ['chunk_id'],
    limit: 16384,
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).length
}

/** 按文档整体替换切片：先删后插，保证幂等（owner 隔离） */
export async function replaceChunksOfDoc(docId, chunks, ownerId) {
  const c = getClient()
  await c.delete({
    collection_name: CHUNK_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '切片替换'))}"`,
  })
  await insertChunks(chunks)
}

export async function deleteChunksOfDoc(docId, ownerId) {
  await getClient().delete({
    collection_name: CHUNK_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '切片删除'))}"`,
  })
}

export async function deleteChunksById(ids) {
  if (!ids?.length) return
  const c = getClient()
  const BATCH = 100
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH).map((x) => `"${esc(x)}"`).join(',')
    await c.delete({ collection_name: CHUNK_COL, filter: `chunk_id in [${part}]` })
  }
}

export async function listAllChunks() {
  const c = getClient()
  const r = await c.query({
    collection_name: CHUNK_COL,
    filter: 'chunk_id != ""',
    output_fields: [
      'chunk_id', 'owner_id', 'doc_id', 'idx', 'text', 'heading', 'topic', 'questions',
      'display_title', 'pre_context', 'post_context', 'category', 'tags', 'status', 'indexed_at',
    ],
    limit: 16384,
  })
  return (r?.data ?? []).map(rowToChunk)
}

/**
 * 取全量切片（含 text 向量），供库内查重扫描（chunkAudit）做两两余弦比对。
 * 与 listAllChunks 的区别：多取 text_vector 字段，只返回比对所需的最小字段集。
 */
export async function listAllChunkVectors() {
  const c = getClient()
  const r = await c.query({
    collection_name: CHUNK_COL,
    filter: 'chunk_id != ""',
    output_fields: ['chunk_id', 'owner_id', 'doc_id', 'idx', 'text', 'heading', 'text_vector'],
    limit: 16384,
  })
  return (r?.data ?? []).map((row) => ({
    id: row.chunk_id,
    ownerId: row.owner_id ?? 'local',
    docId: row.doc_id,
    idx: Number(row.idx ?? 0),
    text: row.text ?? '',
    heading: row.heading ?? '',
    vector: row.text_vector ?? [],
  }))
}

export async function listChunksOfDoc(docId, ownerId) {
  const c = getClient()
  const r = await c.query({
    collection_name: CHUNK_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '切片列表'))}"`,
    output_fields: [
      'chunk_id', 'doc_id', 'idx', 'text', 'heading', 'topic', 'questions',
      'display_title', 'pre_context', 'post_context', 'category', 'tags', 'status', 'indexed_at',
    ],
    limit: 4096,
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).map(rowToChunk)
}

const CHUNK_ALL_FIELDS = [
  'chunk_id', 'doc_id', 'idx', 'text', 'text_vector', 'question_vector',
  'heading', 'topic', 'questions', 'display_title',
  'pre_context', 'post_context', 'category', 'tags', 'status', 'indexed_at',
]

/**
 * 同步文档元字段到其全部切片。
 * 修复历史缺陷：patchMeta 改 category/tags 时不同步切片，导致「改完分类后按新分类检索不到」。
 * 注意 Milvus 无原地 update —— 必须连同向量一起取回，再整批删插。
 */
export async function syncMetaToChunks(docId, { category, tags }, ownerId) {
  const c = getClient()
  const r = await c.query({
    collection_name: CHUNK_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(requireOwnerId(ownerId, '切片元数据同步'))}"`,
    output_fields: CHUNK_ALL_FIELDS,
    limit: 4096,
    consistency_level: 'Strong',
  })
  const rows = r?.data ?? []
  if (!rows.length) return 0

  const nextRows = rows.map((row) => ({
    ...row,
    category: category ?? row.category,
    tags: tags != null ? jsonArr(tags) : row.tags,
  }))
  await deleteChunksById(nextRows.map((x) => x.chunk_id))
  await insertChunks(
    nextRows.map((row) => ({
      ...rowToChunk(row),
      text_vector: row.text_vector,
      question_vector: row.question_vector,
    })),
  )
  return nextRows.length
}

// ============ 检索 ============

function buildFilter(category, tag, ownerId) {
  // owner 过滤是第一道条件（越权防线），业务过滤叠加其上
  const parts = [`owner_id == "${esc(requireOwnerId(ownerId, '向量检索'))}"`]
  if (category) parts.push(`category == "${esc(category)}"`)
  if (tag) parts.push(`tags like "%${esc(tag)}%"`)
  return parts.join(' && ')
}

/**
 * 向量检索。
 * @param {'text'|'question'} field 检索哪个向量字段
 */
export async function search(vector, { topK = 5, category, tag, field = 'text', ownerId } = {}) {
  const c = getClient()
  const anns_field = field === 'question' ? 'question_vector' : 'text_vector'
  const r = await c.search({
    collection_name: CHUNK_COL,
    data: [vector],
    anns_field,
    limit: Math.max(1, topK),
    // Strong：保证刚写入的切片立即可检索（RAG 场景「上传完马上问」是常态）
    consistency_level: 'Strong',
    filter: buildFilter(category, tag, ownerId),
    output_fields: [
      'chunk_id', 'doc_id', 'idx', 'text', 'heading', 'topic', 'questions',
      'display_title', 'pre_context', 'post_context', 'category', 'tags',
    ],
  })
  const out = []
  for (const hit of r?.results ?? []) {
    const score = Number(hit.score ?? 0)
    out.push({
      id: hit.chunk_id,
      docId: hit.doc_id,
      idx: Number(hit.idx ?? 0),
      text: hit.text ?? '',
      snippet: (hit.text ?? '').slice(0, 240),
      score: Math.max(0, Math.min(1, score)),
      heading: hit.heading ?? '',
      topic: hit.topic ?? '',
      questions: parseJsonArr(hit.questions),
      displayTitle: hit.display_title ?? '',
      preContext: hit.pre_context ?? '',
      postContext: hit.post_context ?? '',
      category: hit.category ?? '',
      tags: parseJsonArr(hit.tags),
    })
  }
  return out
}

/**
 * 集合行数统计。
 *
 * 注意：Milvus 3.0 的 getCollectionStatistics().row_count 在实测中恒为 0
 * （即便 flush 之后仍为 0，而 query 明明能查到数据），不可依赖。
 * 改为强一致 query 只取主键计数。单次上限 16384 条 —— 个人知识库量级远未触及，
 * 若将来超出需改为分页累加。
 */
export async function getStats() {
  const c = getClient()
  const read = async (name, pk) => {
    const r = await c.query({
      collection_name: name,
      filter: `${pk} != ""`,
      output_fields: [pk],
      limit: 16384,
      consistency_level: 'Strong',
    })
    return (r?.data ?? []).length
  }
  const [documents, chunks] = await Promise.all([
    read(DOC_COL, 'doc_id'),
    read(CHUNK_COL, 'chunk_id'),
  ])
  return { documents, chunks }
}

/**
 * 取回全部切片原始行（字段名即 Milvus 列名，可原样回插）。
 * 用于元数据修补：不涉及向量重算时，避免重新 embed。
 */
export async function rawQueryAll(fields) {
  const r = await getClient().query({
    collection_name: CHUNK_COL,
    filter: 'chunk_id != ""',
    output_fields: fields,
    limit: 16384,
    consistency_level: 'Strong',
  })
  return r?.data ?? []
}

/** 整批替换切片（删插），保留行内已有向量 */
export async function rawReplaceAll(rows) {
  if (!rows?.length) return
  const c = getClient()
  const ids = rows.map((r) => r.chunk_id)
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100).map((x) => `"${esc(x)}"`).join(',')
    await c.delete({ collection_name: CHUNK_COL, filter: `chunk_id in [${part}]` })
  }
  const BATCH = 64
  for (let i = 0; i < rows.length; i += BATCH) {
    await c.insert({ collection_name: CHUNK_COL, data: rows.slice(i, i + BATCH) })
  }
}

export async function dropAll() {
  const c = getClient()
  for (const n of [DOC_COL, CHUNK_COL]) {
    await c.dropCollection({ collection_name: n }).catch(() => {})
  }
  ready = false
  initPromise = null
  log.warn(`[milvus] 已删除集合 ${DOC_COL} / ${CHUNK_COL}`)
}

// ============ 会话记忆（ADR-007：长期层事实记忆） ============

/** 记忆对象转 Milvus 行 */
function memToRow(m) {
  return {
    mem_id: m.id,
    owner_id: requireOwnerId(m.ownerId, '记忆写入'),
    scope: m.scope ?? 'global',
    session_id: m.sessionId ?? '',
    agent_name: (m.agentName ?? '').slice(0, LEN.short - 1),
    kind: m.kind ?? 'fact',
    text: (m.text ?? '').slice(0, LEN.ctx - 1),
    content_hash: m.contentHash ?? '',
    ts: m.ts ?? Date.now(),
    text_vector: m.vector,
  }
}

/**
 * 写入记忆事实（batch 64）。调用方负责先做 content_hash 去重与向量化。
 * 写完应由调用方 flush([MEM_COL])，与切片写耐久（ADR-004）同一策略。
 */
export async function insertMemories(items) {
  if (!items?.length) return
  const BATCH = 64
  for (let i = 0; i < items.length; i += BATCH) {
    await getClient().insert({
      collection_name: MEM_COL,
      data: items.slice(i, i + BATCH).map(memToRow),
    })
  }
}

/**
 * 语义检索记忆：召回「跨会话全局事实」+「本会话事实」。
 * @param {number[]} vector 查询向量
 * @param {{topK?: number, sessionId?: string}} opts
 */
export async function searchMemories(vector, { topK = 4, sessionId, ownerId } = {}) {
  const c = getClient()
  // owner 过滤在最外层：记忆事实按用户隔离（ADR-008，global 也是 per-user 语义）
  const scopeFilter = sessionId
    ? `(scope == "global" || session_id == "${esc(sessionId)}")`
    : 'scope == "global"'
  const filter = `owner_id == "${esc(requireOwnerId(ownerId, '记忆检索'))}" && ${scopeFilter}`
  const r = await c.search({
    collection_name: MEM_COL,
    data: [vector],
    anns_field: 'text_vector',
    limit: Math.max(1, topK),
    // Strong：刚提炼写入的记忆立刻可召回
    consistency_level: 'Strong',
    filter,
    output_fields: ['mem_id', 'scope', 'session_id', 'agent_name', 'kind', 'text', 'ts'],
  })
  const out = []
  for (const hit of r?.results ?? []) {
    out.push({
      id: hit.mem_id,
      scope: hit.scope ?? 'global',
      sessionId: hit.session_id ?? '',
      agentName: hit.agent_name ?? '',
      kind: hit.kind ?? 'fact',
      text: hit.text ?? '',
      score: Math.max(0, Math.min(1, Number(hit.score ?? 0))),
      ts: Number(hit.ts ?? 0),
    })
  }
  return out
}

/** 系统级记忆总数（管理端遥测用，无 owner 维度；仅 admin 端点调用） */
export async function countMemoriesAll() {
  const r = await getClient().query({
    collection_name: MEM_COL,
    filter: 'mem_id != ""',
    output_fields: ['mem_id'],
    limit: 16384,
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).length
}

/**
 * 强一致统计记忆条数（按 owner 隔离）。
 * @param {string} [filter] 附加过滤表达式（如 scope == "global"）
 */
export async function countMemories(filter, ownerId) {
  const own = `mem_id != "" && owner_id == "${esc(requireOwnerId(ownerId, '记忆统计'))}"`
  const r = await getClient().query({
    collection_name: MEM_COL,
    filter: filter ? `${own} && (${filter})` : own,
    output_fields: ['mem_id'],
    limit: 16384,
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).length
}

/** 按过滤表达式删除记忆（管理页清空用） */
export async function deleteMemoriesByFilter(filter) {
  await getClient().delete({ collection_name: MEM_COL, filter })
}

/**
 * owner 字段就绪状态（M5a 迁移判定）。ready=false 表示集合仍为旧 schema，
 * 用户体系（user-token）不可启用。
 */
export async function ownerSchemaStatus() {
  const check = async (name) => {
    try {
      return (await describeFields(name)).has('owner_id')
    } catch {
      return false
    }
  }
  const [doc, chunk, mem] = await Promise.all([check(DOC_COL), check(CHUNK_COL), check(MEM_COL)])
  return { doc, chunk, mem, ready: doc && chunk && mem }
}

/**
 * owner 重建（M5a）：备份→drop→按新 schema 重建→原行回插（owner 归 local）→flush→核实。
 * 行内向量原样保留，不重新 embed；仅管理端点调用（管理员已认证）。
 */
export async function ownerRebuild({ dryRun = true } = {}) {
  const status = await ownerSchemaStatus()
  const targets = []
  if (!status.doc) targets.push(DOC_COL)
  if (!status.chunk) targets.push(CHUNK_COL)
  if (!status.mem) targets.push(MEM_COL)
  if (!targets.length) return { needed: false, dryRun: !!dryRun, rebuilt: [] }
  if (dryRun) return { needed: true, dryRun: true, collections: targets }

  const c = getClient()
  const rebuilt = []
  for (const name of targets) {
    const pkFilter =
      name === DOC_COL ? 'doc_id != ""' : name === CHUNK_COL ? 'chunk_id != ""' : 'mem_id != ""'
    const allFields = name === CHUNK_COL ? CHUNK_ALL_FIELDS : ['*']
    const raw = await c.query({
      collection_name: name,
      filter: pkFilter,
      output_fields: allFields,
      limit: 16384,
      consistency_level: 'Strong',
    })
    const rows = (raw?.data ?? []).map((r) => ({ ...r, owner_id: 'local' }))
    await c.dropCollection({ collection_name: name })
    if (name === DOC_COL) {
      await ensureCollection(name, docFields(dim), ['title_vector'], ['doc_id', 'owner_id', 'category', 'status'])
    } else if (name === CHUNK_COL) {
      await ensureCollection(name, chunkFields(dim), ['text_vector', 'question_vector'], ['chunk_id', 'owner_id', 'doc_id', 'category', 'status'])
    } else {
      await ensureCollection(name, memoryFields(dim), ['text_vector'], ['mem_id', 'owner_id', 'scope', 'session_id', 'content_hash'])
    }
    const BATCH = 64
    for (let i = 0; i < rows.length; i += BATCH) {
      await c.insert({ collection_name: name, data: rows.slice(i, i + BATCH) })
    }
    await c.flush({ collection_names: [name] })
    rebuilt.push({ collection: name, rows: rows.length })
    log.warn(`[milvus] owner 重建完成：${name}（${rows.length} 行，owner=local）`)
  }
  return { needed: true, dryRun: false, rebuilt }
}

/** 列出记忆（管理页展示 / 按 content_hash 查重用，强一致） */
export async function listMemories({ limit = 200, filter } = {}) {
  const r = await getClient().query({
    collection_name: MEM_COL,
    filter: filter || 'mem_id != ""',
    output_fields: ['mem_id', 'scope', 'session_id', 'agent_name', 'kind', 'text', 'content_hash', 'ts'],
    limit: Math.min(16384, Math.max(1, limit)),
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).map((row) => ({
    id: row.mem_id,
    scope: row.scope ?? 'global',
    sessionId: row.session_id ?? '',
    agentName: row.agent_name ?? '',
    kind: row.kind ?? 'fact',
    text: row.text ?? '',
    contentHash: row.content_hash ?? '',
    ts: Number(row.ts ?? 0),
  }))
}
