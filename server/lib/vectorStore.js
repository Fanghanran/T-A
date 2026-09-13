import * as v2 from './vectorStoreV2.js'
import * as v3 from './vectorStoreV3.js'
import { childLogger } from './logger.js'

/**
 * vectorStore —— 知识库存储层门面（facade）
 *
 * 通过 STORAGE_MODE 在两种实现间切换，**对外 API 完全一致**（函数名、签名、返回结构），
 * 因此所有调用方（routes / unifiedSearch / docProcessor）无需任何改动：
 *
 *   STORAGE_MODE 未设 / v2  → vectorStoreV2（v2 架构：Milvus 承载全量数据 + 内存镜像缓存）
 *   STORAGE_MODE=v3         → vectorStoreV3（v3 三级存储：文件 + SQLite 锚点层 + 瘦向量集合）
 *
 * v3 的分工（详见 docs/向量库重构设计书.md）：
 *   持久层  本地文件（fileStore）        —— 原件 + content.md，唯一事实源，按 span 取文
 *   锚点层  SQLite（anchorStore）        —— documents + chunk_catalog，只存指针，不存正文
 *   索引层  Milvus 瘦集合（vectorIndexV3）—— kb_vectors 双向量，可丢弃可重建
 *
 * 默认走 v2：v3 尚未完成端到端回归前，服务行为保持不变（零风险灰度）。
 */

const log = childLogger('vectorStore')

const USE_V3 = /^(1|true|v3|on|yes)$/i.test(String(process.env.STORAGE_MODE ?? '').trim())
const impl = USE_V3 ? v3 : v2
const which = USE_V3 ? 'v3（文件 + 锚点层 + 瘦索引）' : 'v2（Milvus 全量）'

log.info(`[vectorStore] 存储实现：${which}`)

export const storageMode = () => (USE_V3 ? 'v3' : 'v2')

/* ---- 生命周期 ---- */
export const whenLoaded = (...a) => impl.whenLoaded(...a)
export const load = (...a) => impl.load(...a)
export const flushSync = (...a) => impl.flushSync(...a)

/* ---- 统计 ---- */
export const stats = (...a) => impl.stats(...a)
export const statsByOwner = (...a) => impl.statsByOwner(...a)
export const statsByCategory = (...a) => impl.statsByCategory(...a)
export const statsByCategoryAll = (...a) => impl.statsByCategoryAll(...a)
export const listCategories = (...a) => impl.listCategories(...a)
export const listTags = (...a) => impl.listTags(...a)
export const listOrphanDocs = (...a) => impl.listOrphanDocs(...a)

/* ---- 文档 ---- */
export const createDocument = (...a) => impl.createDocument(...a)
export const getDocument = (...a) => impl.getDocument(...a)
export const listDocuments = (...a) => impl.listDocuments(...a)
export const patchMeta = (...a) => impl.patchMeta(...a)
export const patchMetaAsync = (...a) => impl.patchMetaAsync(...a)
export const batchPatchMeta = (...a) => impl.batchPatchMeta(...a)
export const batchPatchMetaAsync = (...a) => impl.batchPatchMetaAsync(...a)
export const deleteDocument = (...a) => impl.deleteDocument(...a)
export const batchDelete = (...a) => impl.batchDelete(...a)
export const findDocIdByContent = (...a) => impl.findDocIdByContent(...a)

/* ---- 切片策略（纯元数据，v3 由 V3 模块内部维护） ---- */
export const setDocStrategy = (...a) => impl.setDocStrategy(...a)
export const getDocStrategy = (...a) => impl.getDocStrategy(...a)

/* ---- 切片 ---- */
export const addChunks = (...a) => impl.addChunks(...a)
export const getChunkById = (...a) => impl.getChunkById(...a)
export const listChunksOf = (...a) => impl.listChunksOf(...a)
export const countChunksOfDoc = (...a) => impl.countChunksOfDoc(...a)
export const listChunkVectorsOfDoc = (...a) => impl.listChunkVectorsOfDoc(...a)
export const deleteChunksByIds = (...a) => impl.deleteChunksByIds(...a)

/* ---- 正文更新 ---- */
export const updateContent = (...a) => impl.updateContent(...a)
export const updateContentWithPrepared = (...a) => impl.updateContentWithPrepared(...a)

/* ---- 检索 ---- */
export const search = (...a) => impl.search(...a)
