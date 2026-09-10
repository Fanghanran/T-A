import { Buffer } from 'node:buffer'
import * as store from './vectorStore.js'
import * as questionBank from './questionBank.js'
import * as esStore from './esStore.js'
import { embedTexts } from './embed.js'
import { rewrite } from './queryRewriter.js'
import { hypothesize } from './hyde.js'
import { queryRewriterConfig, hydeConfig, esConfig } from './config.js'
import { incr, observe } from './metrics.js'
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
 * HyDE 假设答案命中的权重：假设答案是 LLM 猜出来的间接匹配（比 question 锚点
 * 还多隔一层「LLM 对答案的想象」），再降一档，避免颠覆首轮排序。
 */
const HYDE_WEIGHT = Number(process.env.HYDE_WEIGHT ?? 0.8)

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
async function _searchOneQueryKB(query, { overK, topK, ownerId }) {
  if (typeof query !== 'string' || !query.trim()) return []
  const [qv] = await embedTexts([query])
  if (!qv || !qv.length) return []

  const [textHits, questionHits] = await Promise.all([
    store.search(qv, { topK: overK, field: 'text', ownerId }).catch(() => []),
    store.search(qv, { topK: overK, field: 'question', ownerId }).catch(() => []),
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
  const metricsT0 = performance.now()
  const scope = ['question', 'knowledge', 'all'].includes(opts.scope) ? opts.scope : 'all'
  const topK = Math.max(1, Math.min(20, Number(opts.topK) || 5))
  const history = Array.isArray(opts.history) ? opts.history : []
  // 并发闸门分片键（智能体 id），并行时保证各智能体公平占用改写并发（ADR-008）
  const caller = typeof opts.caller === 'string' && opts.caller.trim() ? opts.caller.trim() : ''
  // M5a：检索按用户隔离（owner 过滤下推到 Milvus）
  const ownerId = typeof opts.ownerId === 'string' && opts.ownerId ? opts.ownerId : ''

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
              return await _searchOneQueryKB(query, { overK, topK, ownerId })
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

        // 4.4) ES BM25 关键词召回（第三通道，2026-09-07 引入）：
        //  纯向量对「精确术语出现在语义不相干块」有结构性盲区——目标块进不了向量
        //  top-50 候选池，2-gram 池内加权救不回（评估案例 vectorStore/SQLite 等）。
        //  ES 走倒排索引独立召回：term 直查不依赖 embedding 相似度，与向量互补。
        //  只用原始 q（关键词意图就是原词，改写 query 反而稀释）。
        //  融合规则（BM25 分数无界，先集合内归一化 s = score/maxScore ∈ (0,1]）：
        //    仅 ES 命中        → s × KEYWORD_WEIGHT（间接匹配降档，与锚点同级）
        //    向量 + ES 双命中  → max(向量分, s×W, avg×(1+BOTH_HIT_BONUS))——双通道认可强信号
        //  ES 命中块的 item 需从内存镜像补齐 payload（ES 只存文本元数据不取向量）。
        let esInfo = null
        if (esConfig.esEnabled && q) {
          const esT0 = performance.now()
          const { hits, degraded } = await esStore.search(q, {
            topK: esConfig.esTopK,
            category,
            tag,
            ownerId,
          })
          const esMs = Math.round(performance.now() - esT0)
          const esById = new Map() // 仅 ES 命中的块（向量池没有，需补 payload 入池）
          if (hits.length) {
            const maxScore = Math.max(...hits.map((h) => h.score)) || 1
            for (const h of hits) {
              const s = (h.score / maxScore) * esConfig.keywordWeight
              const exist = arr.find((x) => x.item.id === h.id)
              if (exist) {
                // 双通道命中：平均后小幅加成（与双向量融合同款语义）
                const avg = (exist.score + s) / 2
                exist.score = Math.max(exist.score, s, avg * (1 + BOTH_HIT_BONUS))
              } else {
                // 仅 ES 命中：从内存镜像补齐 payload（无向量字段的完整元数据）；
                // snippet 与 milvus search 路口径一致（前 240 字，4.6 去重键依赖它）
                const full = store.getChunkById(h.id, ownerId)
                if (full)
                  esById.set(h.id, {
                    item: { ...full, snippet: (full.text ?? '').slice(0, 240), score: s },
                    score: s,
                  })
              }
            }
            if (esById.size) arr.push(...esById.values())
            arr.sort((a, b) => b.score - a.score)
          }
          esInfo = { hits: hits.length, added: esById?.size ?? 0, degraded, ms: esMs }
        }

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

        // 4.55) HyDE 级联触发（2026-09-06）：首轮（含 2-gram 加权）top1 分数低于阈值 →
        //  LLM 生成假设答案 → 答案向量查 text 路（假设答案与库内正文同为陈述句语体，
        //  补「问句 vs 陈述句」的语体差）→ 融合进候选池重新排序。
        //  级联的意义：多数查询 top1 达标 → 完全跳过，零额外延迟；只有难查询多花一次 LLM。
        let hydeInfo = null
        const topScore = boosted.length ? Number(boosted[0].score) || 0 : 0
        if (hydeConfig.hydeEnabled !== false && topScore < hydeConfig.minScore) {
          incr('hyde_evaluations') // 低分候选进入 HyDE 判定（触发率分母）
          const hydeT0 = performance.now()
          const hyp = await hypothesize(q) // 超时/开关关/LLM 不可用 → null，绝不抛错
          if (hyp) {
            try {
              // 假设答案 embed（能力不可用等结构性错误按 ADR-009 穿透提醒）
              const [hv] = await embedTexts([hyp.text])
              if (Array.isArray(hv) && hv.length > 0) {
                const hydeHits = await store
                  .search(hv, { topK: overK, field: 'text', ownerId })
                  .catch(() => [])
                // 融合规则：命中分 × HYDE_WEIGHT（间接匹配降档）；同样适用 2-gram 字面加权；
                // 与首轮同 id 命中取 max（两轮都认可 = 强信号）；category/tag 过滤口径与首轮一致
                const existing = new Map(boosted.map((x) => [x.item.id, x]))
                let added = 0
                for (const it of hydeHits) {
                  if (!it?.id) continue
                  if (category && it.category !== category) continue
                  if (tag && !(Array.isArray(it.tags) && it.tags.includes(tag))) continue
                  let final = Math.min(1, (Number(it.score) || 0) * HYDE_WEIGHT)
                  if (qGrams.size) {
                    const sNorm = normKey(it.text || it.snippet)
                    if (sNorm) {
                      const sGrams = new Set()
                      for (let i = 0; i < sNorm.length - 1; i++) sGrams.add(sNorm.slice(i, i + 2))
                      let hit = 0
                      for (const g of qGrams) if (sGrams.has(g)) hit++
                      const cov = hit / qGrams.size
                      if (cov > 0) final = Math.min(1, final + 0.2 * cov)
                    }
                  }
                  const exist = existing.get(it.id)
                  if (exist) {
                    exist.score = Math.max(exist.score, final)
                  } else {
                    boosted.push({ item: it, score: final })
                    existing.set(it.id, boosted[boosted.length - 1])
                    added++
                  }
                }
                boosted.sort((a, b) => b.score - a.score)
                hydeInfo = {
                  triggered: true,
                  source: hyp.source,
                  reason: `top1=${topScore.toFixed(4)} < ${hydeConfig.minScore}`,
                  added,
                  ms: Math.round(performance.now() - hydeT0),
                }
                incr('hyde_triggered', { source: hyp.source })
                log.info(`[unifiedSearch] HyDE 触发（${hydeInfo.reason}）：新增 ${added} 条候选`)
              } else {
                incr('hyde_retrieval_failed') // 假设答案 embed 为空，增强轮未生效
                hydeInfo = { triggered: false, reason: 'embed_empty', ms: Math.round(performance.now() - hydeT0) }
              }
            } catch (err) {
              if (err instanceof AppError) throw err // 能力不可用等结构性错误必须穿透提醒
              // HyDE 检索侧异常：增强轮失败保留首轮结果（warn 记录，非静默）
              incr('hyde_retrieval_failed')
              log.warn(`[unifiedSearch] HyDE 二次检索异常：${err.message}`)
              hydeInfo = { triggered: false, reason: err.message, ms: Math.round(performance.now() - hydeT0) }
            }
          } else {
            incr('hyde_generate_failed') // 假设答案生成不可用（超时/LLM 异常/开关关）
            hydeInfo = { triggered: false, reason: 'generate_failed', ms: Math.round(performance.now() - hydeT0) }
          }
        }

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
          // HyDE 级联调试信息：null = 未触发（top1 达标或开关关闭）；触发时含 added/ms/reason
          hyde: hydeInfo,
          // ES 关键词通道调试信息：null = 未启用或无原始 q；degraded = ES 不可用（带标注降级）
          es: esInfo,
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

  // 检索延迟指标（全程含改写/HyDE 增强轮，与路由层 searchMs 同口径）
  incr('search_total', { scope })
  observe('search_latency_ms', Math.round(performance.now() - metricsT0), { scope })

  return {
    scope,
    topK,
    questionResults,
    knowledgeResults,
  }
}

export default unifiedSearch
