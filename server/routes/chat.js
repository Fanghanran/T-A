import { Router } from 'express'
import * as store from '../lib/vectorStore.js'
import * as sessionStore from '../lib/sessionStore.js'
import { streamRagAnswer, streamChat, streamInterviewAnswer } from '../lib/llm.js'
import {
  prepareDocChunksAndVectors,
  analyzeDocFeatures,
  streamAnalyzeDoc,
  previewChunks,
  formatChunksPreview,
  chunksToAnnotation,
  parseAdjustmentInstruction,
  applyChunkAdjustment,
  exportChunksAsMarkdown,
  getCachedPreview,
  setCachedPreview,
  clearCachedPreview,
} from '../lib/docProcessor.js'
import { stubStream, prependAnnotation } from '../lib/streamUtils.js'
import { llmAvailable } from '../lib/config.js'
import { unifiedSearch } from '../lib/unifiedSearch.js'
import { workflowRegistry } from '../lib/management/registry.js'
import { runDocAgent, streamOpReport, DOC_WORKFLOW_NAME } from '../lib/workflows/docWorkflow.js'
import { runDocPlanAgent, DOC_PLAN_WORKFLOW_NAME } from '../lib/workflows/docPlanWorkflow.js'
import { buildDocContext } from '../lib/workflows/docWorkflowShared.js'
import { extractTaskIntents } from '../lib/intents.js'
import { pipeStream, dbg } from './shared.js'
import { childLogger } from '../lib/logger.js'
import { agentRegistry } from '../lib/agents/agentRegistry.js'
import { knowledgeBaseAgent } from '../lib/agents/builtin/knowledgeBase.js'
import { interviewRetrievalAgent } from '../lib/agents/builtin/interviewRetrieval.js'
import { defaultChatAgent } from '../lib/agents/builtin/defaultChat.js'
import { resumeAnalysisAgent } from '../lib/agents/builtin/resumeAnalysis.js'
import { mockInterviewAgent } from '../lib/agents/builtin/mockInterview.js'
import { validateChatBody, rateLimiters } from '../lib/security.js'

/**
 * routes/chat —— 通用对话入口（前端 useChat 调用）
 *
 * POST /api/chat
 *   Body: { messages, agentName, techStack?, sessionId?, opReport?, docId?, text?, action?... }
 *   响应头 x-session-id：本对话所属会话 id（首次或新会话都会回传）
 *
 * 按智能体分发（agentName）—— 通过 agentRegistry 插件化路由：
 *   registerAgent() 在模块加载时自动注册所有内置智能体。
 *   resolveAgent(name) 匹配 id / name / alias → handler(ctx) → pipeStream(res, stream, opts)
 *
 * 会话语义：请求前 append user 消息（防丢），流结束后经 pipeStream 回调
 * 持久化完整 assistant 文本 + 注解。
 */

const log = childLogger('chat')

/* ===================== 内置智能体注册 ===================== */

// 知识库 RAG 智能体
agentRegistry.registerAgent(knowledgeBaseAgent)

// 面试题检索智能体
agentRegistry.registerAgent(interviewRetrievalAgent)

