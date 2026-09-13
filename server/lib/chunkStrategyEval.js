/**
 * chunkStrategyEval —— 多策略试切评测器（M：试切测量路线，L2 算法层）
 *
 * 设计原则：切片方式不做主观判断，做客观测量——
 *  同一篇文档并行试切 N 种候选策略（纯 chunker 本地计算，毫秒级），
 *  用纯文本统计指标给每种切法打分，综合得分最高者为推荐。
 *  指标全部可解释、可展示给用户；推荐只是预填，预览/表单随时可手动覆盖。
 *
 * 指标（全部零模型依赖，字符 2-gram 统计）：
 *  uniformity  块长均匀度：1 − 变异系数。切片大小分布越可预测越高。
 *  boundary    边界对齐度：1 − 内部边界的 2-gram Jaccard 均值。切分点前后
 *              内容重叠越少 = 边界恰好落在话题转换处 = 边界越"对"。
 *  cohesion    块内内聚度：块内前半与后半的 2-gram Jaccard 均值。块内越自洽越高。
 *  sizeFit     粒度合理度：块均长过碎（<80 字）或过粗（>1600 字）衰减。
 *
 * 综合分 = 0.40×boundary + 0.25×cohesion + 0.20×uniformity + 0.15×sizeFit
 * （单块文档无边界指标时，其余三项按权重归一。）
 */

import { splitDocumentIntoChunks } from './chunker.js'

/** 去空白与标点后取字符 2-gram 集合（中文友好：字级 bigram） */
function gramSet(s, window = 400) {
  const norm = String(s ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, window)
  const set = new Set()
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2))
  return set
}

/** 2-gram Jaccard 相似度（两集合交集/并集；空集按 0 处理） */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return inter / (a.size + b.size - inter)
}

/** 数值钳制到 [0,1] */
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))

/** 块长均匀度（变异系数的补） */
function uniformityOf(lens) {
  const n = lens.length
  if (!n) return 0
  const mean = lens.reduce((s, x) => s + x, 0) / n
  if (mean <= 0) return 0
  const std = Math.sqrt(lens.reduce((s, x) => s + (x - mean) ** 2, 0) / n)
  return clamp01(1 - std / mean)
}

/** 粒度合理度：块均长过碎/过粗衰减（80~1600 字为理想区间） */
function sizeFitOf(avgLen) {
  if (!avgLen) return 0
  if (avgLen < 80) return clamp01(avgLen / 80)
  if (avgLen > 1600) return clamp01(1600 / avgLen)
  return 1
}

/** 单一策略的完整测量 */
async function measureOne(text, cand) {
  const params = {
    strategy: cand.strategy,
    ...(cand.delimiter ? { delimiter: cand.delimiter } : {}),
    ...(cand.maxChars ? { config: { maxChars: cand.maxChars } } : {}),
    ...(cand.overlapChars != null ? { overlapChars: cand.overlapChars } : {}),
  }
  const { chunks } = await splitDocumentIntoChunks(text, params)
  const lens = chunks.map((c) => String(c.text ?? '').length)
  const uniformity = uniformityOf(lens)
  const avgLen = lens.length ? Math.round(lens.reduce((s, x) => s + x, 0) / lens.length) : 0

  // 边界对齐度：内部边界（前块尾窗 vs 后块头窗）的 2-gram Jaccard 取补
  let boundary = null
  if (chunks.length >= 2) {
    const W = 120
    const js = []
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = String(chunks[i].text ?? '').slice(-W)
      const head = String(chunks[i + 1].text ?? '').slice(0, W)
      js.push(jaccard(gramSet(tail), gramSet(head)))
    }
    boundary = clamp01(1 - js.reduce((s, x) => s + x, 0) / js.length)
  }

  // 块内内聚度：块内前半 vs 后半的 2-gram Jaccard 均值（跳过过短块）
  const coh = []
  for (const c of chunks) {
    const t = String(c.text ?? '')
    if (t.length < 160) continue
    const half = Math.floor(t.length / 2)
    coh.push(jaccard(gramSet(t.slice(0, half)), gramSet(t.slice(half))))
  }
  const cohesion = coh.length ? coh.reduce((s, x) => s + x, 0) / coh.length : null

  const sizeFit = sizeFitOf(avgLen)
  return { chunks, params, count: chunks.length, avgLen, uniformity, boundary, cohesion, sizeFit }
}

