import * as vectorStore from './vectorStore.js'
import { AppError } from './errors.js'

/**
 * quota —— per-user 资源配额与用量统计（M5b / ADR-008）
 *
 * 职责：
 *  - 统计单个用户的资源用量（文档数 / 切片数），基于 vectorStore 内存缓存（O(n)，个人部署量级可忽略）
 *  - 上传/入库前做配额检查，超限抛 429 QUOTA_EXCEEDED（显式报错，符合 ADR-009 禁止静默降级）
 *
 * 配置（env 可覆盖；默认宽松 —— 单用户本地部署几乎不会触顶，公开部署时按需收紧）：
 *  - QUOTA_ENABLED       总开关（默认开；置 0/off 完全放行，disabled 模式零回归）
 *  - QUOTA_MAX_DOCUMENTS 每用户文档总数上限（默认 500）
 *  - QUOTA_MAX_CHUNKS    每用户切片总数上限（默认 100000）
 *
 * 分层：L2（依赖 L1 vectorStore 统计 + L0 errors），被 L8 路由调用。
 * 注意：不能下沉到 vectorStore —— L1 不得反向依赖本模块（分层守卫会拦）。
 */

function envInt(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const enabled = !/^(0|false|off)$/i.test(String(process.env.QUOTA_ENABLED ?? '1').trim())

export const quotaConfig = Object.freeze({
  enabled,
  maxDocuments: envInt('QUOTA_MAX_DOCUMENTS', 500),
  maxChunks: envInt('QUOTA_MAX_CHUNKS', 100_000),
})

/**
 * 某用户的资源用量与配额上限（管理页用量视图 / 配额检查共用）。
 * @param {string} ownerId
 */
export function usageOf(ownerId) {
  const s = vectorStore.statsByOwner(ownerId)
  return {
    documents: s.documents,
    chunks: s.chunks,
    limits: { maxDocuments: quotaConfig.maxDocuments, maxChunks: quotaConfig.maxChunks },
  }
}

function assertWithin(current, adding, limit, label) {
  if (current + adding > limit) {
    throw new AppError(`${label}已达配额上限（${current}/${limit}，本次将新增 ${adding}）`, {
      status: 429,
      code: 'QUOTA_EXCEEDED',
    })
  }
}

/**
 * 上传 / 入库前的配额检查。配额关闭时直接放行。
 * 应在 prepareDocChunksAndVectors 之后调用 —— 此时切片数已知，一次检查同时覆盖两类配额。
 * @param {string} ownerId
 * @param {{addDocuments?: number, addChunks?: number}} [delta]
 */
export function assertQuota(ownerId, { addDocuments = 0, addChunks = 0 } = {}) {
  if (!quotaConfig.enabled) return
  const u = usageOf(ownerId)
  assertWithin(u.documents, addDocuments, quotaConfig.maxDocuments, '文档数')
  assertWithin(u.chunks, addChunks, quotaConfig.maxChunks, '切片数')
}
