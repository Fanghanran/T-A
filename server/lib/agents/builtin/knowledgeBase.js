/**
 * knowledge-base 智能体（L4 领域层）
 *
 * 原 chat.js 知识库 RAG 分支提取：
 *   unifiedSearch 检索（含 query 改写 + 多 query 合并 + 加权）
 *   → streamRagAnswer 流式回答
 */

import { unifiedSearch, buildReasoningTrace } from '../../unifiedSearch.js'
import { streamRagAnswer } from '../../llm.js'
import { prependAnnotation } from '../../streamUtils.js'
import { childLogger } from '../../logger.js'

const log = childLogger('chat')

/**
 * 知识库检索 + 流式回答的共享流程。
 * handler 与 P1 generic rag 智能体共用；opts.persona 追加自定义人设。
 */
export async function knowledgeBaseFlow(ctx, { persona = '' } = {}) {
  const { query, history, res, sessionId, onAssistantDone, pipeStream, dbg, agentId, memoryBlock, signal, ownerId } = ctx

  dbg(`[RAG] 触发知识库检索 | 问题: ${query.slice(0, 50)}...`)
  const t0 = performance.now()
  const u = await unifiedSearch({
    q: query,
    scope: 'knowledge',
    topK: 5,
    history, // 透传历史上下文给 Query Rewriter
    caller: agentId,
    ownerId,
  })
  const chunks = u.knowledgeResults?.items ?? []
  const searchMs = Math.round(performance.now() - t0)
  const kr = u.knowledgeResults
  // 汇总日志改走 info：一次请求仅一条，不算高频。此前用 dbg，
  // 默认 level=info 下完全静默，线上无法回答「改写到底有没有用」。
  log.info({
    msg: '[RAG] 检索完成',
    hits: chunks.length,
    searchMs,
    rewriteMs: kr?.rewriteMs ?? 0,
    totalMs: kr?.totalMs ?? searchMs,
    rewritten: Boolean(kr?.rewritten),
    queries: kr?.queries ?? [],
  })
  chunks.forEach((c, i) => {
    dbg(`      ${i + 1}. ${c.title}${c.heading ? ' / ' + c.heading : ''}${c.topic ? ' / topic:' + c.topic : ''} (相似度: ${(c.score * 100).toFixed(1)}%)`)
  })
  // 检索思考链路（改写 → 多路检索 → 融合排序）卡片化：复用 agent_workflow 注解，
  // 与文档智能体的工作流面板同一套前端渲染
  const reasoningTrace = buildReasoningTrace(kr, { engine: 'knowledge-rag' })
  const ragStream = await streamRagAnswer({ query, chunks, searchMs, history, agentId, memoryBlock, persona, signal })
  return pipeStream(
    res,
    prependAnnotation(ragStream, reasoningTrace),
    { sessionId, onAssistantText: onAssistantDone },
  )
}

export const knowledgeBaseAgent = {
  id: 'knowledge-base',
  name: 'knowledge-base',
  description: '知识库 RAG 智能体：unifiedSearch 检索 + streamRagAnswer 流式回答',
  aliases: ['知识库'],

  async handler(ctx) {
    return knowledgeBaseFlow(ctx)
  },
}
