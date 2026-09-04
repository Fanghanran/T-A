import { generateText } from 'ai'
import { childLogger } from '../logger.js'
import { getCachedPreview } from '../docProcessor.js'
import { toolRegistry, workflowRegistry } from '../management/registry.js'
// 意图判定来自独立领域模块（lib/intents.js），与工具层 / 路由层共用同一口径
import { extractTaskIntents } from '../intents.js'
import { getChatModel } from '../llmProvider.js'
import {
  toolLabel,
  workflowStepAnnotation,
  buildHistoryBlock,
  buildDocContext,
  createEmitters,
} from './docWorkflowShared.js'

/**
 * docPlanWorkflow —— 复合任务计划执行工作流（Plan-and-Execute，独立于 ReAct 工作流）
 *
 * 触发条件（index.js 分发）：一条消息含 ≥2 个操作意图（如"请分析这份文档，之后入库"）
 * 且本工作流（doc-plan）未被管理端禁用。单任务走 docWorkflow.js（doc-react）。
 *
 * 为什么复合任务不走 ReAct 自主决策：小模型在"入库必须确认"约束下过度保守，
 * 容易中途 FINISH 反问导致复合任务断链；本工作流改为代码级确定性链路：
 *   ① 任务拆解（PlanWorkflow 注解，子任务清单在工作流卡片可见）
 *   ② 逐个子任务调用工具层（tools/docTools.js）执行（每个子任务一条工作流注解 + 结果文本/卡片）
 *   ③ LLM 汇总各子任务结果生成最终答复（失败降级为结果拼接）
 *
 * 工具被管理端禁用时对应意图在拆解阶段直接丢弃（子任务清单只含可用工具）。
 *
 * 输出契约：AI SDK data-stream 协议的 ReadableStream（与 docWorkflow.runDocAgent 同口径）：
 *   - `0:"..."`   文本分片（子任务结果 / 最终汇总）
 *   - `2:[...]`   注解（agent_workflow 工作流卡片 / search_results 切片卡片）
 *   - `d:{...}`   结束行
 */

const log = childLogger('docPlanWorkflow')

/** 工作流注册名（index.js 据此分发复合任务） */
export const DOC_PLAN_WORKFLOW_NAME = 'doc-plan'

/** adjust 意图 → 展示文案 + 工具参数 */
function adjustSubtask(adj) {
  if (adj.op === 'merge') {
    return { label: `合并第 ${adj.indices.join('、')} 块`, args: { op: 'merge', indices: adj.indices } }
  }
  if (adj.op === 'split') return { label: `拆分第 ${adj.index} 块`, args: { op: 'split', index: adj.index } }
  return { label: `按 maxChars=${adj.maxChars} 重新切片`, args: { op: 'reparam', maxChars: adj.maxChars } }
}

/**
 * 运行复合任务计划工作流。
 * @param {{ query:string, docId?:string, text?:string, history?:Array }} params
 * @returns {Promise<ReadableStream<Uint8Array>>} AI SDK data-stream 协议流
 */
export async function runDocPlanAgent({ query, docId = '', text = '', history = [] }) {
  const ctx = buildDocContext(docId, text)
  const intents = extractTaskIntents(query)
  return new ReadableStream({
    async start(controller) {
      const { emitText, emitAnnotation, emitDone } = createEmitters(controller)
      try {
        await runCompoundPlan({ ctx, query, history, intents, emitText, emitAnnotation })
        emitDone()
      } catch (err) {
        log.error({ msg: err.message, stack: err.stack }, '[docPlanWorkflow] 计划执行异常')
        emitText(`智能体执行出错：${err.message}\n\n可以重试，或直接说"预览"、"入库"、"导出"。`)
        emitDone()
      } finally {
        controller.close()
      }
    },
  })
}

/**
 * 计划执行主体：拆解 → 逐一执行 → LLM 汇总。
 * @param {{ ctx:object, query:string, history:Array, intents:Array, emitText:Function, emitAnnotation:Function }} params
 */
