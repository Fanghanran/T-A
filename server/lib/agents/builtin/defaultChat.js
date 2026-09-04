/**
 * default-chat 智能体（L4 领域层）
 *
 * 原 chat.js 通用对话兜底分支提取：
 *   streamChat 通用对话流式回答
 */

import { streamChat } from '../../llm.js'

export const defaultChatAgent = {
  id: 'default-chat',
  name: 'default-chat',
  description: '通用对话智能体：streamChat 通用对话',
  aliases: [],

  async handler(ctx) {
    const { query, history, techStack, res, sessionId, onAssistantDone, pipeStream, dbg } = ctx

    dbg(`[Chat] 通用对话`)
    return pipeStream(
      res,
      await streamChat({ query, techStack, history }),
      { sessionId, onAssistantText: onAssistantDone },
    )
  },
}
