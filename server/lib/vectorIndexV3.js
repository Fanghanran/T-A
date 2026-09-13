import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { childLogger } from './logger.js'

/**
 * vectorIndexV3 —— 索引层访问器（L1，v3 三级存储）
 *
 * 对应 docs/向量库重构设计书.md §4.3 的瘦集合 kb_vectors：
 *   vec_id / owner_id / doc_id / idx / text_vector / question_vector
 *
 * 与 v2 的 `milvusStore.searchChunks` 的关键差别：**只返回定位三元组**
 * (docId, idx, score)，不返回任何正文。取文由上层编排：
 *   命中 → anchorStore.getChunk(docId, idx) → fileStore.readSpan() → 拼 prompt
 *
 * 独立于 milvusStore 存在，便于新老路径并存与灰度切换（不修改既有 740 行大模块）。
 */

const log = childLogger('vectorIndexV3')

const ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530'
export const VEC_COL = process.env.MILVUS_VECTOR_COLLECTION || 'kb_vectors'

let _client = null

function getClient() {
  if (!_client) _client = new MilvusClient({ address: ADDRESS })
  return _client
}

/** Milvus 表达式字符串转义 */
function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function requireOwnerId(ownerId, action) {
  if (!ownerId) throw new Error(`${action}需要 ownerId（越权防护）`)
  return ownerId
}

/**
 * 向量检索。返回**只含定位信息**的命中列表。
 *
 * @param {number[]} vector 查询向量
 * @param {object} opts
 * @param {string} opts.ownerId 必填（强制过滤）
 * @param {number} [opts.topK=20]
 * @param {'text'|'question'} [opts.field='text'] 走切片向量还是问题锚点向量
 * @param {string[]} [opts.docIds] 文档白名单（分类/标签等文档级条件在此下推）
 * @param {number} [opts.ef] HNSW 检索 ef（调大提高召回）
 * @returns {Promise<Array<{vecId:string, docId:string, idx:number, score:number}>>}
 */
export async function searchVectors(vector, { ownerId, topK = 20, field = 'text', docIds, ef } = {}) {
  requireOwnerId(ownerId, '向量检索')
  const annsField = field === 'question' ? 'question_vector' : 'text_vector'

  const conds = []
  // '*'（admin 聚合视图）：不加 owner 过滤，跨 owner 检索
  if (ownerId !== '*') conds.push(`owner_id == "${esc(ownerId)}"`)
  if (Array.isArray(docIds) && docIds.length) {
    conds.push(`doc_id in [${docIds.map((d) => `"${esc(d)}"`).join(',')}]`)
  }
  if (conds.length === 0) conds.push('vec_id != ""')

  const searchParams = ef ? { params: { ef: Number(ef) } } : {}
  const r = await getClient().search({
    collection_name: VEC_COL,
    data: [vector],
    anns_field: annsField,
    limit: Math.max(1, Number(topK) || 20),
    // Strong：刚写入的向量立即可召回（「上传完马上问」是常态）
    consistency_level: 'Strong',
    filter: conds.join(' && '),
    output_fields: ['vec_id', 'doc_id', 'idx'],
    // 注意：实测本版 Milvus/SDK 传 search_params（含 {params:{ef:N}}）会报
    // IllegalArgument 且返回空结果；不传则用默认值正常工作。
    // 因此仅在显式要求调 ef 时才传，默认不带该字段。
    ...(ef ? { search_params: searchParams } : {}),
  })

  return (r?.results ?? []).map((hit) => ({
    vecId: hit.vec_id,
    docId: hit.doc_id,
    // Milvus 的 Int64 字段返回 **string**，必须转 number：
    // 否则 anchorStore.getChunk(docId, idx) 查不到，Map 作 key 也会静默不匹配
    idx: Number(hit.idx),
    score: Number(hit.score),
  }))
}