async function runCompoundPlan({ ctx, query, history, intents, emitText, emitAnnotation }) {
  // ① 拆解
  const subtasks = []
  for (const it of intents) {
    if (it.op === 'adjust') {
      const { label, args } = adjustSubtask(it.adj)
      subtasks.push({ tool: 'AdjustChunks', label, args })
    } else {
      subtasks.push({ tool: it.tool, label: toolLabel(it.tool), args: {} })
    }
  }
  emitText(`这是一个复合任务，我把它拆解为 ${subtasks.length} 个子任务依次执行：\n\n`)
  let seq = 1
  emitAnnotation(
    workflowStepAnnotation({
      seq: seq++,
      tool: 'PlanWorkflow',
      args: { subtasks: subtasks.map((s) => s.label) },
      thought: query,
      observation: `已拆解为 ${subtasks.length} 个子任务：${subtasks.map((s, i) => `${i + 1}.${s.label}`).join(' → ')}`,
      ms: 0,
    }),
  )

  // ② 逐子任务执行（预览沿用分析给出的策略参数）
  const results = []
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i]
    emitText(`**子任务 ${i + 1}/${subtasks.length} · ${st.label}**\n\n`)
    const args =
      st.tool === 'PreviewChunks'
        ? {
            ...(getCachedPreview(ctx.cacheKey)?.strategy ? { strategy: getCachedPreview(ctx.cacheKey).strategy } : {}),
            ...(getCachedPreview(ctx.cacheKey)?.opts?.maxChars ? { maxChars: getCachedPreview(ctx.cacheKey).opts.maxChars } : {}),
          }
        : st.args
    const run = toolRegistry.resolveRunner(st.tool)
    const t0 = performance.now()
    const result = run
      ? await run(ctx, args, { query, history })
      : { observation: `错误：工具 ${st.tool} 不可用`, userText: `子任务 ${st.label} 无法执行（工具不可用）。` }
    const ms = performance.now() - t0
    emitAnnotation(
      workflowStepAnnotation({
        seq: seq++,
        tool: st.tool,
        args,
        thought: `执行子任务 ${i + 1}/${subtasks.length}：${st.label}`,
        observation: result.observation || '',
        ms,
      }),
    )
    if (result.annotation) emitAnnotation(result.annotation)
    emitText(`${result.userText || ''}\n\n`)
    results.push({ label: st.label, observation: result.observation || '' })
  }

  // ③ LLM 汇总（失败降级为结果拼接）
  let summary = ''
  try {
    const { text } = await generateText({
      model: getChatModel(),
      system:
        '你是文档处理智能体。用户给了复合任务，各子任务已全部执行完毕。' +
        '请根据执行结果用中文写一段简要汇总（3 句以内）：每步做了什么、最终状态如何。' +
        '不要提出新问题，不要重复执行说明里的细节。',
      prompt: `用户任务：${query}\n\n各子任务执行结果：\n${results
        .map((r, i) => `${i + 1}. ${r.label}：${r.observation}`)
        .join('\n')}`,
    })
    summary = String(text || '').trim()
  } catch (err) {
    log.warn(`[docPlanWorkflow] 复合任务汇总生成失败：${err.message}，降级结果拼接`)
  }
  if (!summary) {
    summary = `复合任务已完成，共执行 ${results.length} 个子任务：\n${results.map((r, i) => `${i + 1}. ${r.label} —— ${r.observation}`).join('\n')}`
  }
  emitText(`**汇总**\n\n${summary}`)
  emitAnnotation(workflowStepAnnotation({ seq: seq++, tool: 'FINISH', args: {}, thought: summary, observation: '', ms: 0 }))
}

/* ===================== 工作流注册（管理模块可见/可启停） ===================== */

workflowRegistry.register({
  name: DOC_PLAN_WORKFLOW_NAME,
  label: '复合任务计划工作流',
  category: 'doc-processor',
  description: '复合任务（≥2 个操作意图）代码级拆解为子任务逐一执行，最后 LLM 汇总结果',
  dependsOn: ['AnalyzeDocument', 'PreviewChunks', 'AdjustChunks', 'CommitToStore', 'ExportMarkdown'],
  meta: { engine: 'doc-agent-plan' },
})
