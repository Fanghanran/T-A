import { Client } from '@elastic/elasticsearch'
import { childLogger } from './logger.js'
import { esConfig } from './config.js'
import { incr } from './metrics.js'

/**
 * esStore —— Elasticsearch 关键词索引（L1 存储）
 *
 * 职责：BM25 关键词召回通道的索引与查询。只存切片的文本元数据（不存向量——
 * 语义路完全由 Milvus 承担），为 unifiedSearch 提供「精确术语在语义不相干块中」
 * 的独立召回路径（2026-09-07 评估：vectorStore/SQLite 等术语双路向量 top-50
 * 池完全丢失，BM25 term 直查倒排索引可捞回）。
 *
 * ES_ENABLED=off 时本模块整体 no-op（initReady 直接过、写删查返回空/0），
 * 系统回到纯向量检索——这是部署配置，不是静默降级（ADR-009）。
 *
 * 调优参数（esConfig → tunables.es）：keywordWeight / esTopK / exactBoost，
 * 在线修改热生效。
 */

const log = childLogger('esStore')

const INDEX = 'kb_chunks_keyword'
// text.exact keyword 子字段 ignore_above 上限（超长标识符按文本截断，罕见）
const BULK_BATCH = 200

let client = null
let ready = false
let initPromise = null

/** ES 是否启用（配置开关，off = 全模块 no-op） */
export function isEnabled() {
  return esConfig.esEnabled
}

function getClient() {
  if (client) return client
  client = new Client({ node: esConfig.url, requestTimeout: 8000 })
  return client
}

/**
 * 索引 mapping：title/question/text 走 ik_max_word（细粒度索引分词），
 * text.exact keyword 子字段兜底整词精确匹配（better-sqlite3 / ERR_CONN_11001
 * 这类含连字符标识符，IK 会按连字符切开，term 精确匹配保证整词命中）。
 * category/tags/owner_id 为过滤字段（与 Milvus 侧检索过滤同口径）。
 */
const MAPPINGS = {
  mappings: {
    properties: {
      chunk_id: { type: 'keyword' },
      doc_id: { type: 'keyword' },
      owner_id: { type: 'keyword' },
      title: { type: 'text', analyzer: 'ik_max_word' },
      question: { type: 'text', analyzer: 'ik_max_word' },
      text: {
        type: 'text',
        analyzer: 'ik_max_word',
        fields: {
          exact: { type: 'keyword', ignore_above: 512 },
        },
      },
      category: { type: 'keyword' },
      tags: { type: 'keyword' },
      indexed_at: { type: 'date' },
    },
  },
}

/** 初始化：建 client + 确认索引存在（不存在则按 mapping 创建）。幂等。 */
export async function initReady() {
  if (!isEnabled()) return
  if (ready) return
  if (initPromise) return initPromise
  initPromise = (async () => {
    const es = getClient()
    const exists = await es.indices.exists({ index: INDEX })
    if (!exists) {
      await es.indices.create({ index: INDEX, ...MAPPINGS })
      log.info(`[esStore] 已创建索引 ${INDEX}（ik_max_word + text.exact）`)
    }
    ready = true
    log.info(`[esStore] 关键词索引就绪：${esConfig.url}/${INDEX}`)
  })()
  try {
    await initPromise
  } finally {
    // 失败允许下次重试（如 ES 容器晚于后端启动）
    initPromise = null
  }
}

/**
 * 批量写入切片（addChunks 双写钩子调用）。
 * rows 为 vectorStore 组装好的完整行（含向量字段，本函数只取文本元数据）。
 * 写完核实：refresh 后 count ≥ 写入数，不足显式报错（写路径一致性优先，ADR-009）。
 */
export async function indexChunks(rows) {
  if (!isEnabled() || !Array.isArray(rows) || !rows.length) return 0
  await initReady()
  const es = getClient()
  const body = []
  for (const r of rows) {
    body.push({ index: { _index: INDEX, _id: r.id } })
    body.push({
      chunk_id: r.id,
      doc_id: r.docId,
      owner_id: r.ownerId,
      title: r.displayTitle ?? '',
      // questions 是该切片的「典型提问锚点」，join 进 BM25 让关键词路也享受锚点加成
      question: Array.isArray(r.questions) ? r.questions.join('\n') : '',
      text: r.text ?? '',
      category: r.category ?? '',
      tags: Array.isArray(r.tags) ? r.tags : [],
      indexed_at: r.indexedAt || new Date().toISOString(),
    })
  }
  for (let i = 0; i < body.length; i += BULK_BATCH * 2) {
    const batch = body.slice(i, i + BULK_BATCH * 2)
    const resp = await es.bulk({ body: batch, refresh: 'wait_for' })
    if (resp.errors) {
      const first = resp.items.find((it) => it.index?.error)?.index?.error
      throw new Error(`[esStore] bulk 写入部分失败：${JSON.stringify(first).slice(0, 200)}`)
    }
  }
  incr('es_index_total', rows.length)
  return rows.length
}

