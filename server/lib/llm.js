import { streamText, generateText } from 'ai'
import { llmAvailable } from './config.js'
import { incr, observe } from './metrics.js'
import { childLogger } from './logger.js'
import { getChatModel } from './llmProvider.js'
import { stubStream, prependAnnotation } from './streamUtils.js'
import { stripToJson } from './textUtils.js'
import { ServiceUnavailableError } from './errors.js'

const log = childLogger('llm')

/**
 * LLM 调用指标打点（供 /api/metrics）：
 *  - timedGenerateText：generateText 全程计时（llm_generate_ms / llm_generate_total，按 op 分标签）
 *  - streamText 不等待流结束（返回即可），只记发起次数（llm_stream_total，按 fn 分标签）
 */
async function timedGenerateText(opts, op) {
  const t0 = performance.now()
  try {
    const r = await generateText(opts)
    observe('llm_generate_ms', Math.round(performance.now() - t0), { op })
    incr('llm_generate_total', { op })
    return r
  } catch (err) {
    incr('llm_generate_failures', { op })
    throw err
  }
}

/** 流式生成发起计数（streamText 返回即结束、不等待流完，只记次数不记耗时） */
async function countedStreamText(opts, fn) {
  incr('llm_stream_total', { fn })
  return streamText(opts)
}

/**
 * Fail-Fast 守卫（ADR-009）：模型未连接时显式报错，禁止降级为占位/假回答。
 * 「没有就是没有」——未配置 LLM 时，所有依赖 LLM 的能力直接返回 503 + 修复指引。
 */
function requireLLM() {
  if (!llmAvailable) {
    throw new ServiceUnavailableError(
      '模型未连接：对话与回答功能不可用。请在 server/.env 配置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 后重启后端。',
      'LLM_NOT_CONFIGURED',
    )
  }
}

/**
 * llm —— RAG / 对话流式生成
 *
 * 通过 config 接入任意 OpenAI 兼容端点（MiMo / DeepSeek / Moonshot / Qwen / 官方 OpenAI / 本地 Ollama），
 * 仅改环境变量即可切换，无需改代码。不可用时降级 stub 流式。
 *
 * 返回统一为 Vercel AI SDK data-stream 协议的 Web ReadableStream，
 * 前端 useChat 可直接消费。
 */

/**
 * "正文不复述命中元数据"统一约束（streamRagAnswer / streamInterviewAnswer 共用）。
 * 抽到模块级常量，避免两个函数各写一份、改一处需同步改多处。
 */
const NO_REF_RULE =
  `\n\n⚠ 强约束（严禁违反）：命中元数据（题目分类/难度/匹配度/题目答案原文/知识库的 Recall 片段原文/文件名/章节/相似度/排名编号）已经在回答正上方的独立"运行过程"面板用卡片展示给用户。\n` +
  `所以你绝对不要再在正文中输出任何与命中元数据重复的内容，包括但不限于：\n` +
  `  1. 任何 "1./2./3." "题目一/题目二" "来源一/来源二" "引用:" 编号式列表\n` +
  `  2. 完整抄录命中题目原文、答案原文、知识库 snippet 大段摘录\n` +
  `  3. 《文档名/书名》/ 章节标题 / Heading / 文件名 / 文档路径 / 相似度百分比 / Score / 命中 N 条 等统计数字\n` +
  `如果你产生了列出引用来源的冲动，直接用"（命中详情已在正上方面板展示）"一句话带过即可，禁止展开。\n` +
  `正文只输出：自然语言讲解 + 对问题的直接回答，条理清晰、要点突出。`

function buildContext(chunks) {
  return chunks
    .map((c, i) => {
      const titleParts = [`文档:${c.title}`]
      if (c.heading) titleParts.push(c.heading)
      titleParts.push(`相似度:${(c.score * 100).toFixed(1)}%`)
      if (c.topic) titleParts.push(`主题:${c.topic}`)
      const header = `【片段${i + 1}】(${titleParts.join(' | ')})`
      const parts = [header]
      if (c.preContext) parts.push(`〔上文〕${capCtx(c.preContext)}`)
      parts.push(c.snippet)
      if (c.postContext) parts.push(`〔下文〕${capCtx(c.postContext)}`)
      return parts.join('\n')
    })
    .join('\n\n')
}

/** 上下文扩展片段限长（避免 prompt 膨胀；chunker 默认 2 句 ≈ 50~100 字） */
function capCtx(s, max = 200) {
  const t = typeof s === 'string' ? s.trim() : ''
  if (!t) return ''
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t
}

/** 把结构化检索结果格式化为 LLM prompt 可用的"题目文本块" */
function buildInterviewContext(results) {
  if (!results.length) return '（未检索到任何结构化面试题）'
  return results
    .map(
      (r, i) =>
        `【题目${i + 1}】(分类:${r.category} | 难度:${r.difficulty}${r.company?.length ? ` | 出现在:${r.company.join('/')}` : ''} | 匹配度:${(r.score * 100).toFixed(1)}%)\n` +
        `题目: ${r.title}\n` +
        `参考答案: ${r.answer}\n` +
        (r.analysis ? `要点提示: ${r.analysis}\n` : ''),
    )
    .join('\n---\n')
}

/**
 * 把历史上下文窗口格式化为 LLM prompt 段。
 * @param {Array<{role:'user'|'assistant', content:string}>} history
 * @param {string} [currentQuery] —— 可选：若 history 最后一条就是它本身，则省略避免重复
 */
function buildHistoryContext(history, currentQuery) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const q = typeof currentQuery === 'string' ? currentQuery : ''
  const rows = []
  history.forEach((m, idx) => {
    // 如果 history 最后一条是 user 且内容 === currentQuery → 跳过（后面 prompt 会单独写本次用户问题）
    if (idx === history.length - 1 && m.role === 'user' && q && m.content === q) return
    const label = m.role === 'assistant' ? '【AI 助手】' : '【用户】'
    rows.push(`${label}: ${m.content}`)
  })
  if (rows.length === 0) return ''
  return `—— 历史对话上下文（最近几轮）——\n${rows.join('\n')}\n—— 以上为历史上下文，请基于其延续对话 ——\n\n`
}

