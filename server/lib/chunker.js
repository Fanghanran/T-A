/**
 * chunker —— 三层语义切片器（对应 docs/切片策略优化计划.md）
 *
 * **策略**：格式无关、语义感知、零成本上下文扩展。
 *
 *            原始文档
 *               │
 *               ▼ 第一层：结构化递归切片（规则，0ms）
 *                  Markdown 标题 → 段落（双换行）→ 句子（。！？.!? 或 Intl.Segmenter）
 *                  逐层降级；每层若单元 ≤ maxChars 则保留，> maxChars 降级到下一层。
 *               │
 *               ▼ 第二层：对仍超限的块做语义细切（Embedding 余弦相似度断点）
 *                  句子分割 → 句子向量计算（embedSentences，失败降级 hash）
 *                  → 相邻相似度统计断点（mean - K·std，兜底 minSimilarity）
 *                  → 过短块向上合并（≥ minChars 才独立）。
 *               │
 *               ▼ 上下文扩展（零成本）
 *                  preContext  = 前一个 chunk 末几句
 *                  postContext = 后一个 chunk 开头几句
 *               │
 *               ▼ （可选，由 index.js 上传流程调用）LLM 批量生成 topic + 预生成 questions
 *
 * **对外 API**：
 *   splitIntoChunks(text, opts?)
 *     —— 旧接口，兼容原调用点（只返回 [{idx, heading, text}]）。
 *        内部走新三层切片，但 meta 信息丢弃，保持 100% 兼容 updateContent 兜底。
 *
 *   splitDocumentIntoChunks(text, opts?)
 *     —— 新接口，返回 { chunks: [...], sentenceVectors: [...], sentences: [...] }。
 *        每个 chunk 包含：{idx, heading, text, sentenceIndices:[start,end)}
 *        上传链路用这个接口，句子向量可复用来做：
 *          - semanticSplit 断点
 *          - 最终 chunk 向量 = 句子向量平均（零成本，不重 embed）
 *          - 后续 questions/topic 标注时的句子级摘要
 *
 *   attachContext(chunks)  —— 给 chunk 列表补 preContext/postContext（零成本）。
 *
 *   mergeShortChunks(chunks, minChars)  —— 合并过短 chunk 到上一个（兜底 minChars）。
 *
 *   enforceHardMax(chunks, hardMax, absoluteMax)  —— 强制硬切（表格/代码块兜底）。
 *
 *   句子切分：优先用 Intl.Segmenter('zh-CN')，Node 16+ 原生，零依赖。
 */

import { chunkerConfig } from './config.js'
import { cosineSimilarity } from './mathUtils.js'

/* ===================== 句子切分 ===================== */

let _segmenter = null
function getSentenceSegmenter() {
  if (_segmenter) return _segmenter
  try {
    _segmenter = new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
    return _segmenter
  } catch {
    _segmenter = null
    return null
  }
}

function splitSentencesNative(text) {
  const seg = getSentenceSegmenter()
  if (!seg) return []
  const out = []
  for (const part of seg.segment(text)) {
    const s = (part?.segment ?? '').trim()
    if (s) out.push(s)
  }
  return out
}

const FALLBACK_SENT_RE = /(?<=[。！？.!?])\s*(?=\S)/g

function splitSentencesFallback(text) {
  if (!text) return []
  const parts = text.split(FALLBACK_SENT_RE)
  return parts.map((s) => s.trim()).filter(Boolean)
}

/**
 * 切句子：优先 Intl.Segmenter，失败降级正则。
 * 注意：正则对 "e.g. / U.S.A." 会误切，但这是兜底路径。
 * @returns {string[]}
 */
export function splitSentences(text) {
  const safe = typeof text === 'string' ? text : ''
  if (!safe) return []
  const native = splitSentencesNative(safe)
  if (native.length > 0) return native
  return splitSentencesFallback(safe)
}

/* ===================== 第一层：结构化递归切片 ===================== */

