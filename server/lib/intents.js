import { parseAdjustmentInstruction } from './docProcessor.js'
import { toolRegistry } from './management/registry.js'

/**
 * intents —— 用户意图判定（纯编排语义，供工具层 / 工作流层 / 路由层共享）
 *
 * 分层定位：位于注册表（management/registry）之上、工具层（tools/）之下的编排基础模块。
 * 只回答两个问题：
 *   1. 用户这句话里有哪些操作意图？（extractTaskIntents → 复合任务识别）
 *   2. 用户是否明确确认了入库？（hasCommitConfirmation → CommitToStore 守卫）
 *
 * 依赖方向：docProcessor（指令解析）+ registry（工具启停过滤），
 * 不依赖 express / LLM / 工作流实现，任何上层均可安全引用。
 */

/** 入库确认关键词（CommitToStore 守卫与 ReAct 强制指令共用同一口径） */
const COMMIT_INTENT_RE = /入库|存入|保存到|写入|确认入库|^确认$|^好的|^可以/

/**
 * 判断用户是否已明确同意入库。
 * 依次检查：当前消息 → 最近一轮历史（用户上一句"入库"、本轮"确认"的典型对话）。
 * @param {string} query 当前用户消息
 * @param {Array<{role:string, content:string}>} [history] 会话历史（最后一条为本轮消息）
 * @returns {boolean}
 */
export function hasCommitConfirmation(query, history = []) {
  const texts = []
  if (typeof query === 'string' && query.trim()) texts.push(query.trim())
  const prior = Array.isArray(history) ? history : []
  // 最近一轮 user 历史消息（排除本轮刚 append 的那条）
  for (let i = prior.length - 1; i >= 0 && texts.length <= 3; i--) {
    const m = prior[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string' && m.content.trim()) texts.push(m.content.trim())
    if (texts.length > 2) break
  }
  return texts.some((t) => COMMIT_INTENT_RE.test(t))
}

/**
 * 从用户消息抽取操作意图（按在句中出现的位置排序）。
 * 用于复合任务识别（如"请分析这份文档，之后入库"→ [分析, 入库]）：
 * 命中 ≥2 个意图时由路由层分发到计划工作流（doc-plan），不依赖小模型多步自主决策。
 * 工具被管理端禁用时对应意图直接丢弃（子任务清单只含可用工具）。
 * @param {string} query 用户消息
 * @returns {Array<{op:string, tool:string, pos:number, adj?:object}>}
 */
export function extractTaskIntents(query) {
  const defs = [
    { op: 'analyze', re: /分析|文档结构/, tool: 'AnalyzeDocument' },
    { op: 'preview', re: /预览|看看|切片效果/, tool: 'PreviewChunks' },
    { op: 'commit', re: /入库|存入|保存到|写入/, tool: 'CommitToStore' },
    { op: 'export', re: /导出/, tool: 'ExportMarkdown' },
  ]
  const hits = []
  for (const d of defs) {
    if (!toolRegistry.isEnabled(d.tool)) continue
    const m = d.re.exec(query)
    if (m) hits.push({ ...d, pos: m.index })
  }
  hits.sort((a, b) => a.pos - b.pos)
  // adjust 不走正则（"合并第2、3块"等结构复杂）：直接用 parseAdjustmentInstruction 判定，
  // 解析成功才追加到末尾（调整通常是对既有切片的操作，放在其他步骤之后）
  if (toolRegistry.isEnabled('AdjustChunks')) {
    const adj = parseAdjustmentInstruction(query)
    if (adj) hits.push({ op: 'adjust', tool: 'AdjustChunks', adj, pos: hits.length ? hits[hits.length - 1].pos + 1 : 0 })
  }
  return hits
}
