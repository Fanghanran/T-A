import * as React from 'react'
import * as sessionApi from '@/lib/sessionApi'
import {
  restoreAnnotationsFromMessages,
  clearAnnotationsForChat,
} from '@/lib/runtimeAnnotations'
import { child } from '@/lib/logger'

const log = child('chat:history')

/**
 * useChatHistory —— 切换会话时从后端拉历史消息注入 chat
 *
 * sessionId 改变后，useAgentChat 内部 chatId 会变，useChat 会把 messages 重置成 []，
 * 然后这里再异步 setMessages(history)，视觉上表现为"先清空 → 再渲染老对话"。
 *
 * @param {Object} opts
 * @param {string} opts.agentName
 * @param {string} opts.currentSessionId
 * @param {(m: Array) => void} opts.setMessages            注入历史消息（来自 useAgentChat）
 * @param {React.MutableRefObject<string>} opts.stableChatIdRef 稳定 chatId ref（注解命名空间）
 */
export function useChatHistory({
  agentName,
  currentSessionId,
  setMessages,
  stableChatIdRef,
}) {
  const [loadingHistory, setLoadingHistory] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    log.debug('[useChatHistory] effect 触发', { agentName, currentSessionId })
    // 智能体 / 会话不存在 → 清空
    if (!agentName || !currentSessionId) {
      setMessages?.([])
      return
    }
    ;(async () => {
      setLoadingHistory(true)
      try {
        const detail = await sessionApi.getSessionDetail(currentSessionId)
        if (cancelled) return
        const arr = Array.isArray(detail?.messages) ? detail.messages : []
        log.debug('[useChatHistory] 获取到消息', {
          total: arr.length,
          withAnnotations: arr.filter((m) => m.annotations?.length).length,
        })

        // ChatPage 是「注解清理」的唯一入口：先清空该 chatId 下旧注解
        // （防止切会话时 A 的注解混入 B），紧接着 restore 新会话的注解。
        const targetChatId = stableChatIdRef.current
        clearAnnotationsForChat(targetChatId)
        restoreAnnotationsFromMessages(targetChatId, arr)

        // 后端 messages 形状：{id, role, content, createdAt, annotations?}
        // ⚠️ 不再把 annotations 传给 setMessages：Vercel AI SDK 规范化 messages 时可能丢弃
        //   自定义字段。全部 annotations 依赖 runtimeAnnotations 查表，最可靠。
        const mapped = arr.map((m) => ({
          id: m.id,
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content ?? '',
        }))
        setMessages?.(mapped)
      } catch (err) {
        log.error('[useChatHistory] 加载会话历史失败：', err)
      } finally {
        if (!cancelled) setLoadingHistory(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, agentName])

  return { loadingHistory }
}