/**
 * 按 Markdown 标题切（不解析 heading 内容，只作为分隔符）。
 * 返回带 heading 的段落片段：{ heading, text }[]
 */
function splitByHeadings(text) {
  const lines = (text ?? '').split(/\r?\n/)
  const blocks = []
  let heading = ''
  let buf = []
  const flush = () => {
    const t = buf.join('\n').trim()
    if (t) blocks.push({ heading, text: t })
    buf = []
  }
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      flush()
      heading = m[2].trim()
      buf.push(line)
      continue
    }
    buf.push(line)
  }
  flush()
  return blocks
}

/**
 * 第一层：递归切片。
 * 规则：标题 → 段落(双换行) → 句子；每一级都检查长度，超限降级。
 *
 * @param {string} text
 * @param {import('./config.js').chunkerConfig} cfg
 * @returns {Array<{heading:string, text:string}>}
 */
function recursiveSplit(text, cfg) {
  const headingBlocks = splitByHeadings(text)
  const out = []
  for (const hb of headingBlocks) {
    const heading = hb.heading
    if (hb.text.length <= cfg.maxChars) {
      out.push({ heading, text: hb.text })
      continue
    }
    // 按段落切（双换行）
    const paragraphs = hb.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    let buf = ''
    const flushBuf = () => {
      const t = buf.trim()
      if (t) out.push({ heading, text: t })
      buf = ''
    }
    for (const p of paragraphs) {
      // 当前 buf + p 不超 maxChars → 合并进 buf（尽量不把一个段落一劈为二）
      if (buf.length + p.length + 2 <= cfg.maxChars) {
        buf = buf ? buf + '\n\n' + p : p
        continue
      }
      // 先把 buf 刷出去
      flushBuf()
      // p 本身就 ≤ maxChars → 独立一块
      if (p.length <= cfg.maxChars) {
        buf = p
        continue
      }
      // 单个段落也超长 → 降级到句子切分
      const sentences = splitSentences(p)
      let sentBuf = ''
      for (const s of sentences) {
        if (sentBuf.length + s.length + 1 <= cfg.maxChars) {
          sentBuf = sentBuf ? sentBuf + ' ' + s : s
          continue
        }
        if (sentBuf) out.push({ heading, text: sentBuf })
        // 单句就超限（例如超长代码行）→ 下面 enforceHardMax 会兜底，这里先整句塞着
        sentBuf = s
      }
      if (sentBuf) buf = sentBuf
    }
    flushBuf()
  }
  return out
}

/* ===================== 自定义分隔符切片（delimiter 模式） ===================== */

/**
 * 按用户输入的分隔符字符串切分文本（不做语义分析、不调 embedding）。
 * - heading：取该段第一行（trim 后），无则用 "第 N 部分"
 * - 若设置了 maxChars 且某段超长，按段落（\n\n）再切；单段仍超长则按句子硬切
 * - overlapChars > 0 时相邻块滑动窗口重叠：后块以前块末尾 N 字符开头（缓解分隔符切断句子的上下文丢失）
 *
 * @param {string} text
 * @param {string} delimiter            非空字符串；空/未传时降级为双换行
 * @param {{maxChars?: number, overlapChars?: number}} [opts] overlapChars 相邻块重叠字符数（0 = 不重叠）
 * @returns {Array<{heading: string, text: string}>}
 */
