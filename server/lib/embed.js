import { embedMany } from 'ai'
import * as models from './models.js'
import { incr, observe } from './metrics.js'
import { childLogger } from './logger.js'
import { ServiceUnavailableError } from './errors.js'

const log = childLogger('embed')

/**
 * embed —— 文本向量化（Fail-Fast，见 ADR-009；模型路由见 ADR-006）
 *
 * 模型实例与 profile 解析统一走 lib/models.js（routes.defaults.embedding 路由）。
 * **禁止降级**（2026-09-03 策略）：Embedding 未配置或断连时，显式抛出
 * ServiceUnavailableError（code=EMBED_UNAVAILABLE），绝不静默回退到
 * hash 假向量——那会让语义检索"看起来在工作、实际全是噪声"（隐性版本回退）。
 *
 * 熔断器按 profile 分片（互不传染）：首次失败即熔断，冷却窗口内直接抛错
 * 不再打网络，冷却结束允许一次探测（半开）。用途从「降级切换」变为「快速失败」。
 *
 * 本模块只负责「算向量」，不负责存储。向量持久化由 lib/milvusStore.js 承担。
 */

const EMBED_COOLDOWN_MS = Math.max(1000, Number(process.env.EMBED_CIRCUIT_COOLDOWN_MS) || 30000)

/** 熔断状态（按 profile 分片）：profileId -> { state, openedAt } */
const circuits = new Map()

function circuitFor(profileId) {
  let c = circuits.get(profileId)
  if (!c) {
    c = { state: 'closed', openedAt: 0 }
    circuits.set(profileId, c)
  }
  return c
}

/**
 * 批量向量化（Fail-Fast）。
 *
 * - 未配置 / 熔断冷却中 / 调用失败 → 抛 ServiceUnavailableError（EMBED_UNAVAILABLE），
 *   由上层（路由/前端）呈现「Embedding 不可用」提醒；绝不返回 hash 假向量。
 * - 空输入：返回 []。
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  if (!texts.length) return []
  const prof = models.getEmbedProfile()
  const circ = circuitFor(prof.id)
  if (circ.state === 'open' && Date.now() - circ.openedAt < EMBED_COOLDOWN_MS) {
    throw new ServiceUnavailableError(
      'Embedding 服务暂不可用（熔断冷却中，稍后自动探测恢复）。请检查 Embedding 服务（EMBED_BASE_URL / EMBED_MODEL）状态。',
      'EMBED_UNAVAILABLE',
    )
  }
  try {
    const t0 = performance.now()
    const { embeddings } = await embedMany({
      model: models.getEmbedModel(),
      values: texts,
    })
    circ.state = 'closed'
    // Embedding 指标：调用耗时直方图 + 批大小累计（检索/入库共用同一路径）
    observe('embed_ms', Math.round(performance.now() - t0))
    incr('embed_total')
    incr('embed_texts_total', null, texts.length)
    return embeddings
  } catch (err) {
    circ.state = 'open'
    circ.openedAt = Date.now()
    incr('embed_failures')
    log.error(`[embed] Embedding 调用失败：${err.message}`)
    throw new ServiceUnavailableError(
      `Embedding 调用失败：${err.message}。请检查 Embedding 服务（EMBED_BASE_URL / EMBED_MODEL）状态。`,
      'EMBED_UNAVAILABLE',
    )
  }
}

/**
 * 句子级批量向量化（用于 semanticSplit 语义细切 + 句子向量平均复用）。
 * 行为与 embedTexts 完全一致：不可用即抛错。
 *
 *   const sentenceVecs = await embedSentences(sentences)
 *   // 对相邻句子做余弦相似度找语义断点
 *   // 每个 chunk 最终向量 = chunk 内句子向量算术平均（零成本，不重复调用 embedding）
 *
 * @param {string[]} sentences
 * @returns {Promise<number[][]>}
 */
export async function embedSentences(sentences) {
  return embedTexts(sentences)
}

/**
 * 向量平均：把一组句子向量做算术平均 → 组合成 chunk 级向量
 * （零成本，无需再次调用 embedding 服务）。
 *
 * - 空输入：返回空数组
 * - 单句：直接返回原向量
 * - 多句：按维度逐项相加 / N（不做归一化，vectorStore/search 侧会统一处理）
 *
 * @param {Array<number[]>} vectors
 * @returns {number[]}
 */
export function averageVectors(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) return []
  if (vectors.length === 1) return vectors[0]
  const dim = vectors[0].length
  const out = new Array(dim).fill(0)
  let count = 0
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== dim) continue
    for (let d = 0; d < dim; d++) out[d] += v[d]
    count++
  }
  if (count === 0) return []
  for (let d = 0; d < dim; d++) out[d] = out[d] / count
  return out
}

/**
 * 当前实际生效的 embedding 模式：
 *  - 'external'：真实 embedding 端点（语义相似度可信）
 *  - 'unavailable'：未配置或熔断打开（此时 embedTexts 会抛 EMBED_UNAVAILABLE）
 *
 * 语义评分等依赖相似度可信度的调用方必须先检查此函数，
 * 选择「无增强的有效实现」（如纯启发式评分）并如实标注 scoreMode。
 */
export function embedMode() {
  try {
    const prof = models.getEmbedProfile()
    const circ = circuits.get(prof.id)
    return circ?.state === 'open' ? 'unavailable' : 'external'
  } catch {
    return 'unavailable'
  }
}