/** 按文档删除全部切片（deleteDocument / 重切 / 回填前清理） */
export async function deleteByDocId(docId) {
  if (!isEnabled() || !docId) return 0
  await initReady()
  const es = getClient()
  const resp = await es.deleteByQuery({
    index: INDEX,
    body: { query: { term: { doc_id: docId } } },
    refresh: true,
  })
  return resp.deleted ?? 0
}

/** 按 chunk id 精确删除（deleteChunksByIds 双写钩子） */
export async function deleteByChunkIds(ids) {
  if (!isEnabled() || !Array.isArray(ids) || !ids.length) return 0
  await initReady()
  const es = getClient()
  const resp = await es.deleteByQuery({
    index: INDEX,
    body: { query: { terms: { _id: ids } } },
    refresh: true,
  })
  return resp.deleted ?? 0
}

/**
 * 同步文档元数据（patchMeta 改 category/tags 后保持 ES 过滤字段一致）。
 * 用 painless 脚本局部更新，不重写全文。
 */
export async function updateDocMeta(docId, { category, tags }) {
  if (!isEnabled() || !docId) return
  await initReady()
  const es = getClient()
  await es.updateByQuery({
    index: INDEX,
    refresh: true,
    body: {
      query: { term: { doc_id: docId } },
      script: {
        source:
          'if (params.category != null) ctx._source.category = params.category; if (params.tags != null) ctx._source.tags = params.tags',
        params: {
          category: category === undefined ? null : category,
          tags: tags === undefined ? null : tags,
        },
      },
    },
  })
}

/**
 * BM25 关键词检索（unifiedSearch 第三通道调用）。
 *
 * 查询构造：multi_match（title^3 / question^2 / text）+ text.exact term 精确加权，
 * filter 与 Milvus 侧检索同口径（owner_id 必须，category/tag 可选）。
 * 返回原始 BM25 分数（无界），由调用方做集合内归一化与融合加权。
 *
 * ES 不可用：返回 { hits: [], degraded: true } 并计数——带标注降级（ADR-009
 * 允许的「带标注的无增强实现」），不阻塞向量主链路。
 *
 * @returns {Promise<{hits: Array<{id:string, score:number}>, degraded: boolean}>}
 */
export async function search(query, { topK = 50, category, tag, ownerId } = {}) {
  if (!isEnabled() || !query?.trim()) return { hits: [], degraded: false }
  try {
    await initReady()
    const es = getClient()
    // '*'（admin 聚合视图）：不加 owner 过滤
    const filter = ownerId === '*' ? [] : [{ term: { owner_id: ownerId ?? '' } }]
    if (category) filter.push({ term: { category } })
    if (tag) filter.push({ term: { tags: tag } })
    const resp = await es.search({
      index: INDEX,
      size: topK,
      query: {
        bool: {
          should: [
            {
              multi_match: {
                query,
                fields: ['title^3', 'question^2', 'text'],
                type: 'best_fields',
              },
            },
            { term: { 'text.exact': { value: query, boost: esConfig.exactBoost } } },
          ],
          filter,
          minimum_should_match: 1,
        },
      },
    })
    incr('es_search_total')
    const hits = (resp.hits?.hits ?? []).map((h) => ({
      id: h._source?.chunk_id ?? h._id,
      score: Number(h._score) || 0,
    }))
    return { hits, degraded: false }
  } catch (err) {
    incr('es_search_errors')
    log.warn(`[esStore] 检索失败（带标注降级，不影响向量主链路）：${err.message}`)
    return { hits: [], degraded: true }
  }
}

/** 索引内文档计数（启动核对与回填端点用） */
export async function countChunks() {
  if (!isEnabled()) return -1
  await initReady()
  const es = getClient()
  const resp = await es.count({ index: INDEX })
  return resp.count ?? 0
}

/**
 * 全量回填：清空索引后从 Milvus 全量读切片重建（management sync 端点调用）。
 * 幂等：按 chunk_id 覆盖写（_id 即 chunk id），重复执行结果一致。
 * @param {Array} allChunks milvus.listAllChunks() 的返回（rowToChunk 结构）
 * @returns {Promise<{indexed:number}>}
 */
export async function rebuildIndex(allChunks) {
  if (!isEnabled()) return { indexed: 0 }
  await initReady()
  const es = getClient()
  // 先清后建：避免残留已删文档的孤儿（与 vectorStore 全删全写口径一致）
  const exists = await es.indices.exists({ index: INDEX })
  if (exists) await es.indices.delete({ index: INDEX })
  await es.indices.create({ index: INDEX, ...MAPPINGS })
  const rows = (allChunks ?? []).map((c) => ({
    id: c.id,
    docId: c.docId,
    ownerId: c.ownerId ?? 'local',
    displayTitle: c.displayTitle ?? '',
    questions: c.questions ?? [],
    text: c.text ?? '',
    category: c.category ?? '',
    tags: c.tags ?? [],
    indexedAt: c.indexedAt || new Date().toISOString(),
  }))
  let indexed = 0
  for (let i = 0; i < rows.length; i += BULK_BATCH) {
    indexed += await indexChunks(rows.slice(i, i + BULK_BATCH))
  }
  log.info(`[esStore] 全量回填完成：${indexed} 块`)
  return { indexed }
}
