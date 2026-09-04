import { embedMany } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { embeddingConfig, embedAvailable } from './config.js'
import { childLogger } from './logger.js'

const log = childLogger('embed')

/**
 * embed —— 文本向量化
 *
 * 通过 config 接入任意 OpenAI 兼容 embedding 端点（OpenAI / 智谱 / 本地等）。
 * 不可用时降级为本地 hash 向量（256 维，词项哈希 + TF + L2 归一），保证无 Key 也能跑通。
 *
 * 注意：本模块只负责「算向量」，不负责存储。向量持久化由 lib/milvusStore.js 承担。
 * 另外下方 const DIM = 256 仅用于 hash 降级分支，真实 embedding 的维度（当前
 * nomic-embed-text 为 768）在运行时探测，见 milvusStore.probeDim。
 */

const DIM = 256

/**
 * 词级分词器（hash 降级路径专用）。
 *
 * 用 Intl.Segmenter(word) 识别中英文词边界并过滤标点/空白/符号，段内再按
 * [CJK 单字 | ASCII 字母数字串] 细切，避免 "react.useeffect" 被点号粘连成一坨。
 * 纯 ASCII 单字母（"e.g." 的 e/g、"O(N)" 的 o/n）视为噪声丢弃，降低 hash 向量噪声；
 * CJK 单字保留（中文一字即一词，承载语义）。
 * Intl 不可用时回退纯正则，行为与旧版一致。
 */
const _wordSegmenter = (function () {
  try {
    return new Intl.Segmenter('zh-CN', { granularity: 'word' })
  } catch {
    return null
  }
})()
const _subTokenRe = /[\u4e00-\u9fa5]|[a-z0-9]+/g

function tokenize(s) {
  if (typeof s !== 'string' || !s) return []
  const seg = _wordSegmenter
  if (!seg) return (s.toLowerCase().match(_subTokenRe) ?? [])
  const out = []
  for (const { segment, isWordLike } of seg.segment(s)) {
    if (!isWordLike) continue
    const pieces = segment.toLowerCase().match(_subTokenRe)
    if (!pieces) continue
    for (const p of pieces) {
      if (p.length === 1 && p >= 'a' && p <= 'z') continue // 丢弃纯单字母噪声
      out.push(p)
    }
  }
  return out
}

/** 本地 hash 向量（确定性、无需 Key） */
function hashEmbed(text) {
  const v = new Array(DIM).fill(0)
  for (const tok of tokenize(text)) {
    let h = 2166136261
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    v[h % DIM] += 1
  }
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

// 缓存 provider 实例，避免每次请求重建
let _model = null
// 外部端点熔断器：失败后冷却，冷却结束允许一次探测请求（半开）
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

/**
 * 批量向量化
 *
 * 只要配置了 embedding 端点就优先走外部，但请求失败（网络错误 / 4xx / 模型名不支持）时
 * 自动降级到本地 hash 向量，保证上传与检索链路不被外部 LLM 的 embedding 能力缺失卡死。
 * 首次失败后打开熔断开关，本进程内后续请求直接走本地，避免每次上传都等一次超时。
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  if (!texts.length) return []
  if (embedAvailable && canTryExternal()) {
    try {
      const { embeddings } = await embedMany({
        model: getEmbedModel(),
        values: texts,
      })
      markEmbedSuccess()
      return embeddings
    } catch (err) {
      log.warn(
        '[embed] 外部 Embedding 服务不可用，已自动降级为本地 Hash 向量。' +
        ' 语义检索功能仍可用，但精度可能有所下降。' +
        ' 如需更精准的向量，请在 .env 中配置独立的 EMBED_BASE_URL。'
      )
      log.warn(`        错误详情: ${err.message}`)
      markEmbedFailure()
    }
  }
  return texts.map(hashEmbed)
}

/**
 * 句子级批量向量化（用于 semanticSplit 语义细切 + 句子向量平均复用）。
 *
 * 行为与 embedTexts 完全一致：外部可用时走真实 embedding，失败熔断降级到
 * 本地 hash，保证切片链路不被 embedding 服务卡死。
 *
 * 典型用法：
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

export { embedAvailable }

/**
 * 当前实际生效的 embedding 模式：
 *  - 'external'：真实 embedding 端点（语义相似度可信）
 *  - 'hash'：本地降级/未配置（相似度是哈希噪声，不可用于语义判断）
 *
 * 语义评分等依赖相似度可信度的调用方必须先检查此函数，
 * 避免 hash 向量的伪相似度污染结果。
 */
export function embedMode() {
  return embedAvailable && _circuitState !== 'open' ? 'external' : 'hash'
}
