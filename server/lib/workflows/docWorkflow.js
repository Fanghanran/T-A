import { generateText } from 'ai'
import { llmAvailable } from '../config.js'
import { childLogger } from '../logger.js'
import * as store from '../vectorStore.js'
import { previewChunks, chunksToAnnotation, exportChunksAsMarkdown, getCachedPreview, setCachedPreview } from '../docProcessor.js'
import { toolRegistry, workflowRegistry } from '../management/registry.js'
// 意图判定来自独立领域模块（lib/intents.js）；工作流层不直接依赖工具层实现，
// 工具一律经 registry.resolveRunner 解耦调用
import { hasCommitConfirmation } from '../intents.js'
import { getChatModel } from '../llmProvider.js'
import {
  toolLabel,
  workflowStepAnnotation,
  truncate,
  buildHistoryBlock,
  buildDocContext,
  createEmitters,
  encodeStreamLine,
} from './docWorkflowShared.js'

/**
 * docWorkflow —— 文档处理智能体 ReAct 工作流（工作流层，注册名 doc-react）
 *
 * 参考 AutoGPT-Work 的 ReAct 模式（main.py + Agent/ReAct.py）：
 *   while step < max_thought_steps:
 *     组装 Prompt（任务 + 长时记忆 + 短时记忆 scratchpad）
 *       → LLM 输出「简要思考 + ```json {"name":"工具","args":{}}```」
 *       → 解析 Action（失败给一次修复机会）
 *       → FINISH 则返回最终答案退出；否则执行工具，observation 写入 scratchpad
 *
 * 工具实现在 tools/docTools.js（向 toolRegistry 注册）；本模块只做编排：
 *   - System Prompt 的「可用工具」块从注册表动态生成（只列启用项）
 *   - LLM 调用禁用工具时拦截并写回 observation（工具被管理端禁用）
 *
 * 复合任务（≥2 个操作意图）已拆分为独立的计划执行工作流
 * （docPlanWorkflow.js，注册名 doc-plan），由 index.js 分发，与本工作流互不影响。
 *
 * 本模块向 workflowRegistry 注册自身（doc-react），管理端可整体禁用该工作流；
 * 禁用后 index.js 的 doc-processor 分支回退到 action 关键词路由（stub 模式同款）。
 *
 * 输出契约：AI SDK data-stream 协议的 ReadableStream
 *   - `0:"..."`   文本分片（思考摘要 / 工具结果 / 最终答案）
 *   - `2:[...]`   注解（agent_workflow 工作流卡片 / search_results 切片卡片）
 *   - `d:{...}`   结束行
 */

const log = childLogger('docWorkflow')

/** ReAct 循环步数上限（AutoGPT-Work 为 20；文档处理链路短，8 步足够） */
const MAX_STEPS = 8

/** scratchpad 中 observation 的截断长度（防 prompt 膨胀） */
const OBS_MAX = 1000

/** scratchpad 中思考的截断长度 */
const THOUGHT_MAX = 500

/** 工作流注册名（index.js 据此判断是否回退 stub 路由） */
export const DOC_WORKFLOW_NAME = 'doc-react'

/* ===================== System Prompt（工具列表动态生成） ===================== */

/**
 * 「可用工具」块：从 toolRegistry 生成，只列启用项（管理端禁用的工具
 * 对 LLM 不可见，从根本上杜绝被调用）；FINISH 固定追加在末尾。
 */
function buildToolListBlock() {
  const tools = toolRegistry.listEnabled()
  const lines = tools.map((t, i) => `${i + 1}. ${t.name} —— ${t.description}。参数：${t.params}`)
  lines.push(`${tools.length + 1}. FINISH —— 任务完成或无需再调用工具时，向用户返回最终答案。参数：the_final_answer（字符串，中文，可直接呈现给用户）`)
  return lines.join('\n')
}

