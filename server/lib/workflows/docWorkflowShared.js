import * as store from '../vectorStore.js'
import { getCachedPreview } from '../docProcessor.js'
import { toolRegistry } from '../management/registry.js'
import { getChatModel } from '../llmProvider.js'

/**
 * docWorkflowShared —— 工作流层共享设施
 *
 * ReAct 工作流（docWorkflow.js / doc-react）与复合任务计划工作流
 * （docPlanWorkflow.js / doc-plan）共用的：
 *  - getAgentModel          LLM provider（独立缓存，与 docProcessor.getDocModel 同口径）
 *  - toolLabel / workflowStepAnnotation  agent_workflow 注解构造（工作流卡片）
 *  - truncate / buildHistoryBlock        Prompt 组装辅助
 *  - buildDocContext        文档执行上下文（正文解析：预览缓存 → store → 粘贴文本）
 *  - createEmitters / encodeStreamLine   AI SDK data-stream 协议发射器
 */

/** data-stream 行编码（`0:` / `2:` / `d:` 行共用） */
const encoder = new TextEncoder()
export function encodeStreamLine(line) {
  return encoder.encode(`${line}\n`)
}

// getChatModel is used below, so we keep the import.

/** 非注册表工具的展示标签（PlanWorkflow 是计划模式的虚拟步骤，FINISH 是终止信号） */
const EXTRA_TOOL_LABELS = { PlanWorkflow: '任务拆解', FINISH: '完成' }

export function toolLabel(name) {
  return toolRegistry.get(name)?.label ?? EXTRA_TOOL_LABELS[name] ?? name
}

/**
 * 构造 agent_workflow 注解（每执行一步发一条 delta，前端拉平成时间线）。
 * 与 search_results（切片卡片）平级，由前端 AgentWorkflowPanel 渲染，
 * 让用户在会话中看到智能体调用了哪些工具、参数与观察结果。
 * engine 默认 doc-agent（文档双工作流）；ReAct 规划器传 react-agent。
 */
export function workflowStepAnnotation({ seq, tool, args, thought, observation, ms, engine = 'doc-agent' }) {
  return {
    type: 'agent_workflow',
    engine,
    seq,
    tool,
    label: toolLabel(tool),
    args: args && typeof args === 'object' ? args : {},
    thought: truncate(thought, 300),
    observation: truncate(observation, 400),
    ms: Number.isFinite(ms) ? Math.round(ms) : 0,
  }
}

export function truncate(s, max) {
  const t = typeof s === 'string' ? s.trim() : ''
  if (t.length <= max) return t
  return t.slice(0, max).trimEnd() + '…'
}

/**
 * 长时记忆块：最近几轮对话。
 * 注意：index.js 传入的 history 最后一条是本轮刚 append 的 user 消息（即当前 query），剔除。
 */
export function buildHistoryBlock(history) {
  const arr = Array.isArray(history) ? history : []
  const prior = arr
    .slice(0, -1)
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
  if (!prior.length) return '## 对话历史\n（无）'
  const lines = prior.slice(-6).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${truncate(m.content, 300)}`)
  return `## 对话历史（供语境参考）\n${lines.join('\n')}`
}

/**
 * 构造文档执行上下文（两个工作流共用同一正文解析口径）。
 * @param {string} docId 文档 id（空串表示粘贴文本场景）
 * @param {string} text 请求体携带的粘贴文本
 */
export function buildDocContext(docId = '', text = '', ownerId = '') {
  const cacheKey = docId || '__ephemeral__'
  return {
    docId: docId || '',
    ownerId,
    cacheKey,
    pastedText: typeof text === 'string' ? text : '',
    // 文档正文解析：优先预览缓存 → store.doc.content → 请求体 text
    resolveText() {
      if (this.docId) {
        const cached = getCachedPreview(this.docId)
        if (cached?.ownerId && this.ownerId && cached.ownerId !== this.ownerId) return ''
        if (cached?.text) return cached.text
        const doc = store.getDocument(this.docId, this.ownerId)
        if (doc?.content) return doc.content
      }
      return this.pastedText
    },
  }
}

/** data-stream 发射器（runDocAgent / runDocPlanAgent 的流内输出） */
export function createEmitters(controller) {
  return {
    emitText(s) {
      if (typeof s === 'string' && s) controller.enqueue(encodeStreamLine(`0:${JSON.stringify(s)}`))
    },
    emitAnnotation(a) {
      if (a) controller.enqueue(encodeStreamLine(`2:${JSON.stringify([a])}`))
    },
    emitDone() {
      controller.enqueue(encodeStreamLine(`d:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}`))
    },
  }
}
