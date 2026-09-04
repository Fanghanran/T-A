import * as React from 'react'
import { Bot } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StreamingMessage } from './StreamingMessage'

/**
 * TypingIndicator —— AI 思考中的三点加载动画
 */
function TypingIndicator() {
  return (
    <div className="flex items-center gap-3 animate-fade-in">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-soft">
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-border/60 bg-card px-4 py-3 shadow-soft">
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground" />
      </div>
    </div>
  )
}

/**
 * MessageList —— 消息列表
 *
 * 行为：
 * - 渲染整段对话历史。
 * - 当 isLoading 且最后一条非用户消息为空时，展示 TypingIndicator。
 * - messages 变化时自动滚动到底部。
 * - 支持传入 chatId（useChat 的 id 参数，也就是智能体 id），
 *   StreamingMessage 会用 chatId + 消息序号去 runtimeAnnotations 查表，
 *   把后端「2:」推送的 Recall search_results 注解合并到面板上，
 *   避免 useChat 流式分片覆盖掉 annotations 字段。
 *
 * @param {Object} props
 * @param {import('ai').Message[]} props.messages 消息列表
 * @param {boolean} props.isLoading 是否正在生成
 * @param {string} [props.chatId] 当前 useChat 的 id / 智能体 id（传了才能显示 Recall 过程独立卡片）
 * @param {(instruction:string, docId:string)=>void} [props.onAdjust] 切片调整指令回调，透传给 StreamingMessage
 */
export function MessageList({ messages, isLoading, chatId, onAdjust }) {
  const bottomRef = React.useRef(null)
  const previousMessageCount = React.useRef(messages.length)
  const previousLoading = React.useRef(isLoading)

  // Scroll only when a message/typing indicator is added, and only if the user
  // is already near the bottom. Streaming token updates keep the current viewport.
  React.useEffect(() => {
    const messageAdded = messages.length > previousMessageCount.current
    const loadingStarted = isLoading && !previousLoading.current
    previousMessageCount.current = messages.length
    previousLoading.current = isLoading
    if (!messageAdded && !loadingStarted) return

    const viewport = bottomRef.current?.closest(
      '[data-radix-scroll-area-viewport]',
    )
    if (!viewport) return
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distanceFromBottom <= 120) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages.length, isLoading])

  const lastMessage = messages[messages.length - 1]
  const showTyping =
    isLoading &&
    (!lastMessage || lastMessage.role === 'user' || !lastMessage.content)

  return (
    <ScrollArea className="flex-1 scrollbar-thin">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
        {messages.length === 0 && !isLoading && (
          <div className="mt-16 text-center text-sm text-muted-foreground">
            选择左侧智能体开始对话，支持流式 Markdown 输出。
          </div>
        )}

        {messages.map((m, i) => (
          <StreamingMessage
            key={m.id ?? i}
            message={m}
            allMessages={messages}
            chatId={chatId}
            msgIndex={i}
            onAdjust={onAdjust}
            streaming={
              isLoading && i === messages.length - 1 && m.role === 'assistant'
            }
          />
        ))}

        {showTyping && <TypingIndicator />}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}

export default MessageList