export function splitByDelimiter(text, delimiter, opts = {}) {
  // 换行符归一化：CRLF(\r\n) / 单独 \r 统一转 \n。
  // 否则 Windows 文档按 '\n\n' 切分时文本里无字量子串，整篇切不开，
  // 只能走超长降级路径按段落合并 —— 多个双换行段落被并进同一块。
  const safe = typeof text === 'string'
    ? text.replace(/\r\n?/g, '\n').replace(/\n[ \t]+\n/g, '\n\n')
    : ''
  // 转义兼容 + 换行归一：用户手输的字面 \n \r \t 还原为控制字符；
  // multipart 表单（浏览器/undici FormData）会把字段值里的 \n 规范化为 \r\n，
  // delimiter 若不与文本同口径归一（\r\n\r\n vs \n\n）将永远匹配不上 → 装箱出大块。
  const rawDelim = typeof delimiter === 'string' && delimiter.length > 0 ? delimiter : '\n\n'
  const delim = rawDelim
    .replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, '\t')
    .replace(/\r\n?/g, '\n')
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : null
  const overlapChars = Number.isFinite(opts.overlapChars)
    ? Math.max(0, Math.floor(opts.overlapChars))
    : 0

  const parts = safe.split(delim)
  const blocks = []
  for (const part of parts) {
    const trimmed = part.replace(/^\s+|\s+$/g, '')
    if (!trimmed) continue
    const firstLine = trimmed.split(/\r?\n/, 1)[0].trim()
    const heading = firstLine || `第 ${blocks.length + 1} 部分`

    if (maxChars && trimmed.length > maxChars) {
      // 超长段：按段落（双换行）合并到 maxChars；单段仍超长则按句子硬切
      const paras = trimmed.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
      let buf = ''
      const flush = () => {
        const t = buf.trim()
        if (t) blocks.push({ heading, text: t })
        buf = ''
      }
      for (const p of paras) {
        if (buf.length + p.length + 2 <= maxChars) {
          buf = buf ? buf + '\n\n' + p : p
          continue
        }
        flush()
        if (p.length <= maxChars) {
          buf = p
          continue
        }
        // 单段也超长 → 按句子硬切（delimiter 模式不做向量，仅保证不腰斩）
        const sentences = splitSentences(p)
        let sbuf = ''
        for (const s of sentences) {
          if (sbuf.length + s.length + 1 <= maxChars) {
            sbuf = sbuf ? sbuf + ' ' + s : s
            continue
          }
          if (sbuf) blocks.push({ heading, text: sbuf.trim() })
          sbuf = s
        }
        buf = sbuf
      }
      flush()
    } else {
      blocks.push({ heading, text: trimmed })
    }
  }

  // 滑动窗口重叠：后块以前块末尾 N 字符开头。
  // 取尾部时用「前块原始文本」（未叠加它自己的前缀），避免重叠链式膨胀；
  // 上限压到前块一半，防止小块被整块重复。
  if (overlapChars > 0 && blocks.length > 1) {
    let prevOriginal = blocks[0].text
    for (let i = 1; i < blocks.length; i++) {
      const curOriginal = blocks[i].text
      const n = Math.min(overlapChars, Math.floor(prevOriginal.length / 2))
      if (n > 0) {
        blocks[i] = { heading: blocks[i].heading, text: prevOriginal.slice(-n) + curOriginal }
      }
      prevOriginal = curOriginal
    }
  }
  return blocks
}

/* ===================== 第二层：语义细切 ===================== */

/**
 * 对单块长文本做语义细切。
 *
 * @param {string} text              长文本（> maxChars）
 * @param {string[]} sentences        整段切句结果
 * @param {number[][]} sentenceVecs   对应 sentences 的向量（embedSentences 返回，长度与 sentences 一致）
 * @param {object} cfg                chunkerConfig
 * @returns {Array<{sentenceRange:[number,number], text:string}>} sentenceRange = [startIdx, endIdx) 左闭右开
 */
