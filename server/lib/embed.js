import { embedMany } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { embeddingConfig, embedAvailable } from './config.js'
import { childLogger } from './logger.js'
import { ServiceUnavailableError } from './errors.js'

const log = childLogger('embed')

/**
 * embed —— 文本向量化（Fail-Fast，见 ADR-009）
 *
 * 通过 config 接入任意 OpenAI 兼容 embedding 端点（OpenAI / 智谱 / 本地等）。
 *
 * **禁止降级**（2026-09-03 策略）：Embedding 未配置或断连时，显式抛出
 * ServiceUnavailableError（code=EMBED_UNAVAILABLE），绝不静默回退到
 * hash 假向量——那会让语义检索"看起来在工作、实际全是噪声"（隐性版本回退）。
 *
 * 熔断器仍然保留，但用途从「降级切换」变为「快速失败」：首次失败即熔断，
 * 冷却窗口内直接抛错不再打网络，冷却结束允许一次探测。
 *
 * 本模块只负责「算向量」，不负责存储。向量持久化由 lib/milvusStore.js 承担。
 */

// 缓存 provider 实例，避免每次请求重建
let _model = null
// 熔断器：失败后冷却，冷却结束允许一次探测请求（半开）
let _circuitState = 'closed'
let _circuitOpenedAt = 0
let _circuitProbeInFlight = false
const EMBED_COOLDOWN_MS = Math.max(1000, Number(process.env.EMBED_CIRCUIT_COOLDOWN_MS) || 30000)

function canTryExternal() {
  if (_circuitState === 'closed') return true
  if (_circuitState === 'open' && Date.now() - _circuitOpenedAt >= EMBED_COOLDOWN_MS && !_circuitProbeInFlight) {
    _circuitState = 'half-open'
    _circuitProbeInFlight = true
    return true
  }
  return false
}
function markEmbedSuccess() {
  _circuitState = 'closed'
  _circuitOpenedAt = 0
  _circuitProbeInFlight = false
}
function markEmbedFailure() {
  _circuitState = 'open'
  _circuitOpenedAt = Date.now()
  _circuitProbeInFlight = false
}

function getEmbedModel() {
  if (_model) return _model
  const opts = { apiKey: embeddingConfig.apiKey }
  if (embeddingConfig.baseUrl) opts.baseURL = embeddingConfig.baseUrl
  const openai = createOpenAI(opts)
  _model = openai.embedding(embeddingConfig.model)
  return _model
}

function requireEmbed() {
  if (!embedAvailable) {
    throw new ServiceUnavailableError(
      'Embedding 未配置：向量化与语义检索不可用。请在 server/.env 配置 EMBED_API_KEY / EMBED_BASE_URL / EMBED_MODEL 后重启后端。',
      'EMBED_UNAVAILABLE',
    )
  }
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
  requireEmbed()
  if (!canTryExternal()) {
    throw new ServiceUnavailableError(
      'Embedding 服务暂不可用（熔断冷却中，稍后自动探测恢复）。请检查 Embedding 服务（EMBED_BASE_URL / EMBED_MODEL）状态。',
      'EMBED_UNAVAILABLE',
    )
  }
  try {
    const { embeddings } = await embedMany({
      model: getEmbedModel(),
      values: texts,
    })
    markEmbedSuccess()
    return embeddings
  } catch (err) {
    markEmbedFailure()
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

export { embedAvailable }

/**
 * 当前实际生效的 embedding 模式：
 *  - 'external'：真实 embedding 端点（语义相似度可信）
 *  - 'unavailable'：未配置或熔断打开（此时 embedTexts 会抛 EMBED_UNAVAILABLE）
 *
 * 语义评分等调用方据此选择「无增强的有效实现」（如纯启发式评分，并如实标注 scoreMode）。
 */
export function embedMode() {
  return embedAvailable && _circuitState !== 'open' ? 'external' : 'unavailable'
}