/** 把会话记忆块拼进 system prompt 前部；无记忆时原样返回 */
function withMemory(system, memoryBlock) {
  return memoryBlock ? `${memoryBlock}\n\n${system}` : system
}

/**
 * 知识库 RAG 流式回答
 *
 * 与 streamInterviewAnswer 对称：先把"检索命中的 chunk 列表 + 耗时"作为 annotation 推到流头部，
 * 前端就能像截图那样画出「👁 显示运行过程」+ Recall slice N 卡片（含文件名 / Heading / Score 徽章 / 片段预览）。
 *
 * @param {{query:string, chunks:Array, searchMs?:number, history?:Array<{role:string,content:string}>, agentId?:string, memoryBlock?:string, persona?:string}} param0
 * @returns {ReadableStream<Uint8Array>} AI SDK data-stream
 */
export async function streamRagAnswer({ query, chunks, searchMs = 0, history, agentId, memoryBlock, persona, signal }) {
  requireLLM()
  // 给前端 FallbackSlice 卡片准备字段：title(文件名badge) / heading(来源/大纲badge) / score(分数) / snippet(正文预览)
  const resultsForFrontend = chunks.map((c, idx) => ({
    rank: idx + 1,
    id: c.id,
    docId: c.docId,
    title: c.title,
    docTitle: c.title,
    heading: c.heading,
    category: c.category,
    tags: c.tags,
    score: c.score,
    snippet: c.snippet,
  }))

  const annotation = {
    type: 'search_results',
    engine: 'knowledge-semantic',
    searchMs,
    query,
    total: chunks.length,
    results: resultsForFrontend,
  }

  const context = buildContext(chunks)
  const hasChunks = chunks.length > 0
  const historyCtx = buildHistoryContext(history, query)

  const result = await countedStreamText({
    model: getChatModel({ role: 'chat.rag', agentId }),
    abortSignal: signal,
    system: withMemory(
      // persona：自定义智能体的人设追加（P1 generic rag）；空串时零回归
      (persona ? `${persona.trim()}\n\n` : '') +
      `你是面试知识助手。严格基于提供的知识库片段回答用户问题；若片段不足以回答，请如实说明，不要编造。\n\n` +
      `显示规则（UI 层已单独处理，请严格遵守以免重复）：\n` +
      `- 如果检索到知识库内容，请在回答开头加上【📚 已检索知识库】标记。\n` +
      `- 如果未检索到相关内容，请明确说明「未检索到相关内容」。` +
      NO_REF_RULE +
      (historyCtx ? `\n\n注意：如果提供了「历史对话上下文」段落，请务必结合前文语境延续对话（例如"它"指代上一轮用户提到的概念），不要当作孤立的单轮问答。` : ''),
      memoryBlock,
    ),
    prompt: `${historyCtx}知识库片段：\n${context}\n\n用户问题：${query}`,
  }, 'rag')
  return prependAnnotation(result.toDataStream(), annotation)
}

/**
 * 通用对话流式回答（用于 /api/chat，非知识库智能体）
 * @param {{query:string, techStack?:string[], history?:Array<{role:string,content:string}>, agentId?:string, memoryBlock?:string, systemPrompt?:string}} param0
 *   systemPrompt：自定义智能体（Agent Spec）的完整人设；缺省时使用内置「资深面试官」默认（零回归）
 */
export async function streamChat({ query, techStack, history, agentId, memoryBlock, systemPrompt, signal }) {
  requireLLM()
  const historyCtx = buildHistoryContext(history, query)
  const base = systemPrompt?.trim()
    ? systemPrompt.trim() +
      (techStack?.length ? `\n用户关注的技术栈：${techStack.join('、')}。` : '')
    : (techStack?.length
      ? `你是一位资深面试官。结合以下技术栈作答：${techStack.join('、')}。`
      : '你是一位资深面试官，回答清晰专业。')
  const system = withMemory(
    base + (historyCtx ? ' 如果提供了「历史对话上下文」段落，请结合前文语境延续对话，不要当作孤立单轮。' : ''),
    memoryBlock,
  )
  const result = await countedStreamText({
    model: getChatModel({ role: 'chat.general', agentId }),
    system,
    prompt: `${historyCtx}${query}`,
  }, 'chat')
  return result.toDataStream()
}

/* ===================== 简历分析智能体 ===================== */

/** 把结构化报告渲染成可读 markdown（作为聊天气泡正文；卡片承载细节） */
function resumeNarrative(report) {
  if (!report) return ''
  const parts = []
  if (report.summary) parts.push(report.summary)
  if (report.jdMatch && Number.isFinite(Number(report.jdMatch.score))) {
    parts.push(`\n**岗位匹配度：${report.jdMatch.score}/100**`)
  }
  return parts.join('\n') || '已生成简历分析报告，详见下方卡片。'
}

/** 严格 JSON 生成 + 解析（最多 2 次尝试；仍失败 → 显式 503，绝不降级为假报告） */
async function generateStructuredJSON({ system, prompt, label, role, agentId, signal }) {
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text: out } = await timedGenerateText({ model: getChatModel({ role, agentId }), system, prompt, abortSignal: signal }, label)
      return JSON.parse(stripToJson(out))
    } catch (e) {
      lastErr = e
      log.warn(`[${label}] 第 ${attempt} 次生成/解析失败：${e.message}`)
    }
  }
  throw new ServiceUnavailableError(
    `${label}失败：模型输出无法解析为结构化结果（${lastErr?.message || '未知错误'}），请重试；若持续失败请检查模型质量或更换模型。`,
    'LLM_OUTPUT_INVALID',
  )
}

