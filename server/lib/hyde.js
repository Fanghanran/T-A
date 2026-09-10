/**
 * HyDE（Hypothetical Document Embeddings）—— 假设答案生成器（L2 算法层）。
 *
 * 动机（2026-09-06 级联触发方案）：
 *   纯向量检索对「问法与正文语体差异大」的查询不稳——用户问句是疑问句口吻，
 *   讲义/文档正文是陈述句口吻，两者在向量空间天然有一层「语体差」。
 *   HyDE 让 LLM 先针对用户问题写一段假设答案（陈述句、文档口吻），
 *   再用这段答案的向量去查 text 路——答案与库内正文同语体，相似度口径一致，更易命中。
 *
 * 设计原则（与 queryRewriter 一致）：
 *   1. 熔断第一：超时 / LLM 不可用 / 输出为空 → 返回 null，绝不抛错阻塞主检索链路。
 *      HyDE 是首轮检索之上的增强轮，失败只意味着保留首轮结果，不影响检索本身。
 *   2. 级联触发由调用方（unifiedSearch）负责：本模块只负责「给一个问题 → 生成一段假设答案」。
 *   3. TTL LRU 缓存：低分查询往往反复出现（用户换个问法重试），命中缓存零 LLM 开销。
 *
 * 唯一对外 API：
 *   export async function hypothesize(query) -> Promise<{ text: string, source: 'cache'|'llm', ms: number } | null>
 */

import { generateText } from 'ai'
import { llmAvailable, hydeConfig } from './config.js'
import { getChatModel } from './llmProvider.js'
import { createTtlLruCache } from './cache.js'
import { incr, observe } from './metrics.js'
import { childLogger } from './logger.js'

const log = childLogger('hyde')

// ====== 模块级单例：假设答案缓存（query → 假设答案文本）======
const _cache = createTtlLruCache({
  maxEntries: hydeConfig.cacheSize,
  ttlMs: hydeConfig.cacheTtlMs,
})

/**
 * 生成假设答案。
 * @param {string} query 用户原始问题
 * @returns {Promise<{text:string, source:'cache'|'llm', ms:number} | null>}
 *   null = 本轮不可用（开关关闭 / LLM 不可用 / 超时 / 空输出），调用方保留首轮结果即可
 */
export async function hypothesize(query) {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return null
  // 总开关在调用方（unifiedSearch）已判过，这里再判一次：允许直接调用本模块时也被开关管住
  if (hydeConfig.hydeEnabled === false) return null
  if (!llmAvailable) return null

  // 1) 缓存命中：低分查询反复出现时直接复用，跳过 LLM
  const cached = _cache.get(q)
  if (typeof cached === 'string' && cached) {
    incr('hyde_cache_hits')
    return { text: cached, source: 'cache', ms: 0 }
  }
  incr('hyde_cache_misses') // 命中率 = hits / (hits + misses)

  // 2) 生成假设答案：要求陈述句、文档口吻、直接给答案正文——
  //    口吻越贴近库内正文，向量相似度口径越一致（这是 HyDE 的全部价值所在）
  const timeoutMs = Number.isFinite(hydeConfig.timeoutMs) ? hydeConfig.timeoutMs : 12000
  const maxChars = Number.isFinite(hydeConfig.maxAnswerChars) ? hydeConfig.maxAnswerChars : 300
  const t0 = performance.now()
  const prompt =
    `你是技术知识库的作者。请针对下面的问题，直接写出知识库文档中会出现的答案段落。\n` +
    `要求：\n` +
    `1) 用陈述句、文档正文口吻，直接陈述答案本身，禁止出现"这个问题""根据文档""答："等对话式表述；\n` +
    `2) 内容 ${Math.floor(maxChars / 2)}~${maxChars} 字，聚焦问题本身的关键概念与结论，不展开无关背景；\n` +
    `3) 只输出答案正文，不要任何前缀、解释、标题或 markdown 格式。\n\n` +
    `【问题】：${q}\n`

  // 超时熔断：AbortController + Promise.race 双保险
  // （abort 会让 llmPromise reject，必须显式挂 rejection handler 防 unhandled rejection 打挂进程，
  //  与 llm.js _annotateBatch 同款处理）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const llmPromise = generateText({
    model: getChatModel({ role: 'chat.rewrite' }),
    temperature: 0,
    prompt,
    abortSignal: controller.signal,
  })
  llmPromise.catch(() => {})

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`generateText 超时 ${timeoutMs}ms`)), timeoutMs + 2000)
    Promise.race([llmPromise])
      .finally(() => clearTimeout(t))
      .catch(() => {})
  })

  try {
    const result = await Promise.race([llmPromise, timeoutPromise])
    clearTimeout(timer)
    const text = (result?.text ?? '').trim()
    if (!text) return null
    // 截断到 maxChars：过长会稀释向量语义
    const clipped = text.length > maxChars ? text.slice(0, maxChars) : text
    _cache.set(q, clipped)
    const ms = Math.round(performance.now() - t0)
    observe('hyde_generate_ms', ms)
    log.info(`[hyde] 假设答案生成成功（${clipped.length} 字 / ${ms}ms）：${q.slice(0, 40)}`)
    return { text: clipped, source: 'llm', ms }
  } catch (err) {
    clearTimeout(timer)
    // 超时 / LLM 异常：warn 记录后返回 null，首轮结果不受影响（增强轮失败的合理降级，非静默——有日志）
    incr('hyde_generate_errors')
    log.warn(`[hyde] 假设答案生成失败（${err.message}），本轮跳过：${q.slice(0, 40)}`)
    return null
  }
}
