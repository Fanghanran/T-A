/**
 * docProcessor —— 文档处理智能体核心逻辑
 *
 * 职责（对应 docs/文档处理智能体设计文档.md）：
 *  1. extractDocumentText(buffer, filename) — 格式感知文本提取（md/txt/html/csv/json/yaml/log）
 *  2. analyzeDocStructure(text)            — LLM 分析文档结构 + 推荐切片策略
 *  3. previewChunks(text, strategy, opts)  — 仅切片，不入库（不 embed）
 *  4. processAndStore(docId, strategy, opts) — 完整切片 + embed + 标注 + 入库
 *  5. applyChunkAdjustment(chunks, instruction) — 应用用户的"合并第2、3块 / 拆分第5块"指令
 *  6. exportChunksAsMarkdown(chunks)        — 把切片拼接回完整 Markdown
 *  7. prepareDocChunksAndVectors(text, opts) — 切片 + 句子向量平均 + topic/questions 标注（从 index.js 迁入）
 *
 * 流式输出统一遵循 Vercel AI SDK data-stream 协议（0:"text"\n + 2:[annot]\n + d:done\n），
 * 前端 useChat 可直接消费。
 */

import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { streamText } from 'ai'
import jschardet from 'jschardet'
import iconv from 'iconv-lite'

import { splitDocumentIntoChunks, splitSentences } from './chunker.js'
import { embedTexts, embedSentences, averageVectors, embedMode } from './embed.js'
import { getChatModel } from './llmProvider.js'
import { stubStream, prependAnnotation } from './streamUtils.js'
import { cosineSimilarity } from './mathUtils.js'
import { generateChunkAnnotations } from './llm.js'
import { chunkerConfig, llmAvailable } from './config.js'
import { tunables } from './tunables.js'
import { childLogger } from './logger.js'

// PDF / DOCX 解析。两者均为纯 JS 实现 —— 本机没有 VS C++ Build Tools，
// 任何需要编译原生模块的库（如 pdfium、libreoffice 封装）都装不上。
// pdfjs-dist 走 legacy 构建以适配 Node；mammoth 直接可用。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import mammoth from 'mammoth'

const log = childLogger('docProcessor')

/** 逐页抽取 PDF 文本；扫描件（无文本层）会得到空串，由调用方给出明确提示 */
async function extractPdfText(buffer) {
  const data = new Uint8Array(buffer)
  const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise
  const parts = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    const line = (tc.items ?? [])
      .map((it) => (typeof it?.str === 'string' ? it.str : ''))
      .join('')
    if (line.trim()) parts.push(line.trim())
  }
  return { text: parts.join('\n\n'), numPages: doc.numPages }
}

/** DOCX 抽文本：extractRawText 保留纯文本，比 HTML 更适合作切片输入 */
async function extractDocxText(buffer) {
  const r = await mammoth.extractRawText({ buffer })
  return { text: (r?.value ?? '').trim(), messages: r?.messages ?? [] }
}

/**
 * 异步版文本提取：在 extractDocumentText 之上增加 PDF / DOCX 分支。
 * 其余格式（md/txt/html/csv/tsv/json/yaml/log）仍走原有的同步逻辑，零行为变化。
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [filename]
 * @returns {Promise<{text:string, format:string, title:string, numPages?:number}>}
 */
export async function extractDocumentTextAsync(buffer, filename = '') {
  const safeName = typeof filename === 'string' ? filename : ''
  const ext = (safeName.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
  const lower = ext.toLowerCase()

  if (lower === 'pdf') {
    const { text, numPages } = await extractPdfText(buffer)
    if (!text.trim()) {
      throw new Error(
        `未能从 PDF 抽出文本（${numPages} 页）。多半是扫描件/图片型 PDF，没有文本层，需先做 OCR。`,
      )
    }
    return { text, format: 'pdf', title: safeName, numPages }
  }
  if (lower === 'docx') {
    const { text, messages } = await extractDocxText(buffer)
    if (!text) throw new Error('未能从 DOCX 抽出文本，文件可能损坏或是空的')
    if (messages?.length) {
      log.debug(`[docProcessor] DOCX 解析提示 ${messages.length} 条`, { sample: messages[0]?.message })
    }
    return { text, format: 'docx', title: safeName }
  }
  return extractDocumentText(buffer, filename)
}

// turndown 是 CommonJS 包，用 createRequire 同步加载避免 ESM default 包装问题
const _require = createRequire(import.meta.url)
let _turndown = null
function getTurndown() {
  if (_turndown) return _turndown
  try {
    _turndown = _require('turndown')
  } catch (err) {
    log.warn(`[docProcessor] turndown 加载失败：${err.message}，HTML 将退化为去标签纯文本`)
  }
  return _turndown
}

/* ===================== 文本解码（从 index.js 迁入，保持知识库上传链路一致） ===================== */

/**
 * 智能解码文本：自动检测文件编码并转为 UTF-8（支持 GBK/GB2312 等中文编码）
 */
export function decodeText(buffer) {
  const detection = jschardet.detect(buffer)
  let detectedEncoding = detection.encoding
  if (detectedEncoding === 'GB2312') detectedEncoding = 'gbk'

  if (detectedEncoding && iconv.encodingExists(detectedEncoding)) {
    try {
      return iconv.decode(buffer, detectedEncoding)
    } catch {
      /* 回退 UTF-8 */
    }
  }

  const utf8Text = buffer.toString('utf8')
  if (utf8Text.includes('\uFFFD') || /[\x80-\xFF]{3,}/.test(utf8Text)) {
    try {
      return iconv.decode(buffer, 'gbk')
    } catch {
      /* 返回 utf8 结果 */
    }
  }
  return utf8Text
}

/**
 * 解码中文文件名：multer 默认按 latin1 解析 originalname，需恢复为 UTF-8
 */
export function decodeFilename(filename) {
  if (!filename) return ''
  const hasNonAscii = /[^\x00-\x7F]/.test(filename)
  if (!hasNonAscii) return filename
  try {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8')
    if (!decoded.includes('\uFFFD') && decoded.length > 0 && decoded.length < 255) {
      return decoded
    }
  } catch {
    /* 返回原名 */
  }
  return filename
}

/* ===================== 格式感知文本提取 ===================== */

const EXT_FORMAT = /\.(md|markdown|txt|html?|csv|tsv|log|json|ya?ml)$/i

/**
 * CSV/TSV → Markdown 表格。首行视作表头，最多取 20 列 × 200 行避免 prompt 爆炸。
 */
function parseCsvToMarkdown(text, delimiter = ',') {
  const lines = (text || '').split(/\r?\n/).filter((l) => l.length > 0).slice(0, 200)
  if (lines.length === 0) return ''
  const splitLine = (line) => {
    if (delimiter === '\t') return line.split('\t')
    // 简易 CSV 解析：支持 "a,b","c" 的引号字段
    const out = []
    let buf = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { buf += '"'; i++ }
        else inQuote = !inQuote
      } else if (ch === delimiter && !inQuote) {
        out.push(buf); buf = ''
      } else {
        buf += ch
      }
    }
    out.push(buf)
    return out.slice(0, 20)
  }
  const rows = lines.map((l) => splitLine(l))
  const header = rows[0]
  const md = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ]
  return md.join('\n')
}