/**
 * 简历分析：单次 generateText 产出严格 JSON → 结构化报告卡片 + 简述。
 * @param {{resumeText?:string, jd?:string, query:string}} param0
 * @returns {ReadableStream} data-stream（含 2: resume_report 注解）
 */
export async function streamResumeAnalyze({ resumeText, jd, query, agentId, signal }) {
  requireLLM()
  const text = (resumeText || query || '').trim()
  const system =
    `你是一位资深技术招聘官兼简历顾问。请分析候选人简历并给出可执行的改进建议。\n` +
    `**只输出一个 JSON 对象，禁止任何解释文字、前后缀或 markdown 代码围栏**。字段严格如下：\n` +
    `{ "overall": 0到100的整数总评, "summary": "2-3句总体评价", "sections": [ { "title": "板块名", "items": ["要点", ...] } ], ` +
    `"jdMatch": null 或 { "score": 0到100整数, "matched": ["命中项", ...], "gaps": ["差距项", ...] }, ` +
    `"interviewQuestions": [ { "q": "基于简历可能追问的面试题", "why": "考察点" } ], ` +
    `"suggestions": [ { "level": "高|中|低", "issue": "问题", "fix": "改进建议" } ] }。\n` +
    (jd
      ? `候选人提供了目标岗位 JD，请在 jdMatch 中给出匹配度、命中与差距。`
      : `候选人未提供岗位 JD，jdMatch 字段输出 null。`)
  const prompt = `${jd ? `目标岗位 JD：\n${jd}\n\n` : ''}简历正文：\n${text || '（空）'}`

  const report = await generateStructuredJSON({
    system,
    prompt,
    label: '简历分析',
    role: 'chat.resume',
    agentId,
    signal,
  })

  return prependAnnotation(
    stubStream(resumeNarrative(report)),
    { type: 'resume_report', engine: 'resume-analysis', report },
  )
}

/* ===================== 模拟面试智能体 ===================== */

/**
 * 模拟面试：多轮问答走流式文本；finish=true 时产出结构化评分卡。
 * @param {{query:string, techStack?:string[], history?:Array, results?:Array, finish?:boolean}} param0
 * @returns {ReadableStream} data-stream
 */
export async function streamMockInterview({ query, techStack, history, results, finish, agentId, memoryBlock, signal }) {
  requireLLM()
  const stack = Array.isArray(techStack) && techStack.length
    ? techStack.join('、')
    : (results?.[0]?.category || '通用')
  const historyCtx = buildHistoryContext(history, query)

  // 结束面试 → 评分卡（单次 generateText 严格 JSON，失败重试 1 次，仍失败显式报错）
  if (finish) {
    const transcript = (Array.isArray(history) ? history : [])
      .map((m) => `${m.role === 'assistant' ? '面试官' : '候选人'}：${m.content}`)
      .join('\n')
    const system =
      `你是严格的面试官。基于下面这场「${stack}」模拟面试的完整记录给出综合评分。\n` +
      `**只输出一个 JSON 对象，无多余文字/围栏**，结构：\n` +
      `{ "overall": 0到100整数, "dimensions": [ { "name": "维度", "score": 0到100整数, "comment": "简评" } ], ` +
      `"highlights": ["亮点", ...], "improvements": ["改进项", ...], "verdict": "总结论与是否推荐进入下一轮" }。`
    const scores = await generateStructuredJSON({
      system,
      prompt: `面试记录：\n${transcript || '（无有效记录）'}`,
      label: '面试评分',
      role: 'chat.interview.scorecard',
      agentId,
      signal,
    })
    return prependAnnotation(
      stubStream(`面试结束，综合评分 **${scores.overall}/100**。详见下方评分卡。`),
      { type: 'interview_scorecard', engine: 'mock-interview', scores },
    )
  }

  // 正常问答轮：AI 面试官逐题提问 + 对上一条回答即时点评（记忆块让面试官了解候选人背景，如目标岗位/技术方向）
  const sampleQs = Array.isArray(results) && results.length
    ? `\n可参考的候选题目（择一提问或据其延展，不要照搬全部）：\n${results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}`
    : ''
  const hasAskedBefore = Array.isArray(history) && history.some((m) => m.role === 'assistant')
  const openingRule = hasAskedBefore
    ? `3) 你此前已提问过：先用 2-3 句点评候选人的上一条回答（优点+不足），然后立刻追问一个相关或更深入的问题；\n`
    : `3) 面试还没开始提问：候选人的第一条消息（如「开始面试」）不是问题，只是开场信号——不要试图"理解"它，收到即视为面试开始。本条回复必须直接抛出第一道${stack}面试题，以「第一题：」开头，然后附一句该题的考察点说明。禁止寒暄、确认语、"抱歉/无法理解"等任何应答；\n`
  const system =
    `你是一位专业、友好的「${stack}」技术面试官，正在进行多轮模拟面试。你的一切回复都是面试官台词。\n` +
    `铁律（违反即失败）：\n` +
    `- 永远不要说"抱歉/无法理解/请换个说法"之类的话——候选人的任何输入（包括"开始面试"）都在面试场景内，直接按规则应对；\n` +
    `- 每条回复必须以面试官动作收尾：要么是一个提问，要么是"点评 + 下一个提问"；绝不允许只点评不提问就结束；\n` +
    `规则：\n` +
    `1) 每次只聚焦一个问题，等候选人回答后再继续；\n` +
    `2) 点评要具体到候选人的回答内容（答对了什么/漏了什么），不要空泛；\n` +
    openingRule +
    `4) 口语化、单条简短，一次只问一题。\n` +
    `输出格式示例（开场）：\n` +
    `第一题：请讲讲 React 中 key 的作用，如果用数组索引作 key 会有什么问题？\n（考察点：列表 diff 机制与常见坑）\n` +
    `输出为自然语言，不要输出 JSON。` +
    sampleQs
  const result = await countedStreamText({
    model: getChatModel({ role: 'chat.interview.qa', agentId }),
    abortSignal: signal,
    system: withMemory(system, memoryBlock),
    prompt: `${historyCtx}候选人：${query}`,
  }, 'mock-interview')
  return result.toDataStream()
}

