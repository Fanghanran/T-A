import * as React from 'react'

/**
 * chatRegistry —— 并行聊天窗格注册表（M4 / ADR-008）
 *
 * 单页应用为每个已打开的智能体保留一个常驻 ChatPage 实例（pane）：
 *   - 切换智能体（URL /chat/:agentId）只切换可见 pane，不卸载其他 pane
 *     → 后台 pane 的流式对话继续进行，互不打断
 *   - 每个 pane 拥有独立的 useChat 实例 / AbortController / 会话列表 / 技术栈
 *   - 后台 pane 流式结束 → unread 计数，侧栏对应智能体显示徽标
 *
 * focus 不存进 registry：URL 是焦点的唯一来源（/chat/:agentId），保证刷新/直链一致。
 */

const ChatRegistryContext = React.createContext(null)

export function ChatRegistryProvider({ children }) {
  // [{ agentId: string, unread: number, busy: boolean }]
  const [chats, setChats] = React.useState([])

  /** 打开（或聚焦已存在的）智能体窗格；聚焦时清未读 */
  const openChat = React.useCallback((agentId) => {
    if (!agentId) return
    setChats((prev) => {
      const exists = prev.some((c) => c.agentId === agentId)
      if (!exists) return [...prev, { agentId, unread: 0, busy: false }]
      return prev.map((c) => (c.agentId === agentId && c.unread !== 0 ? { ...c, unread: 0 } : c))
    })
  }, [])

  /** 后台窗格一轮流式结束：未读 +1（仅由 ChatPage 在非焦点状态流结束时调用） */
  const markUnread = React.useCallback((agentId) => {
    setChats((prev) => prev.map((c) => (c.agentId === agentId ? { ...c, unread: c.unread + 1 } : c)))
  }, [])

  /** 显式清零某智能体未读（聚焦时兜底） */
  const clearUnread = React.useCallback((agentId) => {
    setChats((prev) => prev.map((c) => (c.agentId === agentId ? { ...c, unread: 0 } : c)))
  }, [])

  /** 上报窗格忙状态（流式进行中或历史加载中），驱动 Header 思考态与侧栏脉点 */
  const setBusy = React.useCallback((agentId, busy) => {
    setChats((prev) => {
      const target = prev.find((c) => c.agentId === agentId)
      if (!target || target.busy === busy) return prev
      return prev.map((c) => (c.agentId === agentId ? { ...c, busy } : c))
    })
  }, [])

  const value = React.useMemo(
    () => ({ chats, openChat, markUnread, clearUnread, setBusy }),
    [chats, openChat, markUnread, clearUnread, setBusy],
  )

  return <ChatRegistryContext.Provider value={value}>{children}</ChatRegistryContext.Provider>
}

export function useChatRegistry() {
  const ctx = React.useContext(ChatRegistryContext)
  if (!ctx) throw new Error('useChatRegistry 必须在 ChatRegistryProvider 内使用')
  return ctx
}
