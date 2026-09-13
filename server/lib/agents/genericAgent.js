/**
 * genericAgent —— 自定义智能体（Agent Spec）的通用执行体（P1）
 *
 * 按 spec.runtime 分发：
 *   'chat' → streamChat（spec.systemPrompt 作为完整人设）
 *   'rag'  → knowledgeBaseFlow（检索链路复用；spec.systemPrompt 作为 persona 追加）
 *
 * 注册别名：中文名 + 用户别名都指向本 agent（@提及 / 意图路由可命中）。
 */

import { streamChat } from '../llm.js'
import { knowledgeBaseFlow } from './builtin/knowledgeBase.js'
import { childLogger } from '../logger.js'

const log = childLogger('genericAgent')

export function genericAgentDef(spec) {
  return {
    id: spec.id,
    type: 'custom',
    name: spec.id,
    description: spec.description || spec.name,
    aliases: [spec.name, ...(spec.aliases ?? [])].filter(Boolean),

    async handler(ctx) {
      const persona = spec.systemPrompt?.trim() ?? ''
      if (spec.runtime === 'rag') {
        return knowledgeBaseFlow(ctx, { persona })
      }
      // react：带工具的自主规划执行体；工具白名单 = spec.tools ∩ react 类启用工具（planner 内取交集）。
      // runReactPlanner 与 workflowRegistry 均由 routes/chat.js（L8）注入 ctx，避免 L4→L7/L5 反向依赖；
      // 依赖 react-planner 工作流启用，被停用时回落纯对话并显式告警（不静默假装有能力）。
      if (spec.runtime === 'react' && ctx.runReactPlanner) {
        if (!ctx.workflowRegistry?.isEnabled('react-planner')) {
          log.warn(`[genericAgent] ${spec.id} 需要 react-planner 工作流，当前已停用 → 回落纯对话`)
          // 不 return，走下方 chat 分支
        } else {
          return ctx.pipeStream(
            ctx.res,
            await ctx.runReactPlanner({
              query: ctx.query,
              history: ctx.history,
              signal: ctx.signal,
              ownerId: ctx.ownerId,
              sessionId: ctx.sessionId,
              toolFilter: Array.isArray(spec.tools) && spec.tools.length ? spec.tools : undefined,
              agentId: spec.id,
            }),
            { sessionId: ctx.sessionId, onAssistantText: ctx.onAssistantDone },
          )
        }
      }
      return ctx.pipeStream(
        ctx.res,
        await streamChat({
          query: ctx.query,
          techStack: ctx.techStack,
          history: ctx.history,
          agentId: ctx.agentId,
          memoryBlock: ctx.memoryBlock,
          systemPrompt: persona,
          signal: ctx.signal,
        }),
        { sessionId: ctx.sessionId, onAssistantText: ctx.onAssistantDone },
      )
    },
  }
}