function semanticSplitOne(text, sentences, sentenceVecs, cfg) {
  if (sentences.length <= 1) {
    return [{ sentenceRange: [0, sentences.length], text }]
  }
  // 相邻句子相似度
  const sims = []
  for (let i = 1; i < sentences.length; i++) {
    sims.push(cosineSimilarity(sentenceVecs[i - 1], sentenceVecs[i]))
  }
  // 阈值：mean - K*std（若 NaN 则 fallback=minSimilarity）
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length
  const v = sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length
  const std = Math.sqrt(v)
  let threshold = mean - cfg.semanticStdK * std
  if (!Number.isFinite(threshold)) threshold = cfg.semanticMinSimilarity
  threshold = Math.max(threshold, cfg.semanticMinSimilarity)

  // 在相似度 < 阈值处视为断点
  const breakPoints = [0] // 第一个 chunk 从 0 开始
  for (let i = 0; i < sims.length; i++) {
    if (sims[i] < threshold) breakPoints.push(i + 1)
  }
  breakPoints.push(sentences.length)

  // 组装 chunks
  const raw = []
  for (let k = 0; k < breakPoints.length - 1; k++) {
    const s = breakPoints[k]
    const e = breakPoints[k + 1]
    const sub = sentences.slice(s, e)
    raw.push({
      sentenceRange: [s, e],
      text: sub.join(' ').trim(),
    })
  }
  return raw
}

/**
 * 对 recursiveSplit 产出的所有块，挑出仍超过 maxChars 的触发生语义细切。
 *
 * @param {Array<{heading:string, text:string}>} blocks
 * @param {object} cfg chunkerConfig
 * @param {(sentences:string[])=>Promise<number[][]>} embedSentencesFn
 *        传入 embedSentences（或 hashEmbed 降级实现），失败返回空数组时本函数走"句子数平均
 *        硬切"兜底，保证不崩。
 * @returns {Promise<Array<{heading:string, text:string, sentenceRange:[number,number], absoluteSentenceStart:number}>>}
 */
async function semanticSplitBlocks(blocks, cfg, embedSentencesFn) {
  const out = []
  let absSentStart = 0
  for (const b of blocks) {
    if (b.text.length <= cfg.maxChars) {
      const sens = splitSentences(b.text)
      out.push({
        heading: b.heading,
        text: b.text,
        sentenceRange: [0, sens.length],
        absoluteSentenceStart: absSentStart,
        _sentences: sens,
      })
      absSentStart += sens.length
      continue
    }
    // 超长：做语义细切
    const sens = splitSentences(b.text)
    let vecs = []
    try {
      if (typeof embedSentencesFn === 'function') vecs = await embedSentencesFn(sens)
    } catch {
      vecs = []
    }
    if (!Array.isArray(vecs) || vecs.length !== sens.length) {
      // 向量不可用 → 退化为"每 N 句切一块（按字符数估算）"，保证不崩
      const fallback = []
      let buf = []
      let bufLen = 0
      for (const s of sens) {
        if (bufLen + s.length > cfg.maxChars && buf.length > 0) {
          fallback.push(buf)
          buf = [s]
          bufLen = s.length
        } else {
          buf.push(s)
          bufLen += s.length
        }
      }
      if (buf.length) fallback.push(buf)
      let p = 0
      for (const fb of fallback) {
        const len = fb.length
        out.push({
          heading: b.heading,
          text: fb.join(' ').trim(),
          sentenceRange: [p, p + len],
          absoluteSentenceStart: absSentStart + p,
          _sentences: fb,
        })
        p += len
      }
      absSentStart += sens.length
      continue
    }
    const subs = semanticSplitOne(b.text, sens, vecs, cfg)
    for (const sub of subs) {
      out.push({
        heading: b.heading,
        text: sub.text,
        sentenceRange: [sub.sentenceRange[0], sub.sentenceRange[1]],
        absoluteSentenceStart: absSentStart + sub.sentenceRange[0],
        _sentences: sens.slice(sub.sentenceRange[0], sub.sentenceRange[1]),
      })
    }
    absSentStart += sens.length
  }
  return out
}

/* ===================== 合并过短块 + 强制硬切 ===================== */

/**
 * 把 < minChars 的块向上合并到前一个。
 * 第一个块 < minChars：优先与后一个合并；若独苗则保留。
 */
