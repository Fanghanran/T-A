/**
 * knowledge-base 智能体（L4 领域层）
 *
 * 原 chat.js 知识库 RAG 分支提取：
 *   unifiedSearch 检索（含 query 改写 + 多 query 合并 + 加权）
 *   → streamRagAnswer 流式回答
 */

import { unifiedSearch } from '../../unifiedSearch.js'
import { streamRagAnswer } from '../../llm.js'
import { childLogger } from '../../logger.js'

const log = childLogger('chat')

export const knowledgeBaseAgent = {
  id: 'knowledge-base',
  name: 'knowledge-base',
  description: '知识库 RAG 智能体：unifiedSearch 检索 + streamRagAnswer 流式回答',
  aliases: ['知识库'],

  async handler(ctx) {
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
    return pipeStream(
      res,
      await streamRagAnswer({ query, chunks, searchMs, history, agentId, memoryBlock, signal }),
      { sessionId, onAssistantText: onAssistantDone },
    )
  },
}
