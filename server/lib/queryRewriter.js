/**
 * 阶段 2：Query 改写器 —— 把单轮用户 query + 历史对话扩展为 2~3 个"互补检索角度"的独立 queries。
 *
 * 设计原则：
 *  1. 熔断第一：超时 / LLM 不可用 / JSON 解析失败 / 并发超限 → **立刻降级返回原始 query**，绝不阻塞主检索链路。
 *  2. 上下文窗口裁剪：最近 N 轮完整，更早直接丢弃；总字符上限 maxPromptChars。
 *  3. 质量校验：输出 query 过滤过短/过长/"无法回答/抱歉"类水话。
 *  4. 并发限流 + 内存缓存：p-queue 风格自实现计数 + Map LRU。
 *
 * 唯一对外 API：
 *   export async function rewrite(query, history, cfg)
 *     -> Promise<{ queries: string[], rewritten: boolean, reason: string }>
 *   queries[0] 一定是原始 query（权重最高的 queryWeights[0]），
 *   queries[1..n] 是改写补充 query（不存在时数组长度为 1）。
 */

import { streamText } from 'ai'
import { llmConfig, llmAvailable, queryRewriterConfig } from './config.js'
import { getChatModel } from './llmProvider.js'
import { stripToJson } from './textUtils.js'

// ====== 简易内存 LRU Cache（Map + 超过容量删最旧）======
class LRU {
  constructor(max = 64) { this.max = Math.max(1, max); this.map = new Map() }
  get(k) {
    const v = this.map.get(k); if (v === undefined) return undefined
    this.map.delete(k); this.map.set(k, v); return v
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k)
    else if (this.map.size >= this.max) { const oldest = this.map.keys().next().value; this.map.delete(oldest) }
    this.map.set(k, v)
  }
}

// ====== 并发限流 + maxPending 熔断（p-queue 极简版）======
class ConcurrencyGate {
  constructor({ maxConcurrency = 3, maxPending = 10 } = {}) {
    this.maxConcurrency = Math.max(1, maxConcurrency)
    this.maxPending = Math.max(0, maxPending)
    this.running = 0
    this.pending = [] // 数组队列，push 入尾 / shift 出头
  }
  /** 返回 { ok:boolean, run: (fn:()=>Promise<T>) => Promise<T> } — ok=false 表示超 maxPending 直接降级 */
  acquire() {
    if (this.pending.length >= this.maxPending) return { ok: false, run: null }
    const self = this
    const run = async (fn) => {
      await new Promise((res) => {
        if (self.running < self.maxConcurrency) { self.running++; res(); return }
        self.pending.push({ res })
      })
      try { return await fn() }
      finally {
        self.running--
        if (self.pending.length > 0) { const next = self.pending.shift(); self.running++; next.res() }
      }
    }
    return { ok: true, run }
  }
}

// ====== 模块级单例：cache + 限流 ======
const _cache = new LRU(queryRewriterConfig?.rewriteCacheSize ?? 64)
const _gate = new ConcurrencyGate({
  maxConcurrency: queryRewriterConfig?.maxConcurrency ?? 3,
  maxPending: queryRewriterConfig?.maxPending ?? 10,
})


/** 近似 token 估算：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token */
function _estimateTokens(s) {
  if (!s) return 0
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  return cjk + (s.length - cjk) / 4
}

/**
 * 上下文压缩：最近 historyTurns 轮 → 更早丢弃 → 按 token 预算截断，末尾优先。
 * 双闸门：token 预算为主（中英文都合理），字符数为硬上限兜底。
 */
function _compressHistory(
  history,
  { historyTurns = 3, maxPromptTokens = 500, maxPromptChars = 2000 } = {},
) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const turns = Math.max(1, historyTurns)
  const recent = history.slice(-turns * 2) // user+assistant 一对 = 1 轮
  const rows = recent.map((m) => `${m.role === 'assistant' ? '【AI】' : '【用户】'}: ${String(m.content ?? '').replace(/\s+/g, ' ').trim()}`)
  let joined = rows.join('\n')

  // 字符硬上限
  if (joined.length > maxPromptChars) joined = '…' + joined.slice(-maxPromptChars + 1)
  // token 预算：从头部砍，保证「最后一轮」完整（更接近当前 query 的指代）
  const budget = Math.max(1, Number(maxPromptTokens) || 500)
  while (_estimateTokens(joined) > budget && joined.length > 1) {
    const drop = Math.max(1, Math.ceil(joined.length * 0.1)) // 每次砍 10%，避免逐字符循环
    joined = '…' + joined.slice(drop)
  }
  return joined
}

/** query 质量校验：过滤过短/过长/明显水话（输出不合法时直接 drop，不报错） */
function _isValidQuery(q, { minChars = 5, maxChars = 200 } = {}) {
  if (typeof q !== 'string') return false
  const t = q.trim()
  if (!t || t.length < minChars || t.length > maxChars) return false
  const bad = /(抱歉|无法|对不起|我(不|没|无法)|(不|没)知道|不太清楚|无法回答|你可以|请你|谢谢|好的|是的|对的|嗯|哦)/
  if (bad.test(t)) return false
  return true
}

/** 生成 LRU 缓存 key：query + 压缩后的 history（hash）。注意：不用 JSON.stringify 整个 history 爆长。 */
function _cacheKey(query, historyStr) {
  const h = historyStr || ''
  // 简易 djb2 hash（避免引 crypto）
  let hash = 5381
  for (let i = 0; i < h.length; i++) hash = ((hash << 5) + hash) + h.charCodeAt(i)
  return `${String(query ?? '').trim()}|${hash >>> 0}`
}

