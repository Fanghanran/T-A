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

export function genericAgentDef(spec) {
  return {
    id: spec.id,
    name: spec.id,
    description: spec.description || spec.name,
    aliases: [spec.name, ...(spec.aliases ?? [])].filter(Boolean),

    async handler(ctx) {
      const persona = spec.systemPrompt?.trim() ?? ''
      if (spec.runtime === 'rag') {
        return knowledgeBaseFlow(ctx, { persona })
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
