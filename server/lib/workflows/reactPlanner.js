import { generateText } from 'ai'
import { childLogger } from '../logger.js'
import { tunables } from '../tunables.js'
import { toolRegistry, workflowRegistry } from '../management/registry.js'
import { appendAudit } from '../management/audit.js'
import { getChatModel } from '../llmProvider.js'
import { truncate, workflowStepAnnotation, buildHistoryBlock, createEmitters } from './docWorkflowShared.js'
// 首批 ReAct 工具注册（副作用 import：kb.search / kb.documentInfo / memory.write）

/**
 * reactPlanner —— ReAct 自主规划器（通用 Agent 能力设计 P2 / L7 编排层）
 *
 * 定位：现有模式是「意图分类 → 固定智能体」；本规划器让模型自己走
 * 思考（Thought）→ 选工具（Action）→ 观察（Observation）循环完成复合任务，
 * 例：「查一下知识库里向量库的选型结论，把要点写进长期记忆」。
 *
 * 硬边界（设计书 §5）：
 *  - 只能用白名单工具（toolRegistry 中 category='react' 且未禁用），禁直连其他注册工具
 *  - 知识库写入/删除类工具不对自主规划开放（写记忆除外，幂等可回退）
 *  - 三重熔断：步数上限 / 单步超时 / 总预算，触发即中止并显式说明未完成
 *  - 每步落审计（management/audit.js，action=react.step）；工具失败重试 1 次后跳过
 *
 * 输出契约：AI SDK data-stream 协议 ReadableStream（与 docPlanWorkflow 同口径）：
 *   `0:` 文本分片 / `2:` 注解（agent_workflow 卡片，engine=react-agent）/ `d:` 结束行
 */

const log = childLogger('reactPlanner')

/** 工作流注册名（chat 路由据此判断启停） */
export const REACT_WORKFLOW_NAME = 'react-planner'

/** 观察截断上限（回填下一轮上下文时，防 scratchpad 撑爆上下文窗口） */
const OBSERVATION_MAX_CHARS = 2000

/** 规划器决策模型路由：通用对话角色（三级解析 agent > role > 默认） */
const PLANNER_ROLE = 'chat.general'
const PLANNER_AGENT_ID = 'react-planner'

/* ===================== 决策解析与超时辅助 ===================== */

/**
 * 解析 LLM 的决策输出。容忍 markdown 围栏与前后杂文，取首个完整 JSON 对象。
 * @returns {{ thought:string, action:string, args:object, result:string } | null}
 */
function parseDecision(raw) {
  let t = String(raw ?? '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(t.slice(start, end + 1))
    return {
      thought: typeof obj.thought === 'string' ? obj.thought : '',
      action: typeof obj.action === 'string' ? obj.action.trim() : '',
      args: obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args) ? obj.args : {},
      result: typeof obj.result === 'string' ? obj.result : '',
    }
  } catch {
    return null
  }
}

/** 单步硬超时（Promise.race 熔断；超时后底层 promise 允许自然结束，结果被丢弃） */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** System Prompt 的工具白名单块（只列 category='react' 且启用中的工具） */
function buildToolListBlock() {
  const tools = toolRegistry.listEnabled().filter((t) => t.category === 'react')
  if (!tools.length) return '（当前没有可用工具）'
  return tools.map((t) => `- ${t.name}：${t.description}。参数：${t.params || '无'}`).join('\n')
}

/** 白名单：ReAct 可用工具名集合（每次调用重算，管理端禁用即时生效） */
function allowedTools() {
  return new Set(toolRegistry.listEnabled().filter((t) => t.category === 'react').map((t) => t.name))
}

function reactStepAnnotation({ seq, tool, args, thought, observation, ms }) {
  return workflowStepAnnotation({ seq, tool, args, thought, observation, ms, engine: 'react-agent' })
}

/* ===================== System Prompt ===================== */

function buildSystemPrompt() {
  return [
    '你是自主规划智能体（ReAct）。通过「思考 → 选工具 → 观察」循环完成用户目标。',
    '',
    '## 可用工具',
    buildToolListBlock(),
    '',
    '## 输出格式（严格 JSON，不要输出任何其他文本）',
    '{"thought":"当前分析与下一步理由（简明）","action":"工具名 或 finish","args":{},"result":""}',
    'result 仅在 action=finish 时必填：面向用户的完整中文最终回答。',
    '',
    '## 规则',
    '- 每轮只调用一个工具；args 必须符合工具的参数说明',
    '- 观察会以上一轮结果形式给出；若工具报错，调整参数或换思路，不要用相同参数原样重试',
    '- finish 时必须综合全部观察给出完整回答；知识库没有的内容要明说，禁止编造',
    '- 目标已完成就尽快 finish，不要无意义地重复检索',
  ].join('\n')
}

