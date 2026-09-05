import { Buffer } from 'node:buffer'
import * as store from './vectorStore.js'
import * as questionBank from './questionBank.js'
import { embedTexts } from './embed.js'
import { rewrite } from './queryRewriter.js'
import { queryRewriterConfig } from './config.js'
import { childLogger } from './logger.js'
import { AppError } from './errors.js'

const log = childLogger('unifiedSearch')

/**
 * 检索锚点命中相对正文命中的权重。
 * 锚点是「这块内容会被问成什么样的问题」，属间接匹配，略低于正文直接匹配。
 */
const QUESTION_WEIGHT = Number(process.env.QUESTION_VECTOR_WEIGHT ?? 0.9)
/**
 * 双路同时命中的加成系数：既语义相关、又是该切片的典型提问，强信号。
 * 取值需保守 —— 早期用 0.5 会让双路命中分数直接顶到 1.0 饱和，三条结果同分、排序失效。
 */
const BOTH_HIT_BONUS = Number(process.env.BOTH_HIT_BONUS ?? 0.15)

/**
 * 单 query KB 检索 helper（双路召回：正文向量 + 检索锚点向量）
 *
 * - 过采样 overK 条（避免早期 category/tag 过滤 + 后续多 query 合并漏分）
 * - 不传 category/tag 给 store.search，等合并完再统一过滤，保证同 chunk 多 query 命中的分数都累加
 * - 融合规则（qt = q × QUESTION_WEIGHT）：
 *     仅正文命中   → t
 *     仅锚点命中   → qt
 *     双路命中     → max(t, qt, ((t + qt) / 2) × (1 + BOTH_HIT_BONUS))
 *   用「平均后小幅加成」而非累加，保证：① 双路命中一定不低于任一路单命中；
 *   ② 分数不会顶到 1.0 饱和（累加会让多条结果同分，排序失效）。
 */
async function _searchOneQueryKB(query, { overK, topK }) {
  if (typeof query !== 'string' || !query.trim()) return []
  const [qv] = await embedTexts([query])
  if (!qv || !qv.length) return []

  const [textHits, questionHits] = await Promise.all([
    store.search(qv, { topK: overK, field: 'text' }).catch(() => []),
    store.search(qv, { topK: overK, field: 'question' }).catch(() => []),
  ])

  const merged = new Map()
  for (const it of textHits) {
    if (!it?.id) continue
    merged.set(it.id, { item: it, score: Number(it.score) || 0 })
  }
  for (const it of questionHits) {
    if (!it?.id) continue
    const qs = (Number(it.score) || 0) * QUESTION_WEIGHT
    const exist = merged.get(it.id)
    if (!exist) {
      merged.set(it.id, { item: it, score: qs })
      continue
    }
    // question 路返回的 item 字段与 text 路一致，保留 text 路的 payload（首次写入的那条）
    const avg = (exist.score + qs) / 2
    exist.score = Math.max(exist.score, qs, avg * (1 + BOTH_HIT_BONUS))
  }

  return [...merged.values()].map(({ item, score }) => ({
    ...item,
    score: Math.max(0, Math.min(1, score)),
  }))
}

/**
 * unifiedSearch —— 统一知识检索入口（结构化题库 + 知识库向量）
 *
 * 设计原则：
 *   1. 任一数据源失败只降级自己，不影响另一个（Promise.allSettled + 错误隔离）
 *   2. 阶段 2：KB 分支支持 query 改写（多 query 互补检索 + 分数加权合并 + category/tag 最后统一过滤）
 *   3. 函数式纯返回数据，不负责拼 SSE annotation（annotation 归 llm.js prependAnnotation）
 *
 * @param {Object}   opts
 * @param {string}   opts.q                   自然语言查询（必填）
 * @param {'question'|'knowledge'|'all'} [opts.scope='all']
 * @param {string[]} [opts.techStack=[]]      面试题检索过滤
 * @param {string}   [opts.category]          同时传给两个数据源的分类过滤
 * @param {string}   [opts.tag]               同时传给两个数据源的标签过滤（questionBank 是 tag 字段，KB 是 tags 含 tag）
 * @param {number}   [opts.topK=5]            每个数据源独立 topK（[1,20]）
 * @param {string}   [opts.difficulty]        仅面试题有效
 * @param {string}   [opts.company]           仅面试题有效
 * @param {Array<{role:string,content:string}>} [opts.history] 多轮对话（Query 改写用；阶段 2 新增）
 * @returns {Promise<{
 *   scope: string, topK: number,
 *   questionResults: {total:number, searchMs:number, items:any[]} | null,
 *   knowledgeResults:{total:number, searchMs:number, items:any[], rewritten?:boolean, queries?:string[]} | null,
 * }>}
 */