/**
 * 面试题检索智能体 —— 结构化题库搜索 + 知识库 RAG 兜底（二者结果同时作为 Recall 面板卡片给出）
 *
 * 流程：
 *  1. 生成 1~2 个 search_results annotation（结构化题库引擎 + 知识库语义引擎，看参数有没有传）
 *     → 同时 push 进一条 `2:` 前缀行，前端按 engine 分两块渲染"👁 运行过程"面板。
 *  2. 构建上下文/提示词，优先级：
 *       a. 若结构化题库有命中：以题目为主回答，适当引用知识库内容作为扩展背景。
 *       b. 若结构化题库 0 题但知识库有命中：明确说"题库未命中"，然后用知识库 RAG 片段正常回答问题
 *          （避免旧逻辑里"题库没找到就结束/只建议换关键词"，保证回答不空）
 *       c. 两者都 0：提示"两边都没命中，请上传文档或换关键词"。
 *  3. 流式返回 AI SDK data-stream。
 *
 * 正文与面板去重：提示词里明确强调——命中元数据（文件名/章节/相似度/题目分类/难度/匹配度/片段原文）
 * 已经在正上方面板用卡片展示给用户了，正文绝对不要再列「引用来源 1./2./3 / 文档名 / 相似度 / 片段摘录」。
 *
 * @param {Object} opts
 * @param {string} opts.query
 * @param {Array}  [opts.results=[]]        结构化题库命中结果
 * @param {string[]} [opts.techStack=[]]
 * @param {number} [opts.searchMs=0]        结构化题库耗时
 * @param {Array}  [opts.ragChunks=[]]      知识库语义检索命中 chunks（兜底用）
 * @param {number} [opts.ragSearchMs=0]     知识库检索耗时
 * @param {Array}  [opts.history=[]]        历史上下文窗口
 * @param {string} [opts.agentId]           智能体 id（模型三级路由用）
 * @param {string} [opts.memoryBlock]       会话记忆块（召回结果为空时不传）
 */
export async function streamInterviewAnswer({
  query,
  results = [],
  techStack = [],
  searchMs = 0,
  ragChunks = [],
  ragSearchMs = 0,
  history = [],
  agentId,
  memoryBlock,
  signal,
}) {
  const hasInterview = results.length > 0
  const hasRag = ragChunks.length > 0

  // ---- annotation：结构化题库（永远发，0 道也发出来让面板显示"结构化 0 题"的统计）----
  const interviewAnnot = {
    type: 'search_results',
    engine: 'structured-question-bank',
    searchMs,
    query,
    total: results.length,
    results: results.map((r) => ({
      rank: r.rank,
      id: r.id,
      title: r.title,
      category: r.category,
      tags: r.tags,
      difficulty: r.difficulty,
      company: r.company,
      source: r.source,
      answer: r.answer,
      analysis: r.analysis,
      score: r.score,
    })),
  }

  // ---- annotation：知识库（只有调用方做了 rag 检索才发，不做就不显示这张卡）----
  const ragAnnot = hasRag
    ? {
        type: 'search_results',
        engine: 'knowledge-semantic',
        searchMs: ragSearchMs,
        query,
        total: ragChunks.length,
        results: ragChunks.map((c, idx) => ({
          rank: idx + 1,
          id: c.id,
          docId: c.docId,
          title: c.title,
          docTitle: c.title,
          heading: c.heading,
          category: c.category,
          tags: c.tags,
          score: c.score,
          snippet: c.snippet,
        })),
      }
    : null

  const annotations = ragAnnot ? [interviewAnnot, ragAnnot] : [interviewAnnot]

  // ---- 上下文块 / Prompt ----
  requireLLM()
  const interviewContext = buildInterviewContext(results)
  const ragContext = hasRag ? buildContext(ragChunks) : ''
  const historyCtx = buildHistoryContext(history, query)
  const techStr =
    techStack?.length ? `当前筛选技术栈：${techStack.join('、')}。\n` : ''
  const HISTORY_NOTICE = historyCtx
    ? '\n\n- 另外：如果提供了「历史对话上下文」段落，请务必结合前文语境延续对话（例如"它"指代上一轮提到的概念、"还有吗"指继续列举同类题目等），不要当作孤立单轮。'
    : ''

  let system = ''
  let prompt = ''

  if (hasInterview && hasRag) {
    system =
      `你是资深面试官。回答时"结构化面试题库命中"为主，"知识库补充材料"为辅。\n\n` +
      `核心信息说明：命中 ${results.length} 道结构化题目，并从知识库找到 ${ragChunks.length} 条补充材料（具体命中条目已在正上方独立面板卡片展示，正文不复述）。\n` +
      `- 重点参考命中题目中的参考答案组织答案；知识库材料仅作为背景/扩展补充，不要喧宾夺主。\n` +
      `${techStr}` + NO_REF_RULE + HISTORY_NOTICE
    prompt =
      `${historyCtx}一、命中的结构化面试题：\n${interviewContext}\n\n` +
      `二、知识库补充材料：\n${ragContext}\n\n` +
      `用户问题：${query}`
  } else if (hasInterview && !hasRag) {
    system =
      `你是资深面试官。下面提供了本次从"结构化面试题库"中命中的 ${results.length} 道题目（命中详情已在正上方面板展示，正文不复述），请严格以此为参考回答用户。\n\n` +
      `- 开头一句话点出"已从结构化题库命中 N 道相关题目"即可（不用逐题写编号/标题）。\n` +
      `${techStr}` + NO_REF_RULE + HISTORY_NOTICE
    prompt = `${historyCtx}命中的结构化面试题：\n${interviewContext}\n\n用户问题：${query}`
  } else if (!hasInterview && hasRag) {
    // 注意：此分支**刻意不挂 NO_REF_RULE**——知识库片段常为「问/答」式 FAQ，
    // 片段中的"答"就是答案本体，要求模型直接给出（复述"答"是预期行为）；
    // NO_REF_RULE 禁复述片段原文的规则在此会答非所问（见 2026-09-03「还招外卖员吗」案例）。
    system =
      `你是知识库问答助手。用户的提问命中了知识库片段（命中卡片已在正上方面板展示；正文中不要复述检索过程）。\n\n` +
      `回答规则：\n` +
      `- 直接回答用户的问题本身；禁止出现"根据片段N""知识库召回/检索到""未在结构化题库中匹配到题目"这类检索过程表述。\n` +
      `- 片段常为「问:…／答:…」式FAQ：当某片段的问句与用户问题相同或高度相似时，直接以该片段的"答"为答案主体（可按对话口吻轻微润色），并融合其他片段的相关信息一并补充（如薪资范围、要求）。\n` +
      `- 禁止空泛套话：片段里已有答案（如薪资范围、区域要求）就直接给出；不要用"会因…而有所差异，请提供更多信息"搪塞，除非片段确实没有答案。\n` +
      `- 确实不足时才如实说明还缺什么，并给出下一步建议；不要编造。\n` +
      `${techStr}` + HISTORY_NOTICE
    prompt = `${historyCtx}知识库片段：\n${ragContext}\n\n用户问题：${query}`
  } else {
    system =
      `你是资深面试官。当前关键词"结构化题库"和"知识库"两边都未命中任何匹配内容。\n\n` +
      `规则：\n` +
      `- 明确告知用户两边都没命中，建议：1. 换关键词；2. 到"知识库"智能体上传更详细的面经/讲稿文档；3. 到题库 JSON 补题。\n` +
      `- 语气友好，不要编造题目或知识点。\n` +
      `${techStr}` + (historyCtx ? '如有历史上下文，请结合前几轮对话给出建议。' : '')
    prompt = `${historyCtx}用户问题：${query}`
  }

  const inner = await countedStreamText({
    model: getChatModel({ role: 'chat.interview', agentId }),
    abortSignal: signal,
    system: withMemory(system, memoryBlock),
    prompt,
  }, 'interview')
  return prependAnnotation(inner.toDataStream(), annotations)
}