/** 双路检索：正文向量 + 问题锚点向量，各取 topK 后由上层融合 */
export async function searchBothFields(vector, opts = {}) {
  const [byText, byQuestion] = await Promise.all([
    searchVectors(vector, { ...opts, field: 'text' }),
    searchVectors(vector, { ...opts, field: 'question' }),
  ])
  return { byText, byQuestion }
}

/** 批量写入向量（索引层重建 / 增量入库） */
export async function insertVectors(rows = []) {
  if (!rows?.length) return 0
  const BATCH = 64
  let n = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    await getClient().insert({ collection_name: VEC_COL, data: slice })
    n += slice.length
  }
  return n
}

/** 按文档删除向量 */
export async function deleteVectorsOfDoc(docId, ownerId) {
  requireOwnerId(ownerId, '向量删除')
  await getClient().delete({
    collection_name: VEC_COL,
    filter: `doc_id == "${esc(docId)}" && owner_id == "${esc(ownerId)}"`,
  })
}

/**
 * 统计某 owner 的向量数（对账用：应与锚点层 chunk_catalog 行数一致）。
 * 注意：不能依赖 getCollectionStatistics().row_count（Milvus 3.0 恒为 0），
 * 用强一致 query 取主键计数。
 */
export async function countVectors(ownerId) {
  requireOwnerId(ownerId, '向量计数')
  const r = await getClient().query({
    collection_name: VEC_COL,
    filter: ownerId === '*' ? 'vec_id != ""' : `owner_id == "${esc(ownerId)}"`,
    output_fields: ['vec_id'],
    limit: 16000, // Milvus query limit 上限 16384，超限静默返回空
    consistency_level: 'Strong',
  })
  return (r?.data ?? []).length
}

export async function flush() {
  try {
    // SDK v3 参数是复数数组 collection_names
    await getClient().flush({ collection_names: [VEC_COL] })
  } catch (err) {
    log.warn(`flush 失败（${err.message}），不影响后续强一致读`)
  }
}

/** 按 doc 读双向量本体（管理端向量预览/迁移用）：Map(vecId → {text, question}) */
export async function readVectorsByDoc(docId, ownerId) {
  requireOwnerId(ownerId, '向量读取')
  const r = await getClient().query({
    collection_name: VEC_COL,
    filter:
      ownerId === '*'
        ? `doc_id == "${esc(docId)}"`
        : `doc_id == "${esc(docId)}" && owner_id == "${esc(ownerId)}"`,
    output_fields: ['vec_id', 'text_vector', 'question_vector'],
    limit: 16000,
    consistency_level: 'Strong',
  })
  const map = new Map()
  for (const row of r?.data ?? []) {
    map.set(row.vec_id, { text: row.text_vector, question: row.question_vector })
  }
  return map
}

/** 读 owner 全量正文向量（知识网络图构建用）：Map(vecId → number[]) */
export async function listOwnerTextVectors(ownerId) {
  requireOwnerId(ownerId, '向量读取')
  const r = await getClient().query({
    collection_name: VEC_COL,
    filter: ownerId === '*' ? 'vec_id != ""' : `owner_id == "${esc(ownerId)}"`,
    output_fields: ['vec_id', 'text_vector'],
    limit: 16000,
    consistency_level: 'Strong',
  })
  const map = new Map()
  for (const row of r?.data ?? []) {
    map.set(row.vec_id, Array.isArray(row.text_vector) ? row.text_vector : [])
  }
  return map
}

/** 通用集合行读取（v3 管理端明细）：按 schema 原生字段返回 */
export async function readCollectionRows(name, pk, outputFields, limit = 200, offset = 0) {
  const r = await getClient().query({
    collection_name: name,
    filter: `${pk} != ""`,
    output_fields: outputFields,
    limit: Math.min(500, Math.max(1, Number(limit) || 200)),
    offset: Math.max(0, Number(offset) || 0),
    consistency_level: 'Strong',
  })
  return r?.data ?? []
}