/**
 * JSON → 文本：提取关键字段（遍历对象/数组，拼接 path: value 摘要）
 */
function extractJsonText(buffer) {
  const raw = decodeText(buffer)
  try {
    const data = JSON.parse(raw)
    return jsonToText(data, '', 0)
  } catch {
    return raw
  }
}

function jsonToText(value, path, depth) {
  if (depth > 4) return ''
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return `${path}: ${String(value)}\n`
  if (Array.isArray(value)) {
    if (value.length === 0) return ''
    const head = value[0]
    if (typeof head === 'object' && head !== null) {
      return value.slice(0, 100).map((item, i) => jsonToText(item, `${path || 'item'}[${i}]`, depth + 1)).join('')
    }
    return `${path}: ${value.slice(0, 50).join(', ')}\n`
  }
  const lines = []
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k
    if (v !== null && typeof v === 'object') {
      lines.push(jsonToText(v, p, depth + 1))
    } else {
      lines.push(`${p}: ${String(v ?? '')}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * HTML → Markdown（turndown）；不可用时退化为去标签纯文本
 */
function htmlToMarkdown(buffer) {
  const html = decodeText(buffer)
  const TurndownService = getTurndown()
  if (TurndownService) {
    try {
      const td = typeof TurndownService === 'function'
        ? new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
        : (TurndownService.TurndownService ? new TurndownService.TurndownService({ headingStyle: 'atx' }) : null)
      if (td) return td.turndown(html)
    } catch (err) {
      log.warn(`[docProcessor] turndown 转换失败：${err.message}，退化为去标签`)
    }
  }
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 格式感知文本提取。
 * @param {Buffer} buffer
 * @param {string} filename  原始文件名（用于判定扩展名）
 * @returns {{ text: string, format: string, title: string }}
 */
export function extractDocumentText(buffer, filename = '') {
  const safeName = typeof filename === 'string' ? filename : ''
  const ext = (safeName.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
  const lower = ext.toLowerCase()

  if (lower === 'html' || lower === 'htm') {
    return { text: htmlToMarkdown(buffer), format: 'html', title: safeName }
  }
  if (lower === 'csv') {
    return { text: parseCsvToMarkdown(decodeText(buffer), ','), format: 'csv', title: safeName }
  }
  if (lower === 'tsv') {
    return { text: parseCsvToMarkdown(decodeText(buffer), '\t'), format: 'tsv', title: safeName }
  }
  if (lower === 'json') {
    return { text: extractJsonText(buffer), format: 'json', title: safeName }
  }
  // md / markdown / txt / log / yaml / yml / 未知扩展 → 按 UTF-8（带编码探测）直接读取
  const format =
    lower === 'md' || lower === 'markdown' ? 'markdown'
      : lower === 'yaml' || lower === 'yml' ? 'yaml'
      : lower === 'log' ? 'log'
      : lower === 'txt' ? 'text'
      : 'text'
  return { text: decodeText(buffer), format, title: safeName }
}

/* ===================== 文档结构分析（启发式，用于策略推荐 + 概述） ===================== */

/**
 * 统计文档结构特征，返回概述 + 推荐策略。
 * @param {string} text
 * @returns {{ chars:number, paragraphs:number, headings:number, hasCode:boolean, hasQa:boolean, suggestedStrategy:string, maxChars:number }}
 */
export function analyzeDocFeatures(text) {
  const safe = typeof text === 'string' ? text : ''
  const chars = safe.length
  const paragraphs = safe.split(/\n\s*\n/).filter((p) => p.trim()).length
  const headings = (safe.match(/^#{1,6}\s+/gm) || []).length
  const hasCode = /```/.test(safe) || /^\s{4,}\S/m.test(safe)
  const hasQa = /[?？]\s*[:：]|问[:：]|答[:：]/m.test(safe)
  const hasTable = /\|[\s\S]*?\|[\s\S]*?\n\|[\s-:|]+\|/.test(safe)

  let suggestedStrategy = 'semantic'
  let maxChars = chunkerConfig.maxChars
  if (hasQa && !hasTable) { suggestedStrategy = 'semantic'; maxChars = 600 }
  else if (hasCode) { suggestedStrategy = 'semantic'; maxChars = 800 }

  return { chars, paragraphs, headings, hasCode, hasQa, hasTable, suggestedStrategy, maxChars }
}


const DOC_PROCESSOR_PROMPT =
  `你是一位文档处理专家。你的职责是帮助用户把原始文档整理成适合检索的结构化切片。\n\n` +
  `处理流程：\n` +
  `1. 用户上传文档后，先分析文档格式和内容结构，给出概述（字数、段落数、格式类型）\n` +
  `2. 根据文档特征推荐合适的切片策略：\n` +
  `   - Markdown 文档 → 默认语义切片（按标题层级切）\n` +
  `   - Q&A 文档 → 建议按问答单元切，maxChars=600\n` +
  `   - 代码文档 → 建议按函数/方法切，maxChars=800\n` +
  `   - 纯文本/OCR 稿 → 建议先做文本清洗，再按段落切\n` +
  `3. 执行切片后展示预览，每个 chunk 显示块号、heading、字数、内容摘要\n` +
  `4. 用户可随时调整：合并块、拆分块、修改策略参数\n` +
  `5. 用户确认后才入库，入库前必须用户明确说"入库"\n\n` +
  `注意：\n` +
  `- 不要回答文档内容相关的问题（如"这份文档讲了什么"），专注于切片和整理\n` +
  `- 切片预览时不执行 embedding 和 LLM 标注（省成本），只在确认入库时才执行\n` +
  `- 用户可以通过说"导出"把整理后的文本以 Markdown 格式输出`

/**
 * 流式分析文档结构：LLM 可用时走真实模型，否则走启发式文本。
 * @param {{ text:string, features:object, title:string }} param0
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
export async function streamAnalyzeDoc({ text, features, title }) {
  const { chars, paragraphs, headings, hasCode, hasQa, hasTable, suggestedStrategy, maxChars } = features
  const preview = (text || '').slice(0, 1200)
  const overview =
    `收到文档《${title || '未命名'}》：共 ${chars.toLocaleString()} 字，${paragraphs} 个段落，` +
    `${headings} 个标题，${hasCode ? '含代码块' : '无代码'}，${hasQa ? '含问答结构' : '无问答结构'}，` +
    `${hasTable ? '含表格' : '无表格'}。\n\n` +
    `推荐策略：${suggestedStrategy}（maxChars=${maxChars}）。` +
    `回复"预览"查看切片效果，或直接说"入库"。`

  if (llmAvailable) {
    const sys = DOC_PROCESSOR_PROMPT
    const prompt =
      `文档标题：${title || '未命名'}\n` +
      `结构特征：${chars} 字 / ${paragraphs} 段 / ${headings} 标题 / ${hasCode ? '有代码' : '无代码'} / ${hasQa ? '有问答' : '无问答'} / ${hasTable ? '有表格' : '无表格'}\n` +
      `启发式推荐：strategy=${suggestedStrategy}, maxChars=${maxChars}\n\n` +
      `文档开头预览：\n${preview}\n\n` +
      `请用一段话向用户概述文档结构并推荐切片策略，引导用户回复"预览"或"入库"。`
    const result = await streamText({ model: getChatModel({ role: 'chat.doc.analyze', agentId: 'doc-processor' }), system: sys, prompt })
    return result.toDataStream()
  }
  return stubStream(overview)
}

/* ===================== 切片预览 ===================== */

/**
 * 仅切片，不 embed 不入库。
 * @param {string} text
 * @param {{ strategy?: 'semantic'|'delimiter', delimiter?: string, maxChars?: number, hardMaxChars?: number, minChars?: number }} opts
 * @returns {Promise<Array<{ idx:number, heading:string, text:string, chars:number, preContext:string, postContext:string }>>}
 */
export async function previewChunks(text, opts = {}) {
  const cfg = {}
  if (Number.isFinite(opts.maxChars)) cfg.maxChars = opts.maxChars
  if (Number.isFinite(opts.hardMaxChars)) cfg.hardMaxChars = opts.hardMaxChars
  if (Number.isFinite(opts.minChars)) cfg.minChars = opts.minChars

  const strategy = opts.strategy === 'delimiter' ? 'delimiter' : 'semantic'
  const delimiter = strategy === 'delimiter' ? (typeof opts.delimiter === 'string' ? opts.delimiter : '---') : undefined

  const { chunks } = await splitDocumentIntoChunks(text, {
    strategy,
    delimiter,
    config: Object.keys(cfg).length ? cfg : undefined,
    // 预览阶段不调 embedding（省成本）：语义细切降级为句子数硬切兜底
    embedSentences: null,
  })
  return chunks.map((c) => ({
    idx: c.idx,
    heading: c.heading || '',
    text: c.text,
    chars: typeof c.text === 'string' ? c.text.length : 0,
    preContext: c.preContext || '',
    postContext: c.postContext || '',
  }))
}

/**
 * 带质量评分的预览切片（REST /api/doc-processor/preview 用）：
 * 每块附加 score/level/issues（启发式评分，零 embedding 成本），并给出整体均分。
 * 聊天/智能体链路仍用 previewChunks（保持数组返回，调用方零改动）。
 */
export async function previewChunksScored(text, opts = {}) {
  const chunks = await previewChunks(text, opts)
  const { chunks: scored, avgScore } = attachChunkScores(chunks)
  return { chunks: scored, avgScore }
}

/**
 * 把 chunks 格式化为流式预览文本（块号 · 字数 | heading + 前 150 字预览）。
 */
export function formatChunksPreview(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '切片结果为空。'
  const total = chunks.reduce((s, c) => s + (c.chars || 0), 0)
  const lines = ['━━━ 切片预览 ━━━', '']
  for (const c of chunks) {
    const heading = c.heading || `第 ${c.idx + 1} 块`
    const preview = (c.text || '').slice(0, 150).replace(/\n+/g, ' ').trim()
    const ellipsis = (c.text || '').length > 150 ? '…' : ''
    lines.push(`第 ${c.idx + 1} 块 · ${(c.chars || 0).toLocaleString()} 字  |  heading: ${heading}`)
    lines.push(`  ${preview}${ellipsis}`)
    lines.push('')
  }
  lines.push(`共 ${chunks.length} 块，总字数 ${total.toLocaleString()}。确认无误后说"入库"，或告诉我调整策略（如"合并第2、3块"、"maxChars 改成 1000"）。`)
  return lines.join('\n')
}

/**
 * 把 chunks 转为前端注解（type: search_results, engine: doc-processor），供 ChunkPreviewPanel 渲染。
 */
export async function chunksToAnnotation(chunks, docId, extra = {}) {
  const scored = await attachChunkScoresAsync(chunks)
  return {
    type: 'search_results',
    engine: 'doc-processor',
    searchMs: 0,
    query: extra.action || 'preview',
    docId,
    total: scored.chunks.length,
    avgScore: scored.avgScore,
    scoreMode: scored.scoreMode,
    results: scored.chunks.map((c, i) => ({
      rank: i + 1,
      id: `${docId}#chunk${i}`,
      title: c.heading || `第 ${i + 1} 块`,
      heading: c.heading || '',
      chars: c.chars ?? (typeof c.text === 'string' ? c.text.length : 0),
      snippet: (typeof c.text === 'string' ? c.text : '').slice(0, 240),
      text: c.text || '',
      preContext: c.preContext || '',
      postContext: c.postContext || '',
      score: c.score,
      level: c.level,
      issues: c.issues,
    })),
  }
}

/* ===================== 切片质量评分（设计文档 §9 扩展） ===================== */

/**
 * 单块质量评分（0-100，启发式，预览阶段零 embedding 成本）：
 *  - 字数适配（50 分）：落在 [minChars, maxChars] 满分；偏小/超 maxChars 按 proportion 扣；
 *    超 hardMax 重扣（检索粒度过粗）
 *  - 结构信息（+30 分）：有 heading +20；有 pre/postContext +10（检索上下文锚点）
 *  - 文本完整性（+20 分）：以句末标点收尾 +10；不以标题符号/截断词开头 +10
 * 返回 { score, level, issues }，level: good(≥80) / fair(60-79) / poor(<60)。
 */
export function scoreChunk(chunk) {
  const chars = Number(chunk?.chars ?? (typeof chunk?.text === 'string' ? chunk.text.length : 0)) || 0
  const { minChars, maxChars, hardMaxChars } = chunkerConfig
  const issues = []
  let score = 0

  // ① 字数适配
  if (chars >= minChars && chars <= maxChars) {
    score += 50
  } else if (chars < minChars) {
    const ratio = chars / Math.max(minChars, 1)
    score += Math.max(10, Math.round(40 * ratio))
    issues.push(`字数偏小（${chars} < minChars=${minChars}）`)
  } else if (chars <= hardMaxChars) {
    score += 35
    issues.push(`超过 maxChars=${maxChars}`)
  } else {
    score += 15
    issues.push(`超过 hardMaxChars=${hardMaxChars}，检索粒度过粗`)
  }

  // ② 结构信息
  const heading = typeof chunk?.heading === 'string' ? chunk.heading.trim() : ''
  if (heading) score += 20
  else issues.push('无 heading，检索展示缺标题')
  const hasPre = typeof chunk?.preContext === 'string' && chunk.preContext.trim()
  const hasPost = typeof chunk?.postContext === 'string' && chunk.postContext.trim()
  if (hasPre || hasPost) score += 10
  else issues.push('无上下文锚点（pre/postContext）')

  // ③ 文本完整性
  const text = typeof chunk?.text === 'string' ? chunk.text.trim() : ''
  if (text) {
    if (/[。！？.!?\n]$/.test(text)) score += 10
    else issues.push('疑似句中截断')
    if (!/^[，、；：,;:]/.test(text)) score += 10
    else issues.push('块首为连接符，疑似切断句')
  } else {
    issues.push('空块')
  }

  score = Math.max(0, Math.min(100, score))
  return { score, level: score >= 80 ? 'good' : score >= 60 ? 'fair' : 'poor', issues }
}

/** 给 chunks 批量附加评分（返回新数组，每块带 score/level/issues），并给出整体均分。 */
export function attachChunkScores(chunks) {
  const scored = (Array.isArray(chunks) ? chunks : []).map((c) => {
    const s = scoreChunk(c)
    return { ...c, score: s.score, level: s.level, issues: s.issues }
  })
  const avg = scored.length ? Math.round(scored.reduce((s, c) => s + (c.score || 0), 0) / scored.length) : 0
  return { chunks: scored, avgScore: avg }
}

/* ---------- 混合评分：启发式结构基线 + 向量语义校验 ---------- */

/** 语义评分阈值与惩罚幅度（值来自 tunables.js，管理端在线修改热生效；调用时读属性） */
const SEMANTIC_SCORE = tunables.scoring

/**
 * 混合评分（异步）：在启发式结构评分之上叠加两个向量语义信号。
 *
 * ① 相邻块边界质量：embed 各块文本，若相邻块 cos ≥ 0.9，
 *    说明切分点落在同一主题内部（内容近乎重复），两侧各扣分。
 *    —— 启发式完全看不出这类问题（结构完好但语义上切错了地方）
 * ② 块内语义一致性：embed 块内全部句子（一次批量），平均两两 cos < 0.4
 *    判定主题混杂，建议按主题重切。
 *
 * 真实 embedding 端点不可用（embedMode() === 'hash'）或计算失败时，
 * 自动回退纯启发式（scoreMode: 'heuristic'），保证任何环境预览都可用。
 *
 * @param {Array} chunks 未评分切片
 * @returns {Promise<{ chunks:Array, avgScore:number, scoreMode:'hybrid'|'heuristic' }>}
 */
export async function attachChunkScoresAsync(chunks) {
  const base = attachChunkScores(chunks)
  const list = base.chunks
  if (embedMode() !== 'external' || list.length < 2) {
    return { ...base, scoreMode: 'heuristic' }
  }
  try {
    // ① 相邻块边界质量（每块一次 embed，批量请求）
    const vecs = await embedTexts(list.map((c) => (typeof c.text === 'string' ? c.text : '')))
    const adjPenalty = new Array(list.length).fill(0)
    const adjIssues = list.map(() => [])
    for (let i = 0; i < list.length - 1; i++) {
      const sim = cosineSimilarity(vecs[i], vecs[i + 1])
      if (sim >= SEMANTIC_SCORE.adjacentSim) {
        adjPenalty[i] += SEMANTIC_SCORE.adjacentPenalty
        adjIssues[i].push(`与第 ${i + 2} 块高度相似（cos=${sim.toFixed(2)}），疑似主题被切断或内容重复`)
        adjPenalty[i + 1] += SEMANTIC_SCORE.adjacentPenalty
        adjIssues[i + 1].push(`与第 ${i + 1} 块高度相似（cos=${sim.toFixed(2)}），疑似主题被切断或内容重复`)
      }
    }

    // ② 块内语义一致性（全部句子一次批量 embed，再按块分组算两两均值）
    const sentGroups = list.map((c) => splitSentences(String(c.text ?? '')).filter((s) => s.trim()))
    const totalSents = sentGroups.reduce((s, g) => s + g.length, 0)
    const intraPenalty = new Array(list.length).fill(0)
    const intraIssues = list.map(() => [])
    if (totalSents >= 4 && totalSents <= SEMANTIC_SCORE.maxSentences) {
      const flat = []
      const groupOf = []
      sentGroups.forEach((g, gi) => g.forEach((s) => { groupOf.push(gi); flat.push(s) }))
      const sentVecs = await embedTexts(flat)
      const grouped = sentGroups.map(() => [])
      sentVecs.forEach((v, i) => grouped[groupOf[i]].push(v))
      grouped.forEach((gv, gi) => {
        if (gv.length < 2) return
        let sum = 0
        let n = 0
        for (let a = 0; a < gv.length; a++) {
          for (let b = a + 1; b < gv.length; b++) {
            sum += cosineSimilarity(gv[a], gv[b])
            n++
          }
        }
        const coh = n ? sum / n : null
        if (coh !== null && coh < SEMANTIC_SCORE.intraCoherence) {
          intraPenalty[gi] += SEMANTIC_SCORE.intraPenalty
          intraIssues[gi].push(`块内语义混杂（句间相似度 ${coh.toFixed(2)}），建议按主题重切或拆分`)
        }
      })
    }

    // ③ 合并：启发式基线 - 语义惩罚，重算 level
    const merged = list.map((c, i) => {
      const issues = [...c.issues, ...adjIssues[i], ...intraIssues[i]]
      const score = Math.max(0, Math.min(100, Math.round((c.score || 0) - adjPenalty[i] - intraPenalty[i])))
      return { ...c, score, level: score >= 80 ? 'good' : score >= 60 ? 'fair' : 'poor', issues }
    })
    const avg = merged.length ? Math.round(merged.reduce((s, c) => s + (c.score || 0), 0) / merged.length) : 0
    return { chunks: merged, avgScore: avg, scoreMode: 'hybrid' }
  } catch (err) {
    log.warn(`[docProcessor] 语义评分计算失败（${err.message}），回退纯启发式评分`)
    return { ...base, scoreMode: 'heuristic' }
  }
}

/* ===================== 文档去重（设计文档 §9 扩展） ===================== */

/** 去重阈值：批内（同一文档内相近段落）与跨文档（近似完全重复才跳过）；值来自 tunables.js，在线修改热生效 */
export const DEDUP_THRESHOLDS = tunables.dedup

/**
 * 批内去重：同一批 chunk 里语义几乎相同（cos ≥ withinBatch）的只保留首个。
 * 纯函数不做 IO；跨文档去重（Milvus 检索比对）见 docAgent.dedupPreparedChunks。
 * @returns {{ chunkList:Array, vectors:Array, skipped:number }}
 */
export function dedupWithinBatch(chunkList, vectors, { threshold = DEDUP_THRESHOLDS.withinBatch } = {}) {
  const kept = []
  const keptVecs = []
  let skipped = 0
  for (let i = 0; i < chunkList.length; i++) {
    const v = Array.isArray(vectors?.[i]) ? vectors[i] : []
    const dup = keptVecs.some((kv) => cosineSimilarity(kv, v) >= threshold)
    if (dup) {
      skipped++
      continue
    }
    kept.push(chunkList[i])
    keptVecs.push(v)
  }
  return { chunkList: kept, vectors: keptVecs, skipped }
}

/* ===================== 切片调整（合并 / 拆分） ===================== */

/**
 * 解析用户自然语言调整指令，返回结构化操作。
 * 支持：
 *   "合并第2、3块" / "把第2和第3块合并" → { op:'merge', indices:[2,3] }（1-based）
 *   "拆分第5块" / "第5块太碎拆分一下" → { op:'split', index:5 }
 *   "maxChars 改成 1000" → { op:'reparam', maxChars:1000 }
 *   无匹配 → null
 */
export function parseAdjustmentInstruction(instruction) {
  const s = typeof instruction === 'string' ? instruction.trim() : ''
  if (!s) return null

  // 合并：抓"合并"+ 之后的数字列表
  if (/合并/.test(s)) {
    const nums = (s.match(/第\s*(\d+(?:\s*[、,，和及]\s*\d+)*)/g) || [])
      .flatMap((seg) => seg.replace(/^第\s*/, '').split(/[、,，和及\s]+/).map((n) => parseInt(n, 10)))
      .filter((n) => Number.isFinite(n) && n > 0)
    // 也兼容 "2、3" 直接出现
    const direct = s.match(/(\d+(?:\s*[、,，和及]\s*\d+)+)/)
    if (nums.length >= 2) return { op: 'merge', indices: [...new Set(nums)].sort((a, b) => a - b) }
    if (direct) {
      const ns = direct[1].split(/[、,，和及\s]+/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0)
      if (ns.length >= 2) return { op: 'merge', indices: [...new Set(ns)].sort((a, b) => a - b) }
    }
  }

  // 拆分
  if (/拆分|拆开|分开|切分/.test(s)) {
    const m = s.match(/第?\s*(\d+)/)
    if (m) return { op: 'split', index: parseInt(m[1], 10) }
  }

  // 标记问题块（ChunkPreviewPanel「标记问题块」按钮发出的指令）：
  // "第 3 块有问题，请重新处理该块" → 对该块重新拆分处理
  if (/有问题|重新处理|重新切|重新整理/.test(s)) {
    const m = s.match(/第?\s*(\d+)/)
    if (m) return { op: 'split', index: parseInt(m[1], 10) }
  }

  // 改参数
  const mc = s.match(/maxChars\s*[=:：改为成]+\s*(\d+)/i) || s.match(/最大字[数符]\s*[=:：改为成]+\s*(\d+)/)
  if (mc) return { op: 'reparam', maxChars: parseInt(mc[1], 10) }

  return null
}

/**
 * 应用调整指令到 chunks 数组，返回新数组（不修改原数组）。
 * @param {Array} chunks  0-based idx
 * @param {{ op:string, indices?:number[], index?:number, maxChars?:number }} adj
 */
export function applyChunkAdjustment(chunks, adj) {
  if (!Array.isArray(chunks) || !adj) return chunks
  const safe = chunks.map((c) => ({ ...c }))

  if (adj.op === 'merge' && Array.isArray(adj.indices) && adj.indices.length >= 2) {
    const targets = [...new Set(adj.indices.map((n) => n - 1))].sort((a, b) => a - b).filter((i) => i >= 0 && i < safe.length)
    if (targets.length < 2) return reindex(safe)
    const keep = targets[0]
    const mergedText = targets.map((i) => safe[i].text).join('\n')
    safe[keep] = {
      ...safe[keep],
      text: mergedText,
      chars: mergedText.length,
      heading: safe[keep].heading || `第 ${keep + 1} 块`,
    }
    // 从大到小删除被合并的后续块
    for (let i = targets.length - 1; i >= 1; i--) safe.splice(targets[i], 1)
    return reindex(safe)
  }

  if (adj.op === 'split' && Number.isFinite(adj.index)) {
    const target = adj.index - 1
    if (target < 0 || target >= safe.length) return reindex(safe)
    const c = safe[target]
    const half = Math.floor(c.text.length / 2)
    let cut = c.text.lastIndexOf('\n\n', half)
    if (cut < Math.floor(half * 0.5)) cut = c.text.lastIndexOf('\n', half)
    if (cut < Math.floor(half * 0.5)) cut = half
    const a = c.text.slice(0, cut).trim()
    const b = c.text.slice(cut).trim()
    if (!a || !b) return reindex(safe)
    safe.splice(target, 1,
      { ...c, text: a, chars: a.length },
      { ...c, heading: `${c.heading || `第 ${target + 1} 块`}（续）`, text: b, chars: b.length },
    )
    return reindex(safe)
  }

  return reindex(safe)
}

function reindex(chunks) {
  return chunks.map((c, i) => ({ ...c, idx: i }))
}

/**
 * Q&A 结构化解析：从「问：xxx\n答：xxx」格式切片正文提取问题文本。
 * 一问一答语料（如面试题库）的问题就在正文里，无需 LLM 生成假设问题——
 * 直接解析取用作为 question_vector 检索锚点，零 LLM 成本且比假设问题更准。
 * @param {string} text 切片正文
 * @returns {string|null} 问题文本；非 Q&A 格式或问题过短视为噪音返回 null
 */
export function parseQaQuestion(text) {
  if (typeof text !== 'string' || !text) return null
  // 多行模式匹配行首「问/Q/q + 冒号」开头的问题行（兼容中英文冒号）
  const m = text.match(/^[ \t]*(?:问|Q|q)\s*[:：]\s*(.+?)[ \t]*$/m)
  if (!m) return null
  const q = m[1].trim()
  return q.length >= 4 ? q : null
}

/* ===================== 导出为 Markdown ===================== */

export function exportChunksAsMarkdown(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return ''
  return chunks.map((c) => {
    const h = c.heading ? `## ${c.heading}\n\n` : ''
    return h + (c.text || '')
  }).join('\n\n---\n\n')
}

/* ===================== 完整入库链路（从 index.js 迁入） ===================== */

/**
 * 阶段 1 共用：文档正文 → 切片（semantic 或 delimiter）→ 句子 embed → chunk 平均向量 → topic/questions 标注。
 * 失败不抛，全部降级（embed 断 → 本地 hash；LLM 标注断 → heading/30字 兜底），绝不阻塞入库。
 *
 * @param {string} text
 * @param {{strategy?: 'semantic'|'delimiter', delimiter?: string, maxChars?: number, overlapChars?: number}} [opts]
 *   overlapChars 仅 delimiter 策略生效：相邻块滑动窗口重叠字符数（0 = 不重叠）
 * @returns {Promise<{chunkList:Array, vectors:Array<number[]>, reusedCount?:number}>}
 */
export async function prepareDocChunksAndVectors(text, opts = {}) {
  const safeText = typeof text === 'string' ? text : ''
  const isDelimiter = opts.strategy === 'delimiter'
  const config = isDelimiter && Number.isFinite(opts.maxChars) ? { maxChars: opts.maxChars } : undefined

  const splitRes = await splitDocumentIntoChunks(safeText, {
    strategy: opts.strategy,
    delimiter: opts.delimiter,
    overlapChars: isDelimiter ? opts.overlapChars : undefined,
    config,
    embedSentences,
  })
  let { chunks, sentences, sentenceVectors } = splitRes
  if (!Array.isArray(chunks)) chunks = []

  if (!Array.isArray(sentenceVectors) || sentenceVectors.length === 0) {
    if (Array.isArray(sentences) && sentences.length > 0) {
      try {
        sentenceVectors = await embedSentences(sentences)
      } catch (err) {
        log.warn(`[prepareDocChunksAndVectors] embedSentences 失败：${err.message}，降级 embedTexts`)
        sentenceVectors = []
      }
    }
  }

  const chunkTexts = chunks.map((c) => (typeof c.text === 'string' ? c.text : ''))
  let vectorsByChunk = []
  let okSentenceAvg = false
  let _reusedCount = 0 // ⑥ 增量复用命中的块数（未传 reuse Map 时为 0）
  if (Array.isArray(sentenceVectors) && sentenceVectors.length > 0 && chunks.length > 0) {
    try {
      vectorsByChunk = chunks.map((c) => {
        const s = Number.isInteger(c.sentenceStart) ? c.sentenceStart : 0
        const e = Number.isInteger(c.sentenceEnd) ? c.sentenceEnd : sentenceVectors.length
        const slice = sentenceVectors.slice(Math.max(0, s), Math.min(sentenceVectors.length, Math.max(s + 1, e)))
        if (slice.length === 0) return null
        return averageVectors(slice)
      })
      okSentenceAvg = vectorsByChunk.every((v) => Array.isArray(v) && v.length > 0)
    } catch (err) {
      log.warn(`[prepareDocChunksAndVectors] averageVectors 失败：${err.message}，降级 embedTexts`)
      okSentenceAvg = false
    }
  }
  if (!okSentenceAvg) {
    // ⑥ 增量复用：正文未变的块直接沿用旧向量，只嵌入新增/变化的块
    // （编辑场景改几个错别字也要全篇重嵌是纯浪费；语义细切路径上面已用句向量平均，不走这里）
    const reuse = opts.reuse instanceof Map ? opts.reuse : null
    let reusedCount = 0
    if (reuse) {
      vectorsByChunk = chunkTexts.map((t) => {
        const v = reuse.get(t)
        if (Array.isArray(v) && v.length > 0) {
          reusedCount++
          return v
        }
        return null
      })
    } else {
      vectorsByChunk = chunkTexts.map(() => null)
    }
    const missingIdx = []
    const missingTexts = []
    vectorsByChunk.forEach((v, i) => {
      if (!Array.isArray(v) || v.length === 0) {
        missingIdx.push(i)
        missingTexts.push(chunkTexts[i])
      }
    })
    if (missingTexts.length > 0) {
      try {
        const newVecs = await embedTexts(missingTexts)
        missingIdx.forEach((mi, k) => {
          vectorsByChunk[mi] = newVecs[k]
        })
      } catch (err) {
        log.warn(`[prepareDocChunksAndVectors] embedTexts 失败：${err.message}`)
        missingIdx.forEach((mi) => {
          vectorsByChunk[mi] = []
        })
      }
    }
    _reusedCount = reusedCount
  }

  let annots = []
  // ⑤ 问题按需生成：withQuestions=false 时跳过 LLM 标注（topic 用 heading 兜底、questions 置空），
  // 省一次 LLM 调用；普通资料库不需要检索增强问题，面试题库等场景再开
  // 问题向量化：questions 文本单独 embed 成 question_vector（检索锚点），否则入库时退化用 text 向量
  // 2026-09-06 追加 Q&A 结构化解析优先：一问一答语料的问题就在切片正文里（如「问：xxx\n答：xxx」），
  // 直接解析取用——零 LLM 成本、锚点比 LLM 假设问题更准；解析不出的块才走 LLM 标注（原逻辑不变）。
  // 解析不受 withQuestions 开关控制：开关语义是「是否花 LLM 成本生成假设问题」，
  // 文档自带的问题属于数据本身，始终写入 questions 作为 question_vector 检索锚点。
  const qaQuestions = chunks.map((c) => parseQaQuestion(c.text))
  const qaHitCount = qaQuestions.filter(Boolean).length
  if (qaHitCount > 0) {
    log.info(`[prepareDocChunksAndVectors] Q&A 结构化解析命中 ${qaHitCount}/${chunks.length} 块，问题直接取自正文`)
  }
  // 待 LLM 标注的块：仅解析未命中的（全部命中时为空数组 → 完全跳过 LLM 调用）
  const pendingChunks = chunks.filter((c, i) => !qaQuestions[i])
  let subAnnots = []
  if (opts.withQuestions !== false && pendingChunks.length > 0) {
    try {
      subAnnots = await generateChunkAnnotations(pendingChunks, { questionsPerChunk: chunkerConfig?.questionsPerChunk ?? 3 })
    } catch (err) {
      log.warn(`[prepareDocChunksAndVectors] generateChunkAnnotations 异常：${err.message}`)
      subAnnots = []
    }
  }
  // 组装：解析命中 → questions=[问题]（topic 用 heading 兜底，heading 空则用问题文本）；
  // 未命中 → LLM 标注（无标注时为 null，走下方兜底）
  let k = 0
  annots = chunks.map((c, i) => {
    if (qaQuestions[i]) {
      return {
        topic: (typeof c.heading === 'string' && c.heading.trim()) ? c.heading.trim() : qaQuestions[i],
        questions: [qaQuestions[i]],
      }
    }
    const a = subAnnots[k++] ?? null
    return a ? { topic: a.topic ?? '', questions: Array.isArray(a.questions) ? a.questions : [] } : null
  })
  if (!Array.isArray(annots) || annots.length !== chunks.length) {
    annots = chunks.map((c) => ({
      topic: (typeof c.heading === 'string' && c.heading.trim()) ? c.heading.trim() : ((c.text || '').slice(0, 30).trim() + ((c.text || '').length > 30 ? '…' : '')),
      questions: [],
    }))
  } else if (annots.some((a) => !a)) {
    // null 块（解析未命中且无 LLM 标注）补 heading 兜底，与原「LLM 失败/跳过」降级行为一致
    annots = annots.map((a, i) => {
      if (a) return a
      const c = chunks[i]
      return {
        topic: (typeof c.heading === 'string' && c.heading.trim()) ? c.heading.trim() : ((c.text || '').slice(0, 30).trim() + ((c.text || '').length > 30 ? '…' : '')),
        questions: [],
      }
    })
  }

  const chunkList = chunks.map((c, i) => ({
    idx: c.idx,
    heading: c.heading || '',
    text: c.text,
    preContext: typeof c.preContext === 'string' ? c.preContext : '',
    postContext: typeof c.postContext === 'string' ? c.postContext : '',
    topic: annots[i]?.topic || '',
    questions: Array.isArray(annots[i]?.questions) ? annots[i].questions : [],
    sentenceStart: Number.isInteger(c.sentenceStart) ? c.sentenceStart : 0,
    sentenceEnd: Number.isInteger(c.sentenceEnd) ? c.sentenceEnd : 0,
  }))

  // 问题向量：把每块的 questions（数组）join 成单条文本批量 embed，作为 question_vector 检索锚点。
  // 无 questions 的块占位 null，addChunks 侧对 null 退化用 text 向量（字段始终有值）；
  // embed 失败整批退化（warn 记录），与 addChunks 既有缺省语义一致。
  let questionVectors = null
  const qTexts = chunkList.map((c) =>
    Array.isArray(c.questions) && c.questions.length ? c.questions.join('\n') : null,
  )
  if (qTexts.some((t) => typeof t === 'string' && t.length > 0)) {
    try {
      const embedded = await embedTexts(qTexts.map((t) => t ?? ''))
      questionVectors = qTexts.map((t, i) => (t ? embedded[i] : null))
    } catch (err) {
      log.warn(`[prepareDocChunksAndVectors] 问题向量 embed 失败：${err.message}，question_vector 退化用 text 向量`)
      questionVectors = null
    }
  }

  return { chunkList, vectors: vectorsByChunk, questionVectors, reusedCount: _reusedCount }
}

/* ===================== 预览缓存（跨 action 保持切片状态） ===================== */

/**
 * 内存缓存：docId → { chunks, text, strategy, opts }
 * 用于 preview → adjust → confirm 之间保持用户已调整的切片结果，不重复 embed。
 * 进程级缓存；服务重启后清空（docId 仍可从 store.getDocument 读回 content 重新切片）。
 */
import { createTtlLruCache } from './cache.js'

const previewCache = createTtlLruCache({
  maxEntries: Number(process.env.PREVIEW_CACHE_MAX_ENTRIES) || 256,
  maxBytes: Number(process.env.PREVIEW_CACHE_MAX_BYTES) || 0,
  ttlMs: Number(process.env.PREVIEW_CACHE_TTL_MS) || 30 * 60 * 1000,
})

export function getCachedPreview(docId) {
  return docId ? previewCache.get(docId) || null : null
}

export function setCachedPreview(docId, data) {
  if (!docId) return
  previewCache.set(docId, data)
}

export function clearCachedPreview(docId) {
  if (docId) previewCache.delete(docId)
}

/* ===================== 处理模板（设计文档 §9 扩展：模板保存） ===================== */

/**
 * 切片处理模板：保存常用的 strategy/maxChars/delimiter 参数组合，下次一键套用。
 * 持久化于 server/data/doc-processor/templates.json（进程内缓存 + 写穿）。
 * 模板形如 { id, name, strategy, maxChars, delimiter, createdAt }。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TEMPLATES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'doc-processor', 'templates.json')

let _templates = null // [{id,name,strategy,maxChars,delimiter,createdAt}]

async function loadTemplates() {
  if (_templates) return _templates
  try {
    const raw = await readFile(TEMPLATES_FILE, 'utf8')
    const arr = JSON.parse(raw)
    _templates = Array.isArray(arr) ? arr : []
  } catch {
    // 文件不存在或损坏 → 空列表起步（损坏文件保留 .corrupt 备份）
    _templates = []
  }
  return _templates
}

async function persistTemplates() {
  await mkdir(path.dirname(TEMPLATES_FILE), { recursive: true })
  await writeFile(TEMPLATES_FILE, JSON.stringify(_templates || [], null, 2), 'utf8')
}

/** 模板列表（按创建时间倒序） */
export async function listTemplates() {
  const arr = await loadTemplates()
  return [...arr].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/**
 * 新建/更新模板。同名覆盖（更新参数与 updatedAt）。
 * @param {{ name:string, strategy?:string, maxChars?:number, delimiter?:string }} t
 */
export async function upsertTemplate(t) {
  const arr = await loadTemplates()
  const name = String(t?.name || '').trim()
  if (!name) throw new Error('模板名称不能为空')
  const strategy = t?.strategy === 'delimiter' ? 'delimiter' : 'semantic'
  const maxChars = Number.isFinite(Number(t?.maxChars)) && Number(t.maxChars) >= 100 && Number(t.maxChars) <= 5000 ? Number(t.maxChars) : undefined
  // delimiter 不 trim：\n / \n\n 类纯空白分隔符 trim 后会被灭掉
  const delimiter = strategy === 'delimiter' && typeof t?.delimiter === 'string' && t.delimiter.length > 0 ? t.delimiter : undefined
  const existing = arr.find((x) => x.name === name)
  if (existing) {
    existing.strategy = strategy
    if (maxChars !== undefined) existing.maxChars = maxChars
    existing.delimiter = delimiter
    existing.updatedAt = new Date().toISOString()
    await persistTemplates()
    return existing
  }
  const tpl = { id: `tpl_${Date.now().toString(36)}`, name, strategy, ...(maxChars !== undefined ? { maxChars } : {}), ...(delimiter ? { delimiter } : {}), createdAt: new Date().toISOString() }
  arr.push(tpl)
  await persistTemplates()
  return tpl
}

/** 删除模板（按 id），返回是否删到 */
export async function removeTemplate(id) {
  const arr = await loadTemplates()
  const i = arr.findIndex((x) => x.id === id)
  if (i < 0) return false
  arr.splice(i, 1)
  await persistTemplates()
  return true
}

/* ===================== 默认导出 ===================== */

export default {
  decodeText,
  decodeFilename,
  extractDocumentText,
  analyzeDocFeatures,
  stubStream,
  prependAnnotation,
  streamAnalyzeDoc,
  previewChunks,
  formatChunksPreview,
  chunksToAnnotation,
  parseAdjustmentInstruction,
  applyChunkAdjustment,
  exportChunksAsMarkdown,
  prepareDocChunksAndVectors,
  getCachedPreview,
  setCachedPreview,
  clearCachedPreview,
}

export { Readable }
