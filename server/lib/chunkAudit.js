import * as milvus from './milvusStore.js'
import { childLogger } from './logger.js'
import { tunables } from './tunables.js'

/**
 * chunkAudit —— 知识库切片体检（L4 领域模块）
 *
 * 职责：库内存量切片的两两相似度扫描（查重）。
 * 与入库时去重（docTools.dedupPreparedChunks）互补：
 *  - 入库去重只拦「新块 vs 已有块」，历史上已入库的重复对无法发现
 *  - 本模块全量取回切片向量做两两余弦比对，回答「库里哪些块是重复的」
 *
 * 判定口径（与入库去重共用 tunables 阈值，管理端在线修改热生效）：
 *  - 跨文档对：cos ≥ dedup.crossDoc（默认 0.985）判重复
 *  - 同文档对：cos ≥ dedup.withinBatch（默认 0.96）判重复
 *
 * 性能约束：两两比对为 O(n²)。默认最多扫 maxChunks=800 个块
 * （超出按最新入库截断并置 truncated=true），个人知识库量级足够。
 *
 * 依赖：milvusStore（取向量）/ tunables（阈值）。不依赖 LLM / express。
 */

const log = childLogger('chunkAudit')

/** 单个向量的 L2 范数 */
function norm(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

/** 比对结果中的块摘要（不回传向量） */
function brief(c) {
  return {
    chunkId: c.id,
    docId: c.docId,
    idx: c.idx,
    heading: c.heading || '',
    snippet: c.text.slice(0, 120),
  }
}

/**
 * 扫描库内重复切片对。
 * @param {Object} [opts]
 * @param {number} [opts.maxChunks=800] 最多参与比对的块数（超出按最新截断）
 * @param {number} [opts.maxPairs=200] 最多返回的重复对数（相似度降序）
 * @returns {Promise<{scanned:number,total:number,truncated:boolean,pairs:Array,pairTotal:number,ms:number}>}
 */
export async function scanDuplicateChunks({ maxChunks = 800, maxPairs = 200 } = {}) {
  const t0 = performance.now()
  const all = await milvus.listAllChunkVectors()
  const list = all.filter((c) => Array.isArray(c.vector) && c.vector.length > 0)
  const truncated = list.length > maxChunks
  const scan = truncated ? list.slice(list.length - maxChunks) : list

  const withinT = tunables.dedup.withinBatch
  const crossT = tunables.dedup.crossDoc
  const pairs = []
  // 预计算范数，避免内层重复开方
  const norms = scan.map((c) => norm(c.vector))

  for (let i = 0; i < scan.length; i++) {
    const a = scan[i].vector
    for (let j = i + 1; j < scan.length; j++) {
      const b = scan[j].vector
      const d = norms[i] * norms[j]
      if (d === 0) continue
      let dot = 0
      const n = Math.min(a.length, b.length)
      for (let k = 0; k < n; k++) dot += a[k] * b[k]
      const sim = dot / d
      if (sim < 0.9) continue // 远低于两个阈值的快速跳过
      const within = scan[i].docId === scan[j].docId
      if (sim >= (within ? withinT : crossT)) {
        pairs.push({
          sim: Math.round(sim * 1000) / 1000,
          scope: within ? 'within' : 'cross',
          a: brief(scan[i]),
          b: brief(scan[j]),
        })
      }
    }
  }
  pairs.sort((x, y) => y.sim - x.sim)
  const ms = Math.round(performance.now() - t0)
  log.debug(`[chunkAudit] 扫描 ${scan.length}/${list.length} 块 → ${pairs.length} 对重复 | ${ms}ms`)
  return { scanned: scan.length, total: list.length, truncated, pairs: pairs.slice(0, maxPairs), pairTotal: pairs.length, ms }
}