/**
 * @param {string} query 原始用户 query
 * @param {Array<{role:string,content:string}>} [history] 多轮对话（从 sessionStore 或前端 body.history 透传）
 * @param {Object} [overrideCfg] 覆盖默认 queryRewriterConfig
 * @returns {Promise<{queries:string[], rewritten:boolean, reason:string}>}
 */
export async function rewrite(query, history, overrideCfg = {}) {
  const cfg = { ...(queryRewriterConfig ?? {}), ...overrideCfg }
  const q = typeof query === 'string' ? query.trim() : ''
  const fallback = (reason = '') => ({ queries: q ? [q] : [], rewritten: false, reason })
  if (!q) return fallback('empty_query')
  // 总开关：本地小模型改写往往又慢又无收益，允许整体关闭
  if (cfg.rewriteEnabled === false || /^(0|false|no|off)$/i.test(String(cfg.rewriteEnabled ?? ''))) {
    return fallback('rewrite_disabled')
  }

  // 1) 上下文压缩 + Cache 命中
  const historyStr = _compressHistory(history, {
    historyTurns: cfg.historyTurns,
    maxPromptTokens: cfg.maxPromptTokens,
    maxPromptChars: cfg.maxPromptChars,
  })
  const k = _cacheKey(q, historyStr)
  const cached = _cache.get(k)
  if (cached) return cached

  // 2) 无 LLM → 直接降级
  if (!llmAvailable) { _cache.set(k, fallback('llm_unavailable')); return fallback('llm_unavailable') }

  // 3) 并发限流：超 maxPending → 降级（绝不排队阻塞，保证主链路响应性）
  const gate = _gate.acquire()
  if (!gate.ok) { _cache.set(k, fallback('max_pending')); return fallback('max_pending') }

  // 4) 真实改写（超时 ms 内不完成 → AbortController 中断 → 降级）
  const timeoutMs = Number.isFinite(cfg.rewriteTimeoutMs) ? cfg.rewriteTimeoutMs : 3000
  const queriesPer = Math.max(2, Math.min(5, Number.isFinite(cfg.queriesPerRequest) ? cfg.queriesPerRequest : 3))
  const prompt =
    `你是检索 Query 改写专家。给定【用户当前问题】 + 【最近几轮对话历史】，请改写输出 ${queriesPer} 个独立、互补、用于向量检索的查询。\n` +
    `要求：\n` +
    `1) 第 0 条（最优先）必须是"当前问题的同义改写 / 补充缺失指代"的版本，长度与原问题相近；\n` +
    `2) 第 1..${queriesPer - 1} 条分别从不同角度改写：例如"换一个更专业的术语说法" / "把指代补全为具体概念" / "拆成具体知识点问句" / "换成面试场景下的问法" 等；\n` +
    `3) 每个 query 必须是完整问句/陈述句，不出现编号，不要解释，彼此不重复；\n` +
    `4) 输出 STRICT JSON 数组 ["q0","q1","q2"]，不要 markdown 代码块/前后文字。\n\n` +
    `【最近几轮对话历史（已压缩）】：\n${historyStr || '（无历史对话）'}\n\n` +
    `【用户当前问题】：${q}\n`

  let rewritten = false
  let reason = ''
  let extraQueries = []
  try {
    extraQueries = await gate.run(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await streamText({
          model: getChatModel(),
          temperature: 0,
          prompt,
          abortSignal: controller.signal,
        })
        // 硬超时兜底：AI SDK 的 result.text 在 abort / 流中断时可能永远 pending，
        // 只靠 AbortController 无法保证 Promise 落地（实测会永久挂起整个检索链路）。
        // 用 race 强制在 timeoutMs 后降级为空串，绝不阻塞主链路。
        const raw = await Promise.race([
          Promise.resolve(result.text).catch(() => ''),
          new Promise((resolve) => setTimeout(() => resolve(''), timeoutMs)),
        ])
        if (!raw) return []
        const parsed = JSON.parse(stripToJson(raw))
        if (!Array.isArray(parsed)) return []
        const filtered = parsed
          .map((x) => (typeof x === 'string' ? x.trim() : ''))
          .filter((t) => _isValidQuery(t, { minChars: cfg.minQueryChars, maxChars: cfg.maxQueryChars }))
          .slice(0, queriesPer)
        // 去重（大小写不敏感）
        const seen = new Set()
        return filtered.filter((t) => {
          const k2 = t.toLowerCase(); if (seen.has(k2)) return false; seen.add(k2); return true
        })
      } catch (err) {
        reason = err.name === 'AbortError' ? 'timeout' : err.message
        return []
      } finally {
        clearTimeout(timer)
      }
    })
  } catch (err) {
    reason = reason || err.message
  }

  // 5) 最终合并：queries[0] = 原始 query（保证主检索路径永远存在）+ 改写的补充 query（去重）
  const final = [q]
  const seen = new Set([q.toLowerCase()])
  for (const eq of extraQueries) {
    const k2 = eq.toLowerCase()
    if (seen.has(k2)) continue
    seen.add(k2); final.push(eq)
    if (final.length >= queriesPer) break
  }
  rewritten = final.length > 1
  const out = { queries: final, rewritten, reason: reason || (rewritten ? 'ok' : 'rewrite_empty') }
  _cache.set(k, out)
  return out
}