/**
 * 批量给切片生成 topic + questions 标注（阶段 1：入库时离线标注）。
 *
 * - temperature=0，要求输出严格 JSON：`[{"topic":"...","questions":["q1","q2","q3"]}, ...]`
 * - 超时 / 模型不可用 / JSON 解析失败 → 直接降级：
 *     topic = chunk.heading || chunk.text.slice(0,30)+'…'
 *     questions = []
 * - 绝不抛异常，保证后续入库链路不阻塞。
 *
 * @param {Array<{idx:number, heading?:string, text:string}>} chunks
 * @param {{questionsPerChunk?:number, timeoutMs?:number}} opts
 * @returns {Promise<Array<{topic:string, questions:string[]}>>} 长度与 chunks 一一对应
 */
export async function generateChunkAnnotations(chunks, { questionsPerChunk = 3, timeoutMs = 20000, agentId = 'doc-processor' } = {}) {
  const safeChunks = Array.isArray(chunks) ? chunks : []
  // 默认降级结果（先占好位置，LLM 成功时再按 idx 覆盖）
  const fallback = (c) => ({
    topic: (typeof c.heading === 'string' && c.heading.trim())
      ? c.heading.trim()
      : (typeof c.text === 'string' ? (c.text.slice(0, 30).trim() + (c.text.length > 30 ? '…' : '')) : ''),
    questions: [],
  })
  const results = safeChunks.map(fallback)
  if (!safeChunks.length) return results

  requireLLM() // 无 LLM 显式报错；调用方（prepareDocChunksAndVectors）catch 后按「无标注」降级并记录日志

  const qpc = Math.max(1, Math.min(10, Number.isFinite(questionsPerChunk) ? questionsPerChunk : 3))

  // 分批调用：本地小模型单次生成过多块的 (topic+问题) JSON 输出 token 过大，
  // 在超时预算内几乎必失败（实测 16 块 8s 全量调用超时 → questions 静默丢失）。
  // 每批 4 块独立调用、独立超时，失败批仅自身降级不影响其他批。
  const BATCH_SIZE = 4
  for (let s = 0; s < safeChunks.length; s += BATCH_SIZE) {
    const batch = safeChunks.slice(s, s + BATCH_SIZE)
    try {
      await _annotateBatch(batch, s, qpc, timeoutMs, agentId, results)
    } catch (err) {
      log.warn(
        `[llm.generateChunkAnnotations] 批次 ${s}~${s + batch.length - 1} 生成失败（${err.message}），该批降级 heading/30字 兜底`,
      )
    }
  }
  return results
}

/**
 * 单批标注：构造 prompt → LLM 调用（race 超时兜底）→ 解析 JSON 写回全局 results。
 * batch 内切片在 prompt 中使用全局 idx（baseIdx 起），LLM 输出按 idx 对齐写回。
 * 抛错由调用方（generateChunkAnnotations 分批循环）捕获并降级该批。
 */