export async function unifiedSearch(opts = {}) {
  const q = opts?.q ?? ''
  const scope = ['question', 'knowledge', 'all'].includes(opts.scope) ? opts.scope : 'all'
  const topK = Math.max(1, Math.min(20, Number(opts.topK) || 5))
  const history = Array.isArray(opts.history) ? opts.history : []
  // 并发闸门分片键（智能体 id），并行时保证各智能体公平占用改写并发（ADR-008）
  const caller = typeof opts.caller === 'string' && opts.caller.trim() ? opts.caller.trim() : ''

  const needQB = scope === 'all' || scope === 'question'
  const needKB = scope === 'all' || scope === 'knowledge'

  // —— 面试题：同步 search，包一层 Promise.allSettled 的错误隔离
  const qbTask = needQB
    ? Promise.resolve().then(async () => {
        const t0 = performance.now()
        const items = questionBank.search(q, {
          techStack: Array.isArray(opts.techStack) ? opts.techStack : [],
          category: opts.category || undefined,
          difficulty: opts.difficulty || undefined,
          company: opts.company || undefined,
          tag: opts.tag || undefined,
          limit: topK,
        })
        return { total: items.length, searchMs: Math.round(performance.now() - t0), items }
      })
    : null

  // —— 知识库：阶段 2：query 改写 → 多 query 并行检索 → 按 chunk.id 合并分数（乘 queryWeights）→ category/tag 最后统一过滤
  const kbTask = needKB
    ? Promise.resolve().then(async () => {
        const t0 = performance.now()
        const weights = Array.isArray(queryRewriterConfig?.queryWeights) && queryRewriterConfig.queryWeights.length > 0
          ? queryRewriterConfig.queryWeights
          : [1, 0.8, 0.6]
        const overK = Math.max(topK * 10, 50)
        // 分段计时：此前 t0 起点在 rewrite() 之前，searchMs 实为「改写 + 检索」合并耗时，
        // 无法回答「改写到底值不值」这个设计问题。改为分别计时。

        // 1) Query 改写（永不抛，内部超时/超限直接降级 [q]）
        let rewriteRes
        const rwStart = performance.now()
        try {
          rewriteRes = await rewrite(q, history, {}, caller)
        } catch (err) {
          log.warn(`[unifiedSearch] rewrite 异常，降级单 query：${err.message}`)
          rewriteRes = { queries: q ? [q] : [], rewritten: false, reason: 'rewrite_throw' }
        }
        const rewriteMs = Math.round(performance.now() - rwStart)

        const queries = Array.isArray(rewriteRes.queries) && rewriteRes.queries.length > 0 ? rewriteRes.queries : (q ? [q] : [])
        if (queries.length === 0) {
          return {
            total: 0, searchMs: 0, rewriteMs, totalMs: Math.round(performance.now() - t0),
            items: [], rewritten: false, queries: [],
          }
        }

        // 2) 多 query 并行检索（单 query 抛错返回 []，不影响其他 query）
        const seStart = performance.now()
        const perQueryItemsArr = await Promise.all(
          queries.map(async (query, qi) => {
            try {
              return await _searchOneQueryKB(query, { overK, topK })
            } catch (err) {
              if (err instanceof AppError) throw err // 能力不可用等结构性错误必须穿透提醒
              log.warn(`[unifiedSearch] KB query[${qi}] 检索失败：${err.message}，丢弃`)
              return []
            }
          }),
        )
        const searchMs = Math.round(performance.now() - seStart)

        // 3) 合并：按 chunk.id 做 Map，score = Σ(item.score * weight[qi])；保留 item 最高分对应的 payload
        const merged = new Map() // id -> { item, score }
        for (let qi = 0; qi < perQueryItemsArr.length; qi++) {
          const weight = Number(weights[qi % weights.length]) || 0
          const list = perQueryItemsArr[qi] || []
          for (const it of list) {
            if (!it?.id) continue
            const added = (Number(it.score) || 0) * weight
            const exist = merged.get(it.id)
            if (!exist) {
              merged.set(it.id, { item: it, score: added })
              continue
            }
            exist.score += added
            // 保留更全面的 item 字段（其实每个 query 检索返回的 item 字段口径一致，无所谓）
          }
        }

        // 4) 最后统一做 category/tag 过滤（保证合并分数完整）+ 按 score 降序取 topK
        const category = typeof opts.category === 'string' && opts.category.trim() ? opts.category.trim() : ''
        const tag = typeof opts.tag === 'string' && opts.tag.trim() ? opts.tag.trim() : ''
        let arr = [...merged.values()]
        if (category || tag) {
          arr = arr.filter(({ item }) => {
            if (category && item.category !== category) return false
            if (tag && !(Array.isArray(item.tags) && item.tags.includes(tag))) return false
            return true
          })
        }
        arr.sort((a, b) => b.score - a.score)

        // 4.5) 关键词混合加权（CJK 2-gram 覆盖率，2026-09-03「还招外卖员吗」案例）：
        //  纯向量对口语短查询不稳——语义分虚高的讲义同质块（44%）压住字面精确命中的
        //  FAQ 块。用「原始 q 的 2-gram 被片段覆盖的比例 ×0.2」加分：
        //    - 覆盖率 1 = 片段几乎逐字含着用户问句（强字面命中）→ +0.2；
        //    - 讲义块 0 覆盖 → 不加分。
        //  必须在 4.6 去重/配额**之前**做：字面命中的低语义分块才有机会存活进 topK。
        //  只用原始 q（不含改写 query）；加分封顶 +0.2，避免颠覆语义排序。
        const normKey = (s) =>
          String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 400)
        const qNorm = normKey(q)
        const qGrams = new Set()
        for (let i = 0; i < qNorm.length - 1; i++) qGrams.add(qNorm.slice(i, i + 2))
        const boosted = qGrams.size
          ? arr.map(({ item, score }) => {
              // 用全文匹配（snippet 只截前 240 字，目标 Q&A 常在其后）
              const sNorm = normKey(item.text || item.snippet)
              let cov = 0
              if (sNorm) {
                const sGrams = new Set()
                for (let i = 0; i < sNorm.length - 1; i++) sGrams.add(sNorm.slice(i, i + 2))
                let hit = 0
                for (const g of qGrams) if (sGrams.has(g)) hit++
                cov = hit / qGrams.size
              }
              return cov > 0
                ? { item, score: Math.min(1, score + 0.2 * cov) }
                : { item, score }
            })
          : arr
        boosted.sort((a, b) => b.score - a.score)

        // 4.6) 近重复折叠 + 单文档配额：同一大文档互相近似的切片（讲义逐页同质段）
        //  会霸占 topK。规则：① snippet 归一化前 64 字作近似键，同键留最高分；
        //  ② 单 docId 最多 3 条（多样性，给其他文档让位）。
        const kept = []
        const seenKey = new Set()
        const perDocCount = new Map()
        const MAX_PER_DOC = 3
        for (const { item, score } of boosted) {
          const key = normKey(item.snippet).slice(0, 64) || `id:${item.id}`
          if (key && seenKey.has(key)) continue
          const docId = item.docId || item.id
          const cnt = perDocCount.get(docId) || 0
          if (cnt >= MAX_PER_DOC) continue
          if (key) seenKey.add(key)
          perDocCount.set(docId, cnt + 1)
          kept.push({ item, score })
        }

        const finalItems = kept.slice(0, topK).map(({ item, score }) => ({
          ...item,
          // 最终 score 归一化：多 query 累加可能 > 1，截断回 [0,1]；保留 4 位小数
          score: Number(Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0)).toFixed(4)),
        }))

        return {
          total: finalItems.length,
          searchMs, // 纯检索耗时（此前含改写，无法评估改写收益）
          rewriteMs, // 改写单独计时
          totalMs: Math.round(performance.now() - t0),
          items: finalItems,
          rewritten: Boolean(rewriteRes.rewritten),
          queries, // 调试信息（传给前端面板可展示 —— 但当前前端没消费，未来可加 chip 展示"实际检索的 queries"）
        }
      })
    : null

  // 并发：allSettled 即使一边抛错另一边也能拿到值
  const [qbSettled, kbSettled] = await Promise.allSettled([
    qbTask ?? Promise.resolve(null),
    kbTask ?? Promise.resolve(null),
  ])

  const questionResults = !needQB
    ? null
    : qbSettled.status === 'fulfilled'
      ? qbSettled.value
      : (() => {
          log.warn({ details: qbSettled.reason?.message }, '[unifiedSearch] questionBank 检索异常（降级为空）')
          return { total: 0, searchMs: 0, items: [] }
        })()

  const knowledgeResults = !needKB
    ? null
    : kbSettled.status === 'fulfilled'
      ? kbSettled.value
      : (() => {
          log.warn({ details: kbSettled.reason?.message }, '[unifiedSearch] knowledge 检索异常（降级为空）')
          return { total: 0, searchMs: 0, items: [] }
        })()

  return {
    scope,
    topK,
    questionResults,
    knowledgeResults,
  }
}

export default unifiedSearch