export function mergeShortChunks(chunks, minChars) {
  if (!chunks || chunks.length === 0) return []
  const out = []
  for (const c of chunks) {
    const prev = out[out.length - 1]
    // 仅当前一块仍未达 minChars 时才并入：只看「当前块短」会造成链式吞并——
    // 短块密集的文档（如 FAQ 问答对）中，前一块会无限吞并后续短块直到撞上长块。
    if (prev && prev.text.length < minChars) {
      prev.text = (prev.text ? prev.text + '\n' : '') + c.text
      // sentenceRange/absoluteSentenceStart 保留 prev 的口径即可（因为合并后用 heading 和 text 入库，range 只用于 context 句子提取）
      if (Array.isArray(c._sentences) && Array.isArray(prev._sentences)) {
        prev._sentences = [...prev._sentences, ...c._sentences]
      }
      continue
    }
    out.push({ ...c })
  }
  // 极端：第一个块自身也过短（<minChars），尝试和下一个合并（此时它在 out[0]，后面一定是 >=minChars 独立的，不合）
  // 兜底：如果 out[0] 仍 < minChars 且 out.length > 1 → 并入 out[1]
  if (out.length > 1 && out[0].text.length < minChars) {
    const first = out.shift()
    out[0].text = (first.text ? first.text + '\n' : '') + out[0].text
    if (Array.isArray(first._sentences) && Array.isArray(out[0]._sentences)) {
      out[0]._sentences = [...first._sentences, ...out[0]._sentences]
    }
  }
  return out
}

/**
 * 强制硬切：对超过 hardMaxChars 的块无论语义如何都一刀两段，最后对 absoluteMax 做 2500 字终极限长。
 */
export function enforceHardMax(chunks, hardMax, absoluteMax) {
  const out = []
  for (const c of chunks) {
    if (!c.text || c.text.length <= hardMax) {
      out.push(c)
      continue
    }
    let remaining = c.text
    while (remaining.length > hardMax) {
      // 硬切但优先在换行处断开（避免一句话腰斩）
      let cut = hardMax
      const nl = remaining.lastIndexOf('\n', hardMax)
      if (nl > Math.floor(hardMax * 0.6)) cut = nl
      const piece = remaining.slice(0, cut).trim()
      if (piece) out.push({ ...c, text: piece.slice(0, absoluteMax) })
      remaining = remaining.slice(cut)
    }
    const tail = remaining.trim()
    if (tail) out.push({ ...c, text: tail.slice(0, absoluteMax) })
  }
  return out
}

/* ===================== 上下文扩展 ===================== */

/**
 * 取句子列表的末尾 N 句（上限约 100 字符）。
 */
function sentencesPrefix(sens, n, maxChars) {
  if (!sens || !sens.length) return ''
  const take = Math.max(1, Math.min(sens.length, n))
  let out = ''
  for (let i = 0; i < take; i++) {
    const next = (out ? out + ' ' : '') + sens[i]
    if (next.length > maxChars) break
    out = next
  }
  return out.trim()
}
function sentencesSuffix(sens, n, maxChars) {
  if (!sens || !sens.length) return ''
  const start = Math.max(0, sens.length - Math.max(1, n))
  let out = ''
  for (let i = sens.length - 1; i >= start; i--) {
    const next = sens[i] + (out ? ' ' + out : '')
    if (next.length > maxChars) break
    out = next
  }
  return out.trim()
}

/**
 * 给 chunks 列表补 preContext / postContext（零成本）。
 * 每个 chunk 要求：{ _sentences?: string[], text: string }
 */