// 文档处理智能体（动态注入 L5+ 依赖到 ctx）
agentRegistry.registerAgent({
  id: 'doc-processor',
  name: 'doc-processor',
  description: '文档处理智能体：opReport / 双工作流分发 / action 关键词路由',
  aliases: ['文档处理'],
  async handler(ctx) {
    const {
      query, history, req, res, sessionId, onAssistantDone,
      pipeStream, dbg,
      // L5+ 依赖由 chat.js（L8）注入 ctx：
      workflowRegistry, runDocAgent, runDocPlanAgent, streamOpReport,
      buildDocContext, extractTaskIntents,
      DOC_WORKFLOW_NAME, DOC_PLAN_WORKFLOW_NAME,
    } = ctx

    const opts = { sessionId, onAssistantText: onAssistantDone }

    // 操作栏回报
    const opReport = req.body?.opReport
    if (opReport && typeof opReport === 'object' && typeof opReport.op === 'string') {
      dbg(`[doc-processor] opReport op=${opReport.op} | docId=${opReport.docId || '(无)'}`)
      return pipeStream(res, await streamOpReport({ opReport, history }), opts)
    }

    // 双工作流分发
    if (llmAvailable) {
      const agentDocId = typeof (req.body ?? {}).docId === 'string' ? req.body.docId.trim() : ''
      const agentText = typeof (req.body ?? {}).text === 'string' ? req.body.text : ''
      const planOn = workflowRegistry.isEnabled(DOC_PLAN_WORKFLOW_NAME)
      const reactOn = workflowRegistry.isEnabled(DOC_WORKFLOW_NAME)
      let agentStream = null
      if (planOn && buildDocContext(agentDocId, agentText).resolveText().trim() && extractTaskIntents(query).length >= 2) {
        dbg(`[doc-processor] 复合任务 → 计划工作流（${DOC_PLAN_WORKFLOW_NAME}）`)
        agentStream = await runDocPlanAgent({ query, docId: agentDocId, text: agentText, history })
      } else if (reactOn) {
        agentStream = await runDocAgent({ query, docId: agentDocId, text: agentText, history })
      }
      if (agentStream) {
        return pipeStream(res, agentStream, opts)
      }
    }

    // ---------- action 关键词路由（stub 兜底）----------
    return handleActionRouter({ query, history, req, res, sessionId, onAssistantDone, pipeStream, dbg, ctx })
  },
})

// 通用对话兜底
agentRegistry.registerAgent(defaultChatAgent)

// 简历分析（上传/粘贴简历 → 结构化报告卡片）
agentRegistry.registerAgent(resumeAnalysisAgent)

// 模拟面试（技术栈定向多轮问答 + 结束评分卡）
agentRegistry.registerAgent(mockInterviewAgent)

export const chatRouter = Router()

chatRouter.post('/api/chat', rateLimiters.chat, validateChatBody, async (req, res, next) => {
  try {
    const { messages = [], agentName, techStack, sessionId } = req.body ?? {}
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const query =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? '')

    // techStack 兼容
    const techStackArr = Array.isArray(techStack)
      ? techStack.filter((x) => typeof x === 'string' && x.trim())
      : typeof techStack === 'string' && techStack.trim()
        ? [techStack.trim()]
        : []

    // ---------- 会话处理 ----------
    const safeAgentName = typeof agentName === 'string' ? agentName : ''
    let sid = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : ''
    // 会话归属校验：sessionId 必须存在，且归属于同一 agentName（阻断跨智能体借用/劫持会话）
    if (sid) {
      const meta = sessionStore.getSession(sid)
      const mismatch =
        !meta || (safeAgentName && meta.agentName && meta.agentName !== safeAgentName)
      if (mismatch) {
        log.warn(
          `[Chat] sessionId ${sid} ${meta ? '归属 agent=' + meta.agentName + '，与请求 agent=' + safeAgentName + ' 不符' : '不存在'}，将按 agentName 新建会话`,
        )
        sid = ''
      }
    }
    if (!sid) {
      if (!safeAgentName) {
        return res.status(400).json({ message: 'sessionId 缺失时 agentName 必填' })
      }
      const meta = sessionStore.createSession({ agentName: safeAgentName })
      sid = meta.id
      dbg(`[Chat] 新建会话 ${sid} (agent=${safeAgentName})`)
    }

    if (query) sessionStore.appendMessage(sid, { role: 'user', content: query })
    const history = sessionStore.getContextWindow(sid, { maxTurns: 6, maxChars: 6000 })
    dbg(`[Chat] 会话 ${sid} 上下文窗口 ${history.length} 条 | agent=${safeAgentName || '(未知)'} | query: ${query.slice(0, 50)}...`)

    // 流式结束回调
    const onAssistantDone = (fullText, annotations) => {
      if (!fullText) return
      const hasAnnot = Array.isArray(annotations) && annotations.length > 0
      const writeObj = {
        role: 'assistant',
        content: fullText,
        ...(hasAnnot ? { annotations } : {}),
      }
      try {
        sessionStore.appendMessage(sid, writeObj)
      } catch (err) {
        log.error({ msg: err.message, stack: err.stack }, `[Chat] 会话 ${sid} 追加 assistant 消息失败`)
      }
    }

    // ---------- 通过 agentRegistry 分发 ----------
    const agentDef = agentRegistry.resolveAgent(safeAgentName)
    if (!agentDef) {
      log.warn(`[Chat] 未找到智能体 "${safeAgentName}"，使用默认对话`)
      return pipeStream(
        res,
        await streamChat({ query, techStack: techStackArr, history }),
        { sessionId: sid, onAssistantText: onAssistantDone },
      )
    }

    // 构造共享 ctx，供 agent handler 消费
    const ctx = {
      query, history, techStack: techStackArr, sessionId: sid, onAssistantDone,
      req, res, pipeStream, dbg,
      // L5+ 依赖（仅 doc-processor 需要，按需传入不影响其他 agent）
      workflowRegistry: undefined, runDocAgent: undefined, runDocPlanAgent: undefined,
      streamOpReport: undefined, buildDocContext: undefined, extractTaskIntents: undefined,
      DOC_WORKFLOW_NAME, DOC_PLAN_WORKFLOW_NAME,
    }
    if (agentDef.id === 'doc-processor') {
      ctx.workflowRegistry = workflowRegistry
      ctx.runDocAgent = runDocAgent
      ctx.runDocPlanAgent = runDocPlanAgent
      ctx.streamOpReport = streamOpReport
      ctx.buildDocContext = buildDocContext
      ctx.extractTaskIntents = extractTaskIntents
    }

    return agentDef.handler(ctx)
  } catch (err) {
    next(err)
  }
})