async function _annotateBatch(batch, baseIdx, qpc, timeoutMs, agentId, results) {
  // 只送有意义的字段：heading + text 前 600 字（避免 prompt 爆长）
  const promptPayload = batch.map((c, i) => ({
    idx: baseIdx + i,
    heading: c.heading || '',
    text: typeof c.text === 'string' ? c.text.slice(0, 600) : '',
  }))

  const prompt =
    `你是知识切片标注专家。请为以下每个"文档切片"生成：\n` +
    `1) topic：一句话概括本段核心主题（不超过 40 字，不含编号）；\n` +
    `2) questions：${qpc} 个用户大概率会问的、本段能回答的独立问题（每个问题不超过 60 字，自问自答式，不要编号）。\n\n` +
    `要求：\n` +
    `- 输出 STRICT JSON，不要任何 markdown 代码块/解释文字。\n` +
    `- 根是数组，长度与输入切片数一致（顺序严格相同，用 idx 对齐也可），每项形如 {"idx":0,"topic":"...","questions":["q1","q2","q3"]}。\n` +
    `- questions 必须是完整问句，不要空串不要重复。\n\n` +
    `输入切片 JSON：\n${JSON.stringify(promptPayload, null, 0)}\n`

  let raw = ''
  // 用 Promise.race 兜底超时（abortSignal 在 streamText 上实测不可靠，会卡死）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const llmPromise = timedGenerateText({
    model: getChatModel({ role: 'chat.annotations', agentId }),
    temperature: 0,
    prompt,
    abortSignal: controller.signal,
  }, 'chunk-annotations')

  // 关键：abort 会让 llmPromise reject。外层虽有 try/catch，但只要还有**任何一处**
  // 引用它却没挂 rejection handler，就会变成 unhandled rejection 直接打挂进程
  // （实测：上传 PDF 触发标注超时，服务当场崩溃）。这里显式标记「已处理」，
  // 真正的失败仍由下面的 race 捕获并降级。
  llmPromise.catch(() => {})

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`generateText 超时 ${timeoutMs}ms`)), timeoutMs + 2000)
    // 让 Promise.race 完成后能清理这个 timer。同样要吞掉 reject，否则 abort 时
    // 这条链会把进程带崩。
    Promise.race([llmPromise])
      .finally(() => clearTimeout(t))
      .catch(() => {})
  })

  const result = await Promise.race([llmPromise, timeoutPromise])
  clearTimeout(timer)
  raw = result?.text ?? ''
  if (!raw) return
  // 尝试解 JSON：容忍前后 ```json 包裹 / 非 JSON 前缀
  const jsonStr = stripToJson(raw)
  const arr = JSON.parse(jsonStr)
  if (!Array.isArray(arr)) return
  for (const it of arr) {
    const i = Number.isInteger(it?.idx) ? it.idx : -1
    if (i < 0 || i >= results.length) continue
    const topic = typeof it.topic === 'string' ? it.topic.trim().slice(0, 120) : ''
    const questions = Array.isArray(it.questions)
      ? it.questions
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter((q) => q && q.length <= 160)
          .slice(0, qpc + 2)
      : []
    if (topic) results[i].topic = topic
    if (questions.length) results[i].questions = questions
  }
}

/* ===================== 会话记忆（M2 / ADR-007） ===================== */

/** 把对话轮压成「角色：内容」的紧凑文本，单条截断防 prompt 膨胀 */
function memoryDialog(turns, perTurnCap = 500) {
  return (Array.isArray(turns) ? turns : [])
    .map((m) => `${m.role === 'assistant' ? '助手' : '用户'}：${String(m.content ?? '').slice(0, perTurnCap)}`)
    .join('\n')
}

/**
 * 短期层：滚动摘要生成。把「已有摘要 + 新增对话」合并为一份连贯摘要（纯文本）。
 * 失败向上抛（memoryService 记日志、游标不前进、下一轮重试），不做静默兜底。
 */
export async function summarizeSession({ prevSummary, turns, budgetChars = 600, role, agentId }) {
  requireLLM()
  const system =
    '你负责维护一段对话的滚动摘要。把「已有摘要」与「新增对话」合并为一份连贯摘要：' +
    '保留用户的目标、偏好、约束与关键结论，去掉寒暄与重复；只输出摘要正文，禁止任何前缀、解释或列表符号。'
  const prompt =
    `已有摘要（可能为空）：\n${prevSummary || '（无）'}\n\n新增对话：\n${memoryDialog(turns)}\n\n` +
    `请输出合并后的摘要，不超过 ${Math.ceil(budgetChars)} 字。`
  const { text } = await timedGenerateText({ model: getChatModel({ role, agentId }), system, prompt }, 'summarize')
  const out = String(text ?? '').trim()
  if (!out) {
    throw new ServiceUnavailableError(
      '会话摘要生成失败：模型返回空内容，请重试或检查模型。',
      'LLM_OUTPUT_INVALID',
    )
  }
  return out.slice(0, budgetChars)
}

/**
 * 长期层：事实提炼。从对话轮中提炼值得跨会话记住的用户事实，
 * 输出 [{ text, scope }]；scope=global 跨会话共享，session 仅本会话。
 * 没有值得记的内容时返回空数组（合法结果，非失败）。
 */
export async function extractMemories({ turns, maxFacts = 5, role, agentId }) {
  requireLLM()
  const system =
    '你负责从对话中提炼值得长期记住的用户事实（如身份、目标、偏好、约束、项目背景）。\n' +
    '**只输出一个 JSON 对象，禁止任何解释文字或 markdown 围栏**，格式严格如下：\n' +
    '{ "memories": [ { "text": "一句独立可读的事实", "scope": "global或session" } ] }\n' +
    `规则：每条事实必须自带主语、脱离上下文也能读懂；只记新信息，不记寒暄；最多 ${maxFacts} 条；没有值得记的就输出 { "memories": [] }。\n` +
    'scope 判定：用户稳定的偏好/画像/长期目标用 global；只与当前话题/会话相关的事实用 session。'
  const obj = await generateStructuredJSON({
    system,
    prompt: `对话内容：\n${memoryDialog(turns, 600) || '（无）'}`,
    label: '记忆提炼',
    role,
    agentId,
  })
  const list = Array.isArray(obj?.memories) ? obj.memories : []
  const out = []
  for (const it of list) {
    const t = typeof it?.text === 'string' ? it.text.trim().slice(0, 300) : ''
    if (!t) continue
    out.push({ text: t, scope: it?.scope === 'global' ? 'global' : 'session' })
  }
  return out.slice(0, maxFacts)
}

