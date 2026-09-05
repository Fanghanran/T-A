/**
 * mock-interview 智能体（L4 领域层）
 *
 * 玩法：技术栈定向的多轮模拟面试。
 *  - 正常轮：AI 面试官逐题提问，对候选人上一条回答即时点评 + 追问（流式文本，可引用 questionBank 候选题）。
 *  - finish：候选人点「结束并评分」→ 基于完整对话历史输出 interview_scorecard 评分卡。
 * 多轮上下文由 ctx.history 提供（routes/chat 已注入会话窗口）。
 */
import * as questionBank from '../../questionBank.js'
import { streamMockInterview } from '../../llm.js'

export const mockInterviewAgent = {
  id: 'mock-interview',
  name: 'mock-interview',
  description: '模拟面试：技术栈定向多轮问答 + 即时点评 + 结束评分报告',
  aliases: ['模拟面试'],

  async handler(ctx) {
    const { query, techStack, history, req, res, sessionId, onAssistantDone, pipeStream, dbg, agentId, memoryBlock } = ctx
    const finish = req.body?.interviewFinish === true

    let results = []
    if (!finish) {
      const q = query || (Array.isArray(techStack) ? techStack[0] : '')
      try {
        results = q ? questionBank.search(q, { techStack, limit: 3 }) || [] : []
      } catch {
        results = []
      }
    }

    dbg(`[mock-interview] finish=${finish} | techStack=${JSON.stringify(techStack)} | 参考题=${results.length}`)
    return pipeStream(
      res,
      await streamMockInterview({ query, techStack, history, results, finish, agentId, memoryBlock }),
      { sessionId, onAssistantText: onAssistantDone },
    )
  },
}