function buildSystemPrompt() {
  return `你是一个文档处理智能体，采用 ReAct 模式（思考 → 调用工具 → 观察结果 → 继续思考）自主决策。
你的职责：帮用户把原始文档整理成适合检索的结构化切片（预处理 → 切片 → 整理 → 入库 → 导出）。

## 可用工具（每步只能调用一个）
${buildToolListBlock()}

## 输出格式（严格遵守）
先输出一两句简要思考，然后输出恰好一个 json 代码块：
\`\`\`json
{"name": "工具名", "args": {参数对象}}
\`\`\`

## 工作准则
1. 用户上传/粘贴文档后的第一响应：调用 AnalyzeDocument 了解文档结构，再引导用户预览或直接预览
2. 切片结果一律以工具观察为准，绝不凭空编造块数或内容
3. CommitToStore 前必须得到用户明确确认；用户只说"看看/预览/分析"时绝不能入库。注意：用户当前消息本身就是"入库"、"确认"、"可以"等同意语时，即为明确确认，直接调用 CommitToStore，严禁再次反问确认
4. 不回答文档内容本身的问题（如"这份文档讲了什么"），专注切片与整理；此类问题用 FINISH 简短说明并引导
5. 当需要等待用户决策（如确认入库、选择策略）时，调用 FINISH 给出简明引导
6. 严禁重复调用同一工具：已执行的工具及结果都记录在「已执行步骤」中，直接参考即可；分析完成后下一步应是 PreviewChunks 或 FINISH，绝不再次 AnalyzeDocument`
}

/* ===================== Prompt 组装 ===================== */

/** 当前状态块：文档信息 + 预览缓存状态（LLM 决策的关键事实） */
function buildStateBlock(ctx) {
  const cached = getCachedPreview(ctx.cacheKey)
  const doc = ctx.docId ? store.getDocument(ctx.docId) : null
  const text = ctx.resolveText()
  const lines = ['## 当前状态']
  if (doc || text) {
    lines.push(
      `- 文档：${doc ? `《${doc.title}》` : '（未入库的粘贴文本）'}，约 ${(text || doc?.content || '').length.toLocaleString()} 字`,
    )
  } else {
    lines.push('- 文档：暂无（用户尚未上传文档或粘贴文本）')
  }
  if (cached?.chunks?.length) {
    lines.push(
      `- 切片预览：已有 ${cached.chunks.length} 块（strategy=${cached.strategy}，maxChars=${cached.opts?.maxChars ?? '默认'}），可能已含用户调整`,
    )
  } else if (cached) {
    lines.push(`- 切片预览：尚未生成（推荐 strategy=${cached.strategy}，maxChars=${cached.opts?.maxChars ?? '默认'}）`)
  } else {
    lines.push('- 切片预览：尚未生成')
  }
  return lines.join('\n')
}

/** 短时记忆块：本轮已执行的 ReAct 步骤（Thought → Action → Observation） */
function buildScratchpadBlock(steps) {
  if (!steps.length) return '## 已执行步骤（短时记忆）\n（本轮还没有执行任何步骤）'
  const lines = steps.map(
    (s, i) =>
      `[第${i + 1}步]\n思考：${truncate(s.thought, THOUGHT_MAX)}\n动作：${s.name}(${JSON.stringify(s.args)})\n观察：${truncate(s.observation, OBS_MAX)}`,
  )
  return `## 已执行步骤（短时记忆）\n${lines.join('\n\n')}`
}

function buildAgentPrompt({ ctx, history, steps, query, directive = '' }) {
  const blocks = [buildStateBlock(ctx), buildHistoryBlock(history), buildScratchpadBlock(steps)]
  if (directive) blocks.push(directive)
  blocks.push(`## 用户任务\n${query}`)
  return blocks.join('\n\n')
}

/* ===================== Action 解析（宽容提取 + 一次修复） ===================== */

/**
 * 从 LLM 输出提取工具调用。取最后一个 ```json``` 块；兼容裸 JSON 对象（无围栏）。
 * @returns {{ name:string, args:object } | null}
 */