/**
 * doc-processor action 关键词路由（stub 模式兜底）
 */
async function handleActionRouter({ query, history, req, res, sessionId, onAssistantDone, pipeStream, dbg }) {
  const opts = { sessionId, onAssistantText: onAssistantDone }

  const dpBody = req.body ?? {}
  const action = typeof dpBody.action === 'string' ? dpBody.action.trim() : ''
  const ephemeralCacheKey = `__ephemeral__:${sessionId || 'anonymous'}`
  const cacheKeyFor = (id) => id || ephemeralCacheKey
  const cacheDocId = (id) => id || ephemeralCacheKey || 'ephemeral'
  let docId = typeof dpBody.docId === 'string' && dpBody.docId.trim() ? dpBody.docId.trim() : ''
  const strategy = dpBody.strategy === 'delimiter' ? 'delimiter' : 'semantic'
  const delimiter = typeof dpBody.delimiter === 'string' && dpBody.delimiter.length > 0 ? dpBody.delimiter : undefined
  const maxChars = Number.isFinite(Number(dpBody.maxChars)) ? Number(dpBody.maxChars) : undefined

  const resolveText = () => {
    if (docId) {
      const cached = getCachedPreview(docId)
      if (cached?.text) return cached.text
      const doc = store.getDocument(docId)
      if (doc?.content) return doc.content
    }
    if (typeof dpBody.text === 'string' && dpBody.text.trim()) return dpBody.text
    return query
  }

  let effectiveAction = action
  if (!effectiveAction) {
    if (/入库|确认入库|^确认$/.test(query)) effectiveAction = 'confirm'
    else if (/导出/.test(query)) effectiveAction = 'export'
    else if (/预览|看看|先看看|切片效果/.test(query)) effectiveAction = 'preview'
    else if (/分析|这份文档|是什么格式|推荐策略/.test(query)) effectiveAction = 'analyze'
    else effectiveAction = 'adjust'
  }

  dbg(`[doc-processor] action=${effectiveAction} | docId=${docId || '(无)'} | strategy=${strategy}`)

  if (effectiveAction === 'upload') {
    const text = typeof dpBody.text === 'string' && dpBody.text.trim() ? dpBody.text : query
    if (!text.trim()) return pipeStream(res, stubStream('文档内容为空，请粘贴或上传文本。'), opts)
    const features = analyzeDocFeatures(text)
    const doc = await store.createDocument({
      title: `粘贴文本 ${new Date().toLocaleString('zh-CN')}`,
      category: '', tags: [], size: Buffer.byteLength(text, 'utf8'), content: text, source: 'doc-processor-paste',
    })
    docId = doc.id
    setCachedPreview(docId, { text, chunks: null, strategy: features.suggestedStrategy, opts: { maxChars: features.maxChars } })
    const overview =
      `收到文档：共 ${features.chars.toLocaleString()} 字，${features.paragraphs} 个段落，` +
      `${features.headings} 个标题，${features.hasCode ? '含代码块' : '无代码'}，${features.hasQa ? '含问答结构' : '无问答结构'}。\n\n` +
      `推荐策略：${features.suggestedStrategy}（maxChars=${features.maxChars}）。回复"预览"查看切片效果，或直接说"入库"。`
    return pipeStream(res, stubStream(overview), opts)
  }

  if (effectiveAction === 'analyze') {
    const text = resolveText()
    const features = analyzeDocFeatures(text)
    if (!docId) {
      const doc = await store.createDocument({
        title: `粘贴文本 ${new Date().toLocaleString('zh-CN')}`,
        category: '', tags: [], size: Buffer.byteLength(text, 'utf8'), content: text, source: 'doc-processor-paste',
      })
      docId = doc.id
      setCachedPreview(docId, { text, chunks: null, strategy: features.suggestedStrategy, opts: { maxChars: features.maxChars } })
    }
    const stream = await streamAnalyzeDoc({ text, features, title: store.getDocument(docId)?.title || '未命名' })
    return pipeStream(res, stream, opts)
  }

  if (effectiveAction === 'preview') {
    const text = resolveText()
    if (!text.trim()) return pipeStream(res, stubStream('请先上传文档或粘贴文本，再预览切片。'), opts)
    const opts2 = { strategy, ...(delimiter ? { delimiter } : {}), ...(maxChars ? { maxChars } : {}) }
    const chunks = await previewChunks(text, opts2)
    setCachedPreview(cacheKeyFor(docId), { text, chunks, strategy, opts: opts2 })
    const annot = await chunksToAnnotation(chunks, cacheDocId(docId), { action: 'preview' })
    const previewText = formatChunksPreview(chunks)
    return pipeStream(res, prependAnnotation(stubStream(previewText), annot), opts)
  }

  if (effectiveAction === 'adjust') {
    const cacheKey = cacheKeyFor(docId)
    const cached = getCachedPreview(cacheKey)
    if (!cached?.chunks) {
      const text = resolveText()
      const opts2 = { strategy, ...(delimiter ? { delimiter } : {}), ...(maxChars ? { maxChars } : {}) }
      const chunks = await previewChunks(text, opts2)
      setCachedPreview(cacheKey, { text, chunks, strategy, opts: opts2 })
      const annot = await chunksToAnnotation(chunks, docId || cacheDocId(docId), { action: 'preview' })
      return pipeStream(res, prependAnnotation(stubStream(formatChunksPreview(chunks)), annot), opts)
    }
    const adj = parseAdjustmentInstruction(query)
    if (!adj) {
      const annot = await chunksToAnnotation(cached.chunks, docId || cacheDocId(docId), { action: 'preview' })
      const hint = `当前共 ${cached.chunks.length} 块。可对我说："合并第2、3块"、"拆分第5块"、"maxChars 改成 1000"，或直接"入库" / "导出"。`
      return pipeStream(res, prependAnnotation(stubStream(hint), annot), opts)
    }
    if (adj.op === 'reparam') {
      const newOpts = { ...cached.opts, maxChars: adj.maxChars }
      const chunks = await previewChunks(cached.text, { strategy: cached.strategy, ...newOpts })
      setCachedPreview(cacheKey, { ...cached, chunks, opts: newOpts })
      const annot = await chunksToAnnotation(chunks, docId || cacheDocId(docId), { action: 'preview' })
      const msg = `已按 maxChars=${adj.maxChars} 重新切片，共 ${chunks.length} 块：\n\n${formatChunksPreview(chunks)}`
      return pipeStream(res, prependAnnotation(stubStream(msg), annot), opts)
    }
    const newChunks = applyChunkAdjustment(cached.chunks, adj)
    setCachedPreview(cacheKey, { ...cached, chunks: newChunks })
    const annot = await chunksToAnnotation(newChunks, docId || cacheDocId(docId), { action: 'preview' })
    const msg = `已${adj.op === 'merge' ? '合并' : '拆分'}，现在共 ${newChunks.length} 块：\n\n${formatChunksPreview(newChunks)}`
    return pipeStream(res, prependAnnotation(stubStream(msg), annot), opts)
  }

  if (effectiveAction === 'confirm') {
    const cacheKey = cacheKeyFor(docId)
    const cached = getCachedPreview(cacheKey)
    const text = resolveText()
    if (!text.trim()) return pipeStream(res, stubStream('请先上传文档或粘贴文本，再入库。'), opts)
    if (!docId || !store.getDocument(docId)) {
      const doc = await store.createDocument({
        title: `文档处理入库 ${new Date().toLocaleString('zh-CN')}`,
        category: '', tags: [], size: Buffer.byteLength(text, 'utf8'), content: text, source: 'doc-processor-confirm',
      })
      docId = doc.id
    }
    const t0 = performance.now()
    const { chunkList, vectors } = await prepareDocChunksAndVectors(text, {
      strategy: cached?.strategy || strategy,
      delimiter: cached?.strategy === 'delimiter' ? cached.opts?.delimiter : delimiter,
      maxChars: cached?.opts?.maxChars || maxChars,
    })
    await store.addChunks(docId, chunkList, vectors, { category: '', tags: [] })
    clearCachedPreview(cacheKey)
    const ms = Math.round(performance.now() - t0)
    const totalChars = chunkList.reduce((s, c) => s + (typeof c.text === 'string' ? c.text.length : 0), 0)
    const successMsg =
      `✅ 文档入库成功\n` +
      `- 切片数：${chunkList.length} 块\n` +
      `- 总字数：${totalChars.toLocaleString()}\n` +
      `- 入库耗时：${(ms / 1000).toFixed(1)}s\n` +
      `- 已生成 topic 标注和检索锚点\n\n` +
      `可在「知识库」智能体中检索，或对我说"导出"把整理后的内容导出为 Markdown。`
    dbg(`[doc-processor] 入库 doc ${docId} | ${chunkList.length} 块 | ${ms}ms`)
    return pipeStream(res, stubStream(successMsg), opts)
  }

  if (effectiveAction === 'export') {
    const cacheKey = cacheKeyFor(docId)
    let cached = getCachedPreview(cacheKey)
    if (!cached?.chunks) {
      const text = resolveText()
      if (!text.trim()) return pipeStream(res, stubStream('请先上传文档并预览切片，再导出。'), opts)
      const chunks = await previewChunks(text, { strategy })
      cached = { text, chunks, strategy, opts: {} }
      setCachedPreview(cacheKey, cached)
    }
    const md = exportChunksAsMarkdown(cached.chunks)
    const header = `以下是整理后的 Markdown（共 ${cached.chunks.length} 块，${md.length.toLocaleString()} 字）：\n\n`
    const footer = `\n\n———\n* 可复制保存为 .md 文件。`
    return pipeStream(res, stubStream(header + md + footer), opts)
  }

  return pipeStream(res, stubStream('请上传文档或粘贴文本，我会帮你切片、整理、入库。可说"预览"、"入库"、"导出"。'), opts)
}