/* ===================== LLM Wiki（知识网络词条生成，wikiBuilder 调用） ===================== */

/**
 * 带超时的 generateText：Promise.race 竞速 + AbortController（wiki 生成任务
 * 专用，防单个 LLM 调用挂死拖住整个后台 job）。unhandled rejection 防护
 * 与 _annotateBatch 同款：llmPromise 显式挂 rejection handler + timeout
 * 链自清理，真正的失败仍由 race 捕获向上抛。
 */
async function generateTextWithTimeout(opts, op, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const llmPromise = timedGenerateText({ ...opts, abortSignal: controller.signal }, op)
  llmPromise.catch(() => {})
  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`generateText 超时 ${timeoutMs}ms`)), timeoutMs + 2000)
    Promise.race([llmPromise]).finally(() => clearTimeout(t)).catch(() => {})
  })
  try {
    return await Promise.race([llmPromise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 实体抽取：为一批切片识别核心概念/术语/技术/产品等 wiki 词条候选。
 * 输入 [{ idx, heading, text }]，输出按 idx 对齐的 Map：idx → [{ name, type, context }]。
 * @param {Array<{idx:number,heading?:string,text:string}>} batch 一批切片（建议 ≤4）
 * @param {{entitiesPerChunk?:number, timeoutMs?:number, agentId?:string}} [opts]
 * @returns {Promise<Map<number, Array<{name:string,type:string,context:string}>>>}
 */
export async function extractWikiEntities(batch, { entitiesPerChunk = 5, timeoutMs = 60000, agentId } = {}) {
  requireLLM()
  const prompt =
    `你是知识库实体抽取专家。请从以下每个"文档切片"中识别值得建百科词条的核心实体：\n` +
    `技术概念、框架、语言、算法、协议、产品、工具、人物、机构、业务领域术语等。\n\n` +
    `要求：\n` +
    `- 输出 STRICT JSON，不要任何 markdown 代码块/解释文字。\n` +
    `- 根是数组，每项形如 {"idx":0,"entities":[{"name":"实体名","type":"concept|tech|product|person|org|term","context":"该实体出现的原句（截取含实体的一句话，不超过 80 字）"}]}。\n` +
    `- 每个切片最多 ${entitiesPerChunk} 个实体；只抽"会被单独提问/值得解释"的实体，跳过普通词。\n` +
    `- name 用原文中最规范完整的写法；context 必须是原文子串。\n` +
    `- 没有值得抽的实体就输出空数组 entities:[]。\n\n` +
    `输入切片 JSON：\n${JSON.stringify(batch, null, 0)}\n`
  const r = await generateTextWithTimeout(
    { model: getChatModel({ role: 'chat.wiki', agentId }), temperature: 0, prompt },
    'wiki-extract',
    timeoutMs,
  )
  const out = new Map()
  const arr = JSON.parse(stripToJson(r?.text ?? ''))
  if (!Array.isArray(arr)) return out
  for (const it of arr) {
    const i = Number.isInteger(it?.idx) ? it.idx : -1
    if (i < 0 || !batch.some((b) => b.idx === i)) continue
    const entities = (Array.isArray(it?.entities) ? it.entities : [])
      .map((e) => ({
        name: typeof e?.name === 'string' ? e.name.trim().slice(0, 80) : '',
        type: typeof e?.type === 'string' ? e.type.trim().slice(0, 20) : 'term',
        context: typeof e?.context === 'string' ? e.context.trim().slice(0, 120) : '',
      }))
      .filter((e) => e.name.length >= 2)
      .slice(0, entitiesPerChunk)
    out.set(i, entities)
  }
  return out
}

/**
 * 实体归一：把不同写法/别名的同名实体合并成组（如 "RAG" 与 "检索增强生成"）。
 * @param {string[]} names 去重后的实体名列表（建议每批 ≤40）
 * @param {{timeoutMs?:number, agentId?:string}} [opts]
 * @returns {Promise<Array<{canonical:string, aliases:string[]}>>} 归组结果（并集=输入集合）
 */
export async function normalizeWikiEntities(names, { timeoutMs = 60000, agentId } = {}) {
  requireLLM()
  const prompt =
    `你是知识库实体归一专家。下面是知识库抽取出的实体名列表，请把指向同一事物的名字合并成一组：\n` +
    `- 同一概念的中英文写法（"RAG" 与 "检索增强生成"）\n` +
    `- 简称与全称（"Milvus" 与 "Milvus 向量数据库"若指同一产品）\n` +
    `- 大小写/分隔符差异（"NodeJS" 与 "Node.js"）\n\n` +
    `要求：\n` +
    `- 输出 STRICT JSON，不要任何 markdown 代码块/解释文字。\n` +
    `- 根是数组，每项形如 {"canonical":"规范名","aliases":["其他写法1","其他写法2"]}。\n` +
    `- canonical 选用最规范常用、信息量充分的写法；aliases 只放列表中出现过的其他写法。\n` +
    `- 没有可合并的就单项自成一组（aliases 为空数组）；不得发明列表中不存在的名字。\n` +
    `- 所有输入名字都必须恰好出现在某一个组里（canonical 或 aliases），不重不漏。\n\n` +
    `输入实体名 JSON：\n${JSON.stringify(names, null, 0)}\n`
  const r = await generateTextWithTimeout(
    { model: getChatModel({ role: 'chat.wiki', agentId }), temperature: 0, prompt },
    'wiki-normalize',
    timeoutMs,
  )
  const groups = []
  const arr = JSON.parse(stripToJson(r?.text ?? ''))
  if (!Array.isArray(arr)) throw new Error('归一输出不是数组')
  const seen = new Set()
  for (const g of arr) {
    const canonical = typeof g?.canonical === 'string' ? g.canonical.trim().slice(0, 80) : ''
    if (!canonical) continue
    const aliases = (Array.isArray(g?.aliases) ? g.aliases : [])
      .map((a) => (typeof a === 'string' ? a.trim().slice(0, 80) : ''))
      .filter((a) => a && a !== canonical)
    const all = [canonical, ...aliases].filter((n) => {
      if (seen.has(n)) return false
      seen.add(n)
      return true
    })
    if (all.length) groups.push({ canonical: all[0], aliases: all.slice(1) })
  }
  // 兜底：LLM 漏掉的名字各自成组（保证不重不漏的输入覆盖）
  for (const n of names) {
    if (!seen.has(n)) groups.push({ canonical: n, aliases: [] })
  }
  return groups
}

/**
 * 词条摘要：根据词条名、别名与全部提及上下文，生成百科式摘要。
 * @param {{name:string, aliases?:string[], contexts:string[]}} entry
 * @param {{budgetChars?:number, timeoutMs?:number, agentId?:string}} [opts]
 * @returns {Promise<string>} 摘要正文（≤ budgetChars）
 */
export async function summarizeWikiEntry({ name, aliases = [], contexts }, { budgetChars = 400, timeoutMs = 60000, agentId } = {}) {
  requireLLM()
  const ctx = (Array.isArray(contexts) ? contexts : [])
    .map((c) => String(c ?? '').trim())
    .filter(Boolean)
    .slice(0, 24) // 提及上下文截断（防 prompt 膨胀）
  const prompt =
    `请为知识库词条「${name}」写一段百科式摘要。\n\n` +
    `别名：${aliases.length ? aliases.join('、') : '（无）'}\n\n` +
    `知识库中提及该词条的原文片段：\n${ctx.map((c, i) => `【${i + 1}】${c}`).join('\n')}\n\n` +
    `要求：\n` +
    `- 优先依据上述原文片段下定义、讲清楚它在本知识库语境下的含义与作用。\n` +
    `- 只输出摘要正文（不超过 ${budgetChars} 字），禁止标题、编号列表、markdown 符号与"摘要："之类前缀。\n` +
    `- 原文片段信息不足时，可用你的通用知识补充，但不要与原文冲突。`
  const r = await generateTextWithTimeout(
    { model: getChatModel({ role: 'chat.wiki', agentId }), temperature: 0.2, prompt },
    'wiki-summary',
    timeoutMs,
  )
  const out = String(r?.text ?? '').trim()
  if (!out) {
    throw new ServiceUnavailableError(
      `词条「${name}」摘要生成失败：模型返回空内容`,
      'LLM_OUTPUT_INVALID',
    )
  }
  return out.slice(0, budgetChars)
}

/**
 * 会话复盘报告生成（LLM 聚合）：把整段会话消息 + 逐题质量评分聚合为备考复盘。
 * 与 mock-interview 的评分卡互补：评分卡是"面试官视角当场打分"，复盘是"备考视角事后总结"。
 * 失败向上抛（调用方转 5xx），不做静默兜底。
 */
export async function generateSessionReport({ messages, reflections, agentName }) {
  const dialog = (Array.isArray(messages) ? messages : [])
    .map((m) => `${m.role === 'assistant' ? '助手' : '用户'}：${String(m.content ?? '').slice(0, 600)}`)
    .join('\\n')
  const reflines = (Array.isArray(reflections) ? reflections : [])
    .map((r) => `- 问：${String(r.question ?? '').slice(0, 80)}｜评分 ${r.score ?? '-'}｜${r.action ?? ''}${r.issues?.length ? `｜问题：${r.issues.join('、')}` : ''}`)
    .join('\\n')
  const system =
    '你是面试备考教练。根据一段完整的会话记录与逐题质量评分，生成备考复盘报告。\n' +
    '只输出 STRICT JSON 对象（无 markdown 围栏），结构：\n' +
    '{"overall": "总体评价（2~3 句）", "topics": ["涉及的知识点"], "strengths": ["做得好的点"], ' +
    '"weaknesses": ["薄弱点/反复出错的点"], "suggestions": ["具体可执行的改进建议"], ' +
    '"perTurn": [{"question": "问题摘要", "grade": "好/一般/差", "note": "一句话点评"}]}\n' +
    '规则：只依据会话内容与评分，不编造；weaknesses 优先从低分与兜底/拒答条目归纳；语言平实。'
  const prompt =
    `智能体类型：${agentName || '通用'}

【会话记录】
${dialog || '（空）'}

【逐题质量评分】
${reflines || '（无评分记录）'}`

  const { text } = await generateText({
    model: getChatModel({ role: 'chat.general' }),
    temperature: 0,
    prompt: system + '\n\n' + prompt,
  })
  const parsed = JSON.parse(stripToJson(text))
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.perTurn)) {
    throw new ServiceUnavailableError('复盘报告生成失败：模型输出结构不完整（LLM_OUTPUT_INVALID）', 'LLM_OUTPUT_INVALID')
  }
  return {
    overall: String(parsed.overall ?? ''),
    topics: (parsed.topics ?? []).map(String).slice(0, 12),
    strengths: (parsed.strengths ?? []).map(String).slice(0, 8),
    weaknesses: (parsed.weaknesses ?? []).map(String).slice(0, 8),
    suggestions: (parsed.suggestions ?? []).map(String).slice(0, 8),
    perTurn: (parsed.perTurn ?? []).slice(0, 50),
    agentName: agentName ?? '',
  }
}

export { llmAvailable }