function extractAction(llmOut) {
  const out = typeof llmOut === 'string' ? llmOut : ''
  const blocks = out.match(/```json\s*([\s\S]*?)```/gi) || []
  const candidates = blocks.map((b) => b.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim())
  // 裸 JSON 兜底：找 {"name": "...", ...} 形态
  const bare = out.match(/\{\s*"name"\s*:\s*"[^"]+"[\s\S]*?\}/)
  if (bare) candidates.push(bare[0])

  for (const raw of candidates.reverse()) {
    try {
      const obj = JSON.parse(raw)
      if (obj && typeof obj.name === 'string' && obj.name.trim()) {
        return { name: obj.name.trim(), args: obj.args && typeof obj.args === 'object' ? obj.args : {} }
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null
}

/** 提取思考正文（去掉 json 代码块后的剩余文本） */
function extractThought(llmOut) {
  return (typeof llmOut === 'string' ? llmOut : '')
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
}

/**
 * 稳定的动作签名（工具名 + 键排序后的参数），用于重复调用检测。
 * PreviewChunks 重复执行会覆盖用户已做的合并/拆分调整，因此所有工具一律去重。
 */
function actionSignature(name, args) {
  const sorted = Object.keys(args ?? {})
    .sort()
    .reduce((acc, k) => {
      acc[k] = args[k]
      return acc
    }, {})
  return `${name}::${JSON.stringify(sorted)}`
}

/**
 * 循环失控（步数耗尽 / 重复调用被强制终止）时的兜底答复：
 * 基于最后一个成功执行的工具，给用户明确的下一步引导，而不是干巴巴的道歉。
 */
function buildFallbackAnswer(steps) {
  const lastTool = [...steps].reverse().find((s) => toolRegistry.resolveRunner(s.name))
  if (lastTool?.name === 'AnalyzeDocument') {
    return '文档分析完成。对我说「预览」查看切片效果，确认后说「入库」写入知识库。'
  }
  if (lastTool?.name === 'PreviewChunks' || lastTool?.name === 'AdjustChunks') {
    return '切片结果如上。可以继续让我调整（如「合并第1、2块」），或说「入库」确认写入知识库、说「导出」导出 Markdown。'
  }
  if (lastTool?.name === 'CommitToStore') {
    return '入库已完成。还可以对我说「导出」把整理后的内容导出为 Markdown。'
  }
  if (lastTool?.name === 'ExportMarkdown') {
    return '导出已完成。如需其他操作可以继续告诉我。'
  }
  return '抱歉，我没能完成您的任务。可以换个说法，或直接说"预览"、"入库"、"导出"。'
}

/* ===================== ReAct 主循环 ===================== */

/**
 * 运行文档处理智能体（ReAct 工作流）。
 * @param {{ query:string, docId?:string, text?:string, history?:Array }} params
 * @returns {Promise<ReadableStream<Uint8Array>>} AI SDK data-stream 协议流
 */
export async function runDocAgent({ query, docId = '', text = '', history = [], signal, ownerId }) {
  const ctx = buildDocContext(docId, text, ownerId)

  return new ReadableStream({
    async start(controller) {
      const { emitText, emitAnnotation, emitDone } = createEmitters(controller)

      try {
        const steps = [] // 短时记忆（scratchpad）
        const executed = new Map() // 动作签名 → 步骤序号（重复调用守卫）
        let dupStrikes = 0
        let finalAnswer = ''

        // 动态指令：用户本轮消息已是明确的入库确认且预览就绪 → 强制本步 CommitToStore。
        // 小模型对"必须确认"规则过度保守，会把用户的"入库/确认"再次当成待确认信号反复反问，
        // 代码守卫 hasCommitConfirmation 早已放行，这里在 Prompt 层同步消除歧义。
        // （复合入库任务已由上方计划模式处理，此分支只管"预览就绪后单说入库"的场景。）
        let directive = ''
        if (toolRegistry.isEnabled('CommitToStore') && getCachedPreview(ctx.cacheKey)?.chunks?.length && hasCommitConfirmation(query, [])) {
          directive =
            '## 重要指令\n用户本轮消息已明确确认入库，且切片预览已就绪。你必须在本步立即调用 CommitToStore 工具执行入库，严禁再次请求确认、严禁改用 FINISH 反问。'
        }

        for (let step = 1; step <= MAX_STEPS; step++) {
          const prompt = buildAgentPrompt({ ctx, history, steps, query, directive })
          const { text: llmOut } = await generateText({
            model: getChatModel({ role: 'chat.doc.react', agentId: 'doc-processor' }),
            abortSignal: signal,
            system: buildSystemPrompt(),
            prompt,
          })

          const action = extractAction(llmOut)
          const thought = extractThought(llmOut)

          // ── 解析失败：给一次格式修复机会（等价 AutoGPT-Work 的 OutputFixingParser）
          if (!action) {
            steps.push({
              thought,
              name: '(格式错误)',
              args: {},
              observation: '输出中没有合法的 ```json {"name":...,"args":{}}``` 工具调用块，请严格按输出格式重试。',
            })
            continue
          }

          // ── FINISH：返回最终答案，退出循环（发射终态工作流注解）
          if (action.name === 'FINISH') {
            const ans = action.args?.the_final_answer ?? action.args?.answer ?? ''
            finalAnswer = String(ans).trim() || thought || '已完成。'
            emitAnnotation(
              workflowStepAnnotation({
                seq: steps.length + 1,
                tool: 'FINISH',
                args: {},
                thought: finalAnswer,
                observation: '',
                ms: 0,
              }),
            )
            steps.push({ thought, name: 'FINISH', args: action.args, observation: finalAnswer })
            break
          }

          // ── 工具查找：未注册 / 已被管理端禁用 → 写回 observation 让 LLM 自纠
          const run = toolRegistry.resolveRunner(action.name)
          if (!run) {
            const disabled = toolRegistry.get(action.name) && !toolRegistry.isEnabled(action.name)
            steps.push({
              thought,
              name: action.name,
              args: action.args,
              observation: disabled
                ? `错误：工具 ${action.name} 已被管理员禁用，不可调用。可用工具：${toolRegistry.listEnabled().map((t) => t.name).join(', ')}, FINISH。`
                : `错误：工具 ${action.name} 不存在。可用工具：${toolRegistry.listEnabled().map((t) => t.name).join(', ')}, FINISH。`,
            })
            continue
          }

          // ── 重复调用守卫：同一工具+同一参数只执行一次。
          //    小模型指令遵循弱时会反复 AnalyzeDocument 导致死循环刷屏，这里代码级拦截：
          //    不执行、不向用户重复输出，只把警告写进 scratchpad 逼模型换动作；
          //    连续两次仍重复则强制收尾（智能兜底答复）。
          const sig = actionSignature(action.name, action.args)
          if (executed.has(sig)) {
            dupStrikes++
            if (dupStrikes >= 2) {
              log.warn(`[docWorkflow] 第${step}步重复调用 ${action.name} 达 ${dupStrikes} 次，强制收尾`)
              finalAnswer = buildFallbackAnswer(steps)
              break
            }
            steps.push({
              thought,
              name: action.name,
              args: action.args,
              observation: `警告：${action.name} 已在第 ${executed.get(sig)} 步执行过，结果见上文，禁止重复调用。现在必须换一个工具，或立即用 FINISH 给出最终答复。`,
            })
            continue
          }
          executed.set(sig, step)

          // ── 执行工具：先流式输出思考摘要，再输出工具结果（+注解）
          emitText(thought ? `*${truncate(thought, THOUGHT_MAX)}*\n\n` : '')
          const t0 = performance.now()
          const result = await run(ctx, action.args, { query, history })
          const toolMs = performance.now() - t0
          // 工具调用注解：用户在会话中可见"调了什么工具、参数、观察"（工作流卡片）
          emitAnnotation(
            workflowStepAnnotation({
              seq: steps.length + 1,
              tool: action.name,
              args: action.args,
              thought,
              observation: result.observation || '',
              ms: toolMs,
            }),
          )
          if (result.annotation) emitAnnotation(result.annotation)
          emitText(`${result.userText || ''}\n\n`)
          steps.push({ thought, name: action.name, args: action.args, observation: result.observation || '' })
          log.debug(`[docWorkflow] 第${step}步 ${action.name}(${Math.round(toolMs)}ms) → ${truncate(result.observation, 120)}`)

          // 拒绝入库等需要用户决策的场景，工具结果即终态
          if (result.finish) {
            finalAnswer = result.userText || ''
            break
          }
        }

        if (!finalAnswer) finalAnswer = buildFallbackAnswer(steps)
        // 循环被强制收尾（重复守卫/步数耗尽）时补发 FINISH 终态注解，保证时间线闭合
        if (!steps.some((s) => s.name === 'FINISH')) {
          emitAnnotation(
            workflowStepAnnotation({
              seq: steps.length + 1,
              tool: 'FINISH',
              args: {},
              thought: finalAnswer,
              observation: '',
              ms: 0,
            }),
          )
        }
        emitText(finalAnswer)
        emitDone()
      } catch (err) {
        log.error({ msg: err.message, stack: err.stack }, '[docWorkflow] ReAct 循环异常')
        emitText(`智能体执行出错：${err.message}\n\n可以重试，或直接说"预览"、"入库"、"导出"。`)
        emitDone()
      } finally {
        controller.close()
      }
    },
  })
}

/* ===================== 操作栏回报（REST 操作完成后的简要总结流） ===================== */

const OP_REPORT_SYSTEM_PROMPT =
  '你是文档处理智能体。用户刚通过界面上的操作按钮完成了一次文档处理操作，' +
  '请根据给出的操作结果，用一两句话向用户简要汇报（中文、口语化、不用列表、不罗列全部数字）。'

/** 各操作的兜底引导语（LLM 不可用时拼在事实后面） */
const OP_GUIDANCE = {
  preview: '可展开切片卡片查看每块内容，或继续调整。',
  adjust: '可继续调整，或点击「入库」确认写入知识库。',
  commit: '现在可以在知识库中检索这些内容，也可以导出 Markdown。',
  'commit-batch': '现在可以在知识库中检索这些内容，也可以切换单个文档导出 Markdown。',
  export: '可在导出界面预览、复制或下载文件。',
}

/**
 * 操作栏回报流：REST 操作（预览/调整/入库/导出）完成后，前端 append 一条带
 * body.opReport 的消息进来，本函数生成「卡片注解 + LLM 简要总结文本」的 data-stream。
 *
 * 与 runDocAgent 的区别：操作已由 REST 端点真实执行完毕，这里只做汇报——
 * 不再走 ReAct 循环（避免模型重复调用工具二次入库/二次切片）。
 * 工具启停不影响本流（工具已执行完，这里只呈现结果）。
 *
 * 卡片口径（四种操作都同时给工作流卡片 + 相应结果卡片）：
 *  - 全部操作        → agent_workflow 单步卡片（AgentWorkflowPanel 渲染，工具名与 ReAct 工具一致）
 *  - preview / adjust → 额外附 search_results 切片卡片（ChunkPreviewPanel 渲染）
 *
 * @param {{ opReport:{ op:string, docId?:string, instruction?:string, chunkCount?:number, totalChunks?:number, totalChars?:number, ms?:number }, history?:Array }} params
 * @returns {Promise<ReadableStream<Uint8Array>>} AI SDK data-stream 协议流
 */
export async function streamOpReport({ opReport, history = [], signal }) {
  const op = String(opReport.op || '')
  const docId = String(opReport.docId || '')
  const cacheKey = docId || '__ephemeral__'
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

  // ── 事实收集：preview/adjust/export 从共享预览缓存取最新切片（无则现场切一次）；
  //    commit 的缓存在入库时已清空，用前端回传的统计数字。
  let chunks = getCachedPreview(cacheKey)?.chunks
  if (!chunks && (op === 'preview' || op === 'adjust' || op === 'export')) {
    const cached = getCachedPreview(cacheKey)
    const text = cached?.text || (docId ? store.getDocument(docId)?.content : '') || ''
    if (text.trim()) {
      chunks = await previewChunks(text, { strategy: cached?.strategy })
      setCachedPreview(cacheKey, { ...cached, text, chunks, strategy: cached?.strategy || 'semantic', opts: cached?.opts || {} })
    }
  }

  let facts = ''
  const annots = []

  if (op === 'preview' || op === 'adjust') {
    const n = chunks?.length ?? num(opReport.totalChunks)
    const chars = chunks ? chunks.reduce((s, c) => s + (c.chars || 0), 0) : num(opReport.totalChars)
    facts =
      op === 'preview'
        ? `已生成切片预览${n != null ? `，共 ${n} 块` : ''}${chars != null ? `，约 ${chars.toLocaleString()} 字` : ''}`
        : `已应用调整「${opReport.instruction || ''}」${n != null ? `，现在共 ${n} 块` : ''}${chars != null ? `，约 ${chars.toLocaleString()} 字` : ''}`
    // 与 ReAct 工具同口径：先工作流步骤（PreviewChunks / AdjustChunks）再切片卡片，
    // 让操作栏触发与对话内自然语言触发展现一致的时间线。
    annots.push(
      workflowStepAnnotation({
        seq: 1,
        tool: op === 'preview' ? 'PreviewChunks' : 'AdjustChunks',
        args: op === 'preview' ? { docId } : { docId, instruction: opReport.instruction || '' },
        thought:
          op === 'preview'
            ? '用户在底部操作栏点击「预览切片」按钮'
            : '用户在预览界面点击了结构化调整按钮',
        observation: facts,
        ms: num(opReport.ms) ?? 0,
      }),
    )
    if (chunks?.length) annots.push(await chunksToAnnotation(chunks, docId, { action: 'preview' }))
  } else if (op === 'commit') {
    const n = num(opReport.chunkCount)
    const chars = num(opReport.totalChars)
    const ms = num(opReport.ms)
    facts =
      `入库完成${n != null ? `：${n} 块切片已写入向量库` : ''}` +
      `${chars != null ? `，约 ${chars.toLocaleString()} 字` : ''}` +
      `${ms != null ? `，耗时 ${(ms / 1000).toFixed(1)}s` : ''}，已生成 topic 与检索标注`
    annots.push(
      workflowStepAnnotation({
        seq: 1,
        tool: 'CommitToStore',
        args: { docId },
        thought: '用户在底部操作栏点击「入库」按钮确认',
        observation: facts,
        ms: ms ?? 0,
      }),
    )
  } else if (op === 'export') {
    const md = chunks ? exportChunksAsMarkdown(chunks) : ''
    const base = ((docId ? store.getDocument(docId)?.title : '') || '文档').replace(/\.[a-z0-9]+$/i, '')
    const filename = `${base}_整理.md`
    facts =
      `已生成整理后的 Markdown「${filename}」` +
      `${chunks?.length ? `（${chunks.length} 块，约 ${md.length.toLocaleString()} 字）` : ''}，可在导出界面下载`
    annots.push(
      workflowStepAnnotation({
        seq: 1,
        tool: 'ExportMarkdown',
        args: { docId },
        thought: '用户在底部操作栏点击「导出」按钮',
        observation: facts,
        ms: 0,
      }),
    )
  } else if (op === 'commit-batch') {
    // 批量入库（多文档「全部入库」按钮）：逐文档结果 + 整体统计
    const results = Array.isArray(opReport.results) ? opReport.results : []
    const okCount = num(opReport.okCount) ?? results.filter((x) => x?.ok).length
    const failCount = num(opReport.failCount) ?? results.length - okCount
    const detail = results
      .map((x) => {
        const t = x?.docId ? store.getDocument(x.docId)?.title : ''
        return `${x?.ok ? '✅' : '❌'} ${t || x?.docId}${x?.ok ? `（${x.chunkCount ?? '?'} 块）` : x?.error ? `：${x.error}` : ''}`
      })
      .join('；')
    facts =
      `批量入库完成：共 ${results.length} 份文档，成功 ${okCount} 份` +
      (failCount > 0 ? `，失败 ${failCount} 份（已入库的自动跳过）` : '') +
      (detail ? `。${detail}` : '')
    annots.push(
      workflowStepAnnotation({
        seq: 1,
        tool: 'CommitToStore',
        args: { batch: true, docIds: results.map((x) => x?.docId).filter(Boolean) },
        thought: '用户在底部操作栏点击「全部入库」按钮，批量确认入库',
        observation: facts,
        ms: 0,
      }),
    )
  } else {
    facts = '操作已完成'
  }

  // ── LLM 简要总结（一两句话）；不可用 / 失败时降级为「事实 + 引导语」
  let text = ''
  if (llmAvailable) {
    try {
      const { text: out } = await generateText({
        model: getChatModel({ role: 'chat.doc.react', agentId: 'doc-processor' }),
        abortSignal: signal,
        system: OP_REPORT_SYSTEM_PROMPT,
        prompt: `${buildHistoryBlock(history)}\n\n## 操作结果\n${facts}\n\n请向用户简要汇报。`,
      })
      text = (out || '').trim()
    } catch (err) {
      log.warn(`[docWorkflow] opReport 总结生成失败：${err.message}，降级兜底文案`)
    }
  }
  if (!text) text = `${facts}。${OP_GUIDANCE[op] || ''}`.trim()

  // ── 组装 data-stream：注解在前、文本在后（与 prependAnnotation 同口径）
  return new ReadableStream({
    async start(controller) {
      for (const a of annots) {
        controller.enqueue(encodeStreamLine(`2:${JSON.stringify([a])}`))
      }
      const segments = text.match(/[\s\S]{1,4}/g) ?? []
      for (const seg of segments) {
        controller.enqueue(encodeStreamLine(`0:${JSON.stringify(seg)}`))
        await new Promise((r) => setTimeout(r, 10))
      }
      controller.enqueue(encodeStreamLine(`d:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}`))
      controller.close()
    },
  })
}

/* ===================== 工作流注册（管理模块可见/可启停） ===================== */

workflowRegistry.register({
  name: DOC_WORKFLOW_NAME,
  label: '文档处理 ReAct 工作流',
  category: 'doc-processor',
  description: 'LLM 自主决策循环（思考→工具→观察），复合任务自动拆解为子任务逐一执行后汇总',
  dependsOn: ['AnalyzeDocument', 'PreviewChunks', 'AdjustChunks', 'CommitToStore', 'ExportMarkdown'],
  meta: { engine: 'doc-agent', maxSteps: MAX_STEPS },
})