/** 组装第 N 轮的用户提示：目标 + 对话历史 + scratchpad */
function buildStepPrompt({ goal, history, steps }) {
  const lines = [`## 用户目标\n${goal}`, buildHistoryBlock(history)]
  if (steps.length) {
    lines.push('## 已执行步骤')
    for (const s of steps) {
      lines.push(`### 第 ${s.seq} 步`)
      lines.push(`Thought: ${s.thought || '（无）'}`)
      lines.push(`Action: ${s.tool}(${JSON.stringify(s.args)})`)
      lines.push(`Observation: ${truncate(s.observation, OBSERVATION_MAX_CHARS) || '（空）'}`)
    }
  } else {
    lines.push('## 已执行步骤\n（无，这是第一步）')
  }
  lines.push('请输出下一轮决策 JSON。')
  return lines.join('\n\n')
}

/* ===================== 规划器主流程 ===================== */

/**
 * 运行 ReAct 自主规划器。
 * @param {{ query:string, history?:Array, signal?:AbortSignal, ownerId:string, sessionId?:string }} params
 * @returns {Promise<ReadableStream<Uint8Array>>} AI SDK data-stream 协议流
 */
export async function runReactPlanner({ query, history = [], signal, ownerId, sessionId }) {
  return new ReadableStream({
    async start(controller) {
      const { emitText, emitAnnotation, emitDone } = createEmitters(controller)
      const cfg = tunables.react ?? {}
      const maxSteps = Math.max(1, Number(cfg.maxSteps) || 8)
      const stepTimeoutMs = Math.max(3000, Number(cfg.stepTimeoutMs) || 30000)
      const totalBudgetMs = Math.max(10000, Number(cfg.totalBudgetMs) || 180000)
      const runId = `react_${Date.now().toString(36)}`
      const t0 = Date.now()
      const steps = []
      let seq = 0
      let aborted = '' // 熔断原因（空 = 正常 finish）
      let finished = false // 是否经 finish 正常退出

      try {
        emitText(`收到，我来规划执行这个任务（最多 ${maxSteps} 步）。\n\n`)
        const allowed = allowedTools()

        for (let i = 1; i <= maxSteps; i++) {
          // —— 熔断 3：总预算 ——
          const elapsed = Date.now() - t0
          if (elapsed >= totalBudgetMs) {
            aborted = `总预算 ${Math.round(totalBudgetMs / 1000)}s 已用尽`
            break
          }

          // ① Thought：LLM 决策（单步超时同样约束 LLM 调用）
          let decision = null
          let decisionErr = ''
          try {
            const { text } = await withTimeout(
              generateText({
                model: getChatModel({ role: PLANNER_ROLE, agentId: PLANNER_AGENT_ID }),
                abortSignal: signal,
                system: buildSystemPrompt(),
                prompt: buildStepPrompt({ goal: query, history, steps }),
              }),
              stepTimeoutMs,
              `第 ${i} 步决策`,
            )
            decision = parseDecision(text)
            if (!decision) decisionErr = '决策输出不是合法 JSON'
          } catch (err) {
            if (signal?.aborted) throw new Error('请求已取消')
            decisionErr = err.message
          }
          if (!decision) {
            // 决策层失败：错误作为观察回填下一轮（LLM 自修正）；连败会自然耗尽步数触发显式中止
            steps.push({ seq: ++seq, tool: '(parse)', args: {}, thought: '', observation: `上一轮决策输出不是合法 JSON（${decisionErr}），请重新决策。` })
            appendAudit('react.step', { runId, sessionId, seq, tool: '(parse)', ok: false, error: decisionErr })
            emitText(`⚠ 第 ${i} 步决策解析失败（${decisionErr}），重试中…\n\n`)
            continue
          }

          seq++
          const { thought, action, args, result } = decision

          // ② finish：校验 result 后退出
          if (action === 'finish') {
            const finalText = result.trim()
            if (!finalText) {
              steps.push({ seq, tool: 'finish', args: {}, thought, observation: '错误：finish 缺少 result 字段，请重新决策并给出完整回答。' })
              appendAudit('react.step', { runId, sessionId, seq, tool: 'finish', ok: false, error: 'finish 缺少 result' })
              continue
            }
            appendAudit('react.step', { runId, sessionId, seq, tool: 'finish', ok: true, thought })
            emitAnnotation(reactStepAnnotation({ seq, tool: 'FINISH', args: {}, thought, observation: truncate(finalText, 400), ms: 0 }))
            emitText(finalText)
            steps.push({ seq, tool: 'finish', args: {}, thought, observation: finalText })
            finished = true
            break
          }

          // ③ 白名单拦截：未注册 / 已禁用 / 非反应类工具一律拒绝
          if (!allowed.has(action)) {
            steps.push({ seq, tool: action, args, thought, observation: `错误：工具 ${action} 不存在、已禁用或未开放给自主规划。可用工具见 System Prompt 白名单。` })
            appendAudit('react.step', { runId, sessionId, seq, tool: action, ok: false, error: '工具不在白名单' })
            emitText(`**第 ${i} 步 · ${action}**\n\n⚠ 该工具不可用（不存在/已禁用/未开放），已跳过。\n\n`)
            continue
          }

          // ④ 执行：失败重试 1 次，仍失败把错误作为观察交还 Thought 层
          emitText(`**第 ${i} 步 · ${toolRegistry.get(action)?.label ?? action}**\n\n`)
          const run = toolRegistry.resolveRunner(action)
          const tStep = performance.now()
          let obs = ''
          let ok = true
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const res = await withTimeout(run({ ownerId, sessionId }, args, { query, history }), stepTimeoutMs, `工具 ${action}（第 ${attempt} 次）`)
              obs = String(res?.observation ?? '')
              ok = true
              break
            } catch (err) {
              if (signal?.aborted) throw new Error('请求已取消')
              ok = false
              obs = `工具执行失败（第 ${attempt} 次）：${err.message}`
              log.warn(`[reactPlanner] ${runId} 第 ${seq} 步 ${action} 第 ${attempt} 次失败：${err.message}`)
            }
          }
          const ms = performance.now() - tStep
          appendAudit('react.step', { runId, sessionId, seq, tool: action, ok, ms: Math.round(ms), error: ok ? undefined : obs })
          emitAnnotation(reactStepAnnotation({ seq, tool: action, args, thought, observation: truncate(obs, 400), ms }))
          if (ok) emitText(`✓ 完成（${Math.round(ms)}ms）\n\n`)
          else emitText(`✗ 失败：${truncate(obs, 160)}\n\n`)
          steps.push({ seq, tool: action, args, thought, observation: obs })
        }

        // —— 收尾：熔断/步数耗尽的显式降级汇总（不静默） ——
        if (!finished && !aborted) aborted = `已达最大步数（${maxSteps}）`
        if (aborted) {
          let summary = ''
          try {
            const { text } = await generateText({
              model: getChatModel({ role: PLANNER_ROLE, agentId: PLANNER_AGENT_ID }),
              abortSignal: signal,
              system: '你根据已执行的部分步骤结果，用中文简要说明：已完成什么、得到哪些中间结论、因中止还剩什么没做。3 句以内，不编造。',
              prompt: `用户目标：${query}\n中止原因：${aborted}\n\n已执行步骤：\n${steps
                .map((s) => `${s.seq}. ${s.tool}：${truncate(s.observation, 400)}`)
                .join('\n')}`,
            })
            summary = String(text || '').trim()
          } catch {
            /* 降级拼接 */
          }
          if (!summary) {
            summary = steps.length
              ? `已完成 ${steps.length} 步：\n${steps.map((s) => `${s.seq}. ${s.tool} —— ${truncate(s.observation, 200)}`).join('\n')}`
              : '尚未执行任何步骤。'
          }
          emitText(`\n\n⚠ **任务未完全完成**（${aborted}）。已完成的中间结果：\n\n${summary}`)
          appendAudit('react.step', { runId, sessionId, seq: ++seq, tool: 'ABORT', ok: false, reason: aborted })
        }

        const totalMs = Date.now() - t0
        appendAudit('react.run', { runId, sessionId, steps: steps.length, totalMs, aborted: aborted || undefined })
        log.info(`[reactPlanner] ${runId} 完成：${steps.length} 步 / ${totalMs}ms${aborted ? ` / 中止（${aborted}）` : ''}`)
        emitDone()
      } catch (err) {
        log.error({ msg: err.message, stack: err.stack }, '[reactPlanner] 规划执行异常')
        emitText(`智能体执行出错：${err.message}`)
        appendAudit('react.run', { runId, sessionId, steps: steps.length, totalMs: Date.now() - t0, error: err.message })
        emitDone()
      } finally {
        controller.close()
      }
    },
  })
}

/* ===================== 工作流注册（管理模块可见/可启停） ===================== */

workflowRegistry.register({
  name: REACT_WORKFLOW_NAME,
  label: 'ReAct 自主规划器',
  category: 'react',
  description: '模型自主走 思考→选工具→观察 循环完成复合任务（白名单工具 + 三重熔断 + 每步审计）',
  dependsOn: ['kb.search', 'kb.documentInfo', 'memory.write'],
  meta: { engine: 'react-agent' },
})