/** 综合得分（boundary 缺失时其余权重归一） */
function scoreOf(m) {
  const w = { boundary: 0.4, cohesion: 0.25, uniformity: 0.2, sizeFit: 0.15 }
  let score = 0
  let total = 0
  for (const [k, weight] of Object.entries(w)) {
    const v = m[k]
    if (v === null || v === undefined) continue
    score += weight * v
    total += weight
  }
  return total ? score / total : 0
}

/**
 * 多策略试切评测（对外 API）。
 *
 * 推荐口径（2026-09-13 实测修正）：指标能可靠地在**同一策略族内**选参数
 * （如 delimiter 下 maxChars 挑均匀度最好的），但跨策略族择优不可靠——
 * 均匀度天然偏向 semantic 大块，而问答体细切的块长不均恰恰是贴合自然单元。
 * 因此策略族由**结构检测**决定（opts.hasQa → delimiter 细切，否则 semantic），
 * 指标只在族内择优；两组最优都透出供对比。
 *
 * @param {string} text 文档全文
 * @param {{candidates?: Array<object>, minText?: number, hasQa?: boolean}} [opts]
 *        hasQa：调用方（analyzeDocFeatures）的结构判定——问答体文档传 true
 * @returns {{ evaluated: Array<object>, recommended: object, bestOverall: object,
 *             reason: string, shortText: boolean }}
 */
export async function evalChunkStrategies(text, opts = {}) {
  const safe = typeof text === 'string' ? text : ''
  const minText = opts.minText ?? 300
  const fallback = {
    strategy: 'semantic',
    params: {},
    count: 0,
    avgLen: 0,
    uniformity: null,
    boundary: null,
    cohesion: null,
    sizeFit: null,
    score: 0,
    chunks: [],
  }
  if (safe.trim().length < minText) {
    return { evaluated: [fallback], recommended: fallback, reason: '文档过短，无需策略选择（默认语义切片）', shortText: true }
  }

  const candidates = opts.candidates ?? [
    { strategy: 'semantic', maxChars: 1000 },
    { strategy: 'semantic', maxChars: 600 },
    { strategy: 'delimiter', delimiter: '\n\n', maxChars: 800 },
    { strategy: 'delimiter', delimiter: '\n', maxChars: 800 },
  ]

  const evaluated = await Promise.all(candidates.map(async (cand) => {
    const m = await measureOne(safe, cand)
    const label = cand.strategy === 'delimiter' ? `delimiter(${JSON.stringify(cand.delimiter)})` : `semantic(${cand.maxChars})`
    return { strategy: cand.strategy, label, params: cand, ...m, score: scoreOf(m) }
  }))

  // 族内择优：同分（差 < 0.02）取块均长更接近理想区间中位者（信息密度更完整）
  evaluated.sort((a, b) => b.score - a.score || Math.abs(b.avgLen - 840) - Math.abs(a.avgLen - 840))
  const best = evaluated[0]

  // 策略族判定：问答体 → delimiter 细切（一问一答一片，FAQ 检索精确命中）；否则 semantic
  const family = opts.hasQa ? 'delimiter' : 'semantic'
  // 族内择优：更长分隔符优先（双换行的段落级边界比单换行的行级边界
  // 更不破坏语义单元，行级会把问/答拆成两片）——同分隔符下再按指标选 maxChars。
  const familyCands = evaluated
    .filter((e) => e.strategy === family)
    .sort(
      (a, b) =>
        (b.params.delimiter?.length ?? 0) - (a.params.delimiter?.length ?? 0) ||
        b.score - a.score,
    )
  const recommended = familyCands[0] ?? best
  const close = best !== recommended && best.score - recommended.score < 0.02
  const familyNote = recommended === best
    ? ''
    : `（结构判定${opts.hasQa ? '问答体' : '连续文本'} → 推荐 ${recommended.label}；纯指标最优为 ${best.label}，供对比）`
  const reason =
    `多策略试切评测：推荐 ${recommended.label}（${recommended.count} 块 / 均长 ${recommended.avgLen}）—— ` +
    `边界对齐 ${recommended.boundary == null ? '—' : recommended.boundary.toFixed(2)}、内聚 ${
      recommended.cohesion == null ? '—' : recommended.cohesion.toFixed(2)
    }、均匀 ${recommended.uniformity.toFixed(2)}` + familyNote

  return { evaluated, recommended, bestOverall: best, reason, shortText: false }
}