export function attachContext(chunks, opts = {}) {
  const contextSentences = opts.contextSentences ?? 2
  const maxChars = opts.maxChars ?? 120
  const out = chunks.map((c) => ({ ...c }))
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]
    const curSens =
      Array.isArray(cur._sentences) && cur._sentences.length
        ? cur._sentences
        : splitSentences(cur.text)
    const prev = i > 0 ? out[i - 1] : null
    const next = i < out.length - 1 ? out[i + 1] : null
    if (prev) {
      const prevSens =
        Array.isArray(prev._sentences) && prev._sentences.length
          ? prev._sentences
          : splitSentences(prev.text)
      cur.preContext = sentencesSuffix(prevSens, contextSentences, maxChars)
    } else {
      cur.preContext = ''
    }
    if (next) {
      const nextSens =
        Array.isArray(next._sentences) && next._sentences.length
          ? next._sentences
          : splitSentences(next.text)
      cur.postContext = sentencesPrefix(nextSens, contextSentences, maxChars)
    } else {
      cur.postContext = ''
    }
  }
  return out
}

/* ===================== 公共 API ===================== */

/**
 * 新接口：三层切片 + 句子缓存。
 * 调用方（index.js 上传/manual/updateContent）用这个，然后：
 *   1. 如果存在超长块，需要再给 embedSentences 做语义向量（本函数内部已经做了）。
 *   2. 用 sentenceVectors / sentences 返回给调用方，方便后续：
 *      - 计算每个 chunk 的向量（averageVectors(sentenceVectors[chunk.sentenceStart..end])）
 *      - 预生成 questions/topic 的句子摘要
 *
 * @param {string} text
 * @param {{
 *   config?: typeof chunkerConfig,
 *   embedSentences?: (sentences:string[])=>Promise<number[][]>,
 * }} [opts]
 * @returns {Promise<{
 *   chunks: Array<{
 *     idx:number, heading:string, text:string,
 *     preContext:string, postContext:string,
 *     sentenceStart:number, sentenceEnd:number
 *   }>,
 *   sentences: string[],
 *   sentenceVectors: number[][],
 * }>}
 */
export async function splitDocumentIntoChunks(text, opts = {}) {
  const cfg = { ...chunkerConfig, ...(opts.config || {}) }
  const embedFn = opts.embedSentences || null
  const strategy = opts.strategy || 'semantic'

  let sentences = []
  let sentenceVectors = []
  let enriched

  if (strategy === 'delimiter') {
    // 自定义分隔符切片：不做语义细切（不调 embedding），sentenceVectors 留空。
    // 后续 chunk 向量由调用方走 embedTexts(chunk.text) 整体 embed。
    const delim = typeof opts.delimiter === 'string' ? opts.delimiter : ''
    const ruleBlocks = splitByDelimiter(text || '', delim, {
      maxChars: cfg.maxChars,
      overlapChars: opts.overlapChars,
    })
    enriched = ruleBlocks.map((b, i) => ({
      idx: i,
      heading: b.heading || '',
      text: b.text,
      preContext: '',
      postContext: '',
      sentenceStart: 0,
      sentenceEnd: 0,
    }))
  } else {
    // 语义感知切片：第一层规则递归 → 第二层语义细切（超长块才真正做向量；失败/无向量降级句子数硬切）
    const ruleBlocks = recursiveSplit(text || '', cfg)
    const semBlocks = await semanticSplitBlocks(ruleBlocks, cfg, embedFn)

    // 收集全量 sentences + 向量占位
    for (const b of semBlocks) {
      if (Array.isArray(b._sentences) && b._sentences.length) {
        for (const s of b._sentences) sentences.push(s)
      } else {
        for (const s of splitSentences(b.text)) sentences.push(s)
      }
    }
    // sentenceVectors 目前不在 chunker 里主动 embed（调用方有选择：是否走平均向量省 embedding）。
    // 留空数组，调用方按需 embedSentences(sentences) 后再计算每个 chunk 的平均；
    // 若调用方不关心，直接 embedTexts(chunks.map(c=>c.text)) 也是兼容老路径。

    enriched = semBlocks.map((b, i) => ({
      idx: i,
      heading: b.heading || '',
      text: b.text,
      preContext: '',
      postContext: '',
      sentenceStart: b.absoluteSentenceStart ?? (b._sentences ? 0 : 0),
      sentenceEnd: (b.absoluteSentenceStart ?? 0) + (b._sentences ? b._sentences.length : splitSentences(b.text).length),
      _sentences: b._sentences,
    }))

    // 补 sentenceStart/sentenceEnd：若上面用 absoluteSentenceStart 已经 100% 对齐，下面不走；
    // 否则兜底从头累计。
    if (enriched.some((c) => !Number.isFinite(c.sentenceStart) || c.sentenceStart < 0)) {
      let p = 0
      for (const c of enriched) {
        const len = Array.isArray(c._sentences) ? c._sentences.length : splitSentences(c.text).length
        c.sentenceStart = p
        c.sentenceEnd = p + len
        p += len
      }
    }
  }

  // 兜底：semantic 模式合并过短块；delimiter 模式尊重用户显式分隔符，不合并
  if (strategy !== 'delimiter') {
    enriched = mergeShortChunks(enriched, cfg.minChars)
  }
  enriched = enforceHardMax(enriched, cfg.hardMaxChars, cfg.absoluteMaxChars)
  enriched.forEach((c, i) => (c.idx = i))

  // 第三层：上下文扩展（零成本）
  enriched = attachContext(enriched, {
    contextSentences: cfg.contextSentences,
    maxChars: 120,
  })

  // 清理内部字段，返回干净结构
  const chunks = enriched.map((c) => {
    const { _sentences, ...rest } = c
    void _sentences
    return rest
  })

  return { chunks, sentences, sentenceVectors }
}

