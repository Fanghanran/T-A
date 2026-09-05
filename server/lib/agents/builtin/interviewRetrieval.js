/**
 * interview-retrieval 智能体（L4 领域层）
 *
 * 原 chat.js 面试题检索分支提取：
 *   unifiedSearch 双路召回（结构化题目 + 知识库片段）
 *   → streamInterviewAnswer 流式回答
 */

import { unifiedSearch } from '../../unifiedSearch.js'
import { streamInterviewAnswer } from '../../llm.js'

export const interviewRetrievalAgent = {
  id: 'interview-retrieval',
  name: 'interview-retrieval',
  description: '面试题检索智能体：unifiedSearch 双路召回 + streamInterviewAnswer',
  aliases: ['面试题检索'],

  async handler(ctx) {
    const { query, history, techStack, res, sessionId, onAssistantDone, pipeStream, dbg, agentId, memoryBlock, signal } = ctx
    const LIMIT = 5

    dbg(`[面试检索] 触发统一检索 | query: ${query.slice(0, 50)}... | techStack: ${JSON.stringify(techStack)}`)
    const t0 = performance.now()
    const u = await unifiedSearch({
      q: query,
      scope: 'all',
      techStack,
      topK: LIMIT,
      history, // Query Rewriter 用（KB 分支的多 query 改写）
      caller: agentId,
    })
    const searchMs = Math.round(performance.now() - t0)

    const results = u.questionResults?.items ?? []
    const questionSearchMs = u.questionResults?.searchMs ?? 0
    const ragChunks = u.knowledgeResults?.items ?? []
    const ragSearchMs = u.knowledgeResults?.searchMs ?? 0

    dbg(`[面试检索] 结构化命中 ${results.length} 题（${questionSearchMs}ms）`)
    results.forEach((r) => {
      dbg(`      #${r.rank} [${r.difficulty}/${r.category}] ${r.title.slice(0, 40)}… (匹配度 ${(r.score * 100).toFixed(1)}%)`)
    })
    dbg(`[面试检索] 知识库命中 ${ragChunks.length} 条（${ragSearchMs}ms）`)
    ragChunks.forEach((c, i) => {
      dbg(`      ${i + 1}. ${c.title}${c.heading ? ' / ' + c.heading : ''} (相似度: ${(c.score * 100).toFixed(1)}%)`)
    })

    return pipeStream(
      res,
      await streamInterviewAnswer({
        query,
        results,
        techStack,
        searchMs: questionSearchMs,
        ragChunks,
        ragSearchMs,
        history,
        agentId,
        memoryBlock,
        signal,
      }),
      { sessionId, onAssistantText: onAssistantDone },
    )
  },
}