/**
 * 兼容旧调用：返回 [{idx, heading, text}]（丢失 topic/questions/context 新字段）。
 * 保留用于 vectorStore.updateContent 的 fallback 路径，保证旧代码不崩；
 * 建议 index.js 里的上传/manual/updateContent 统一迁移到 splitDocumentIntoChunks。
 */
export function splitIntoChunks(text, opts = {}) {
  const cfg = { ...chunkerConfig, ...opts }
  const ruleBlocks = recursiveSplit(text || '', cfg)
  // 兼容版：不触发动辄 embed 的语义细切（避免同步签名里异步调用）
  // 但仍然做：按 maxChars 再按段落硬切 + 合并过短 + 强制硬切
  const out = []
  for (const b of ruleBlocks) {
    if (b.text.length <= cfg.maxChars) {
      out.push({ heading: b.heading, text: b.text })
      continue
    }
    // 单个 heading 块也超长 → 按段落切
    const paragraphs = b.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    let buf = ''
    const flushBuf = () => {
      const t = buf.trim()
      if (t) out.push({ heading: b.heading, text: t })
      buf = ''
    }
    for (const p of paragraphs) {
      if (buf.length + p.length + 2 <= cfg.maxChars) {
        buf = buf ? buf + '\n\n' + p : p
        continue
      }
      flushBuf()
      // 单段超长 → 按句子切
      if (p.length <= cfg.maxChars) {
        buf = p
        continue
      }
      const sentences = splitSentences(p)
      let sbuf = ''
      for (const s of sentences) {
        if (sbuf.length + s.length + 1 <= cfg.maxChars) {
          sbuf = sbuf ? sbuf + ' ' + s : s
          continue
        }
        if (sbuf) out.push({ heading: b.heading, text: sbuf })
        sbuf = s
      }
      if (sbuf) buf = sbuf
    }
    flushBuf()
  }
  const merged = mergeShortChunks(
    out.map((c, idx) => ({ ...c, idx })),
    cfg.minChars,
  )
  const hard = enforceHardMax(merged, cfg.hardMaxChars, cfg.absoluteMaxChars)
  hard.forEach((c, i) => (c.idx = i))
  return hard
}

export default {
  splitDocumentIntoChunks,
  splitByDelimiter,
  splitIntoChunks,
  splitSentences,
  mergeShortChunks,
  enforceHardMax,
  attachContext,
}
