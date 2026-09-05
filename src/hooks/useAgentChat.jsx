import * as React from 'react'
import { useChatWithAnnotations } from './useChatWithAnnotations'
import { API_CHAT_ENDPOINT } from '@/lib/constants'
import {
  clearAnnotationsForChat,
  migrateAnnotations,
} from '@/lib/runtimeAnnotations'
import { child } from '@/lib/logger'

const log = child('chat')

/**
 * useAgentChat —— 基于智能体 + 会话的聊天 Hook
 *
 * 核心职责（相比原版本新增会话管理闭环）：
 *  1. 封装【带 annotation 消费能力的 Vercel AI SDK useChat】，流式对话状态。
 *  2. 【stableChatId 稳定性保证】：
 *     传入 sessionId 变化时区分两种情况：
 *       a) 「首轮自动新建」：sessionId prop 从 ''→非空，且此时 chat.messages 非空
 *          （说明本轮流式 annotation 已经写入 agent.id 临时命名空间）。
 *          → 不换 stableChatId，保留旧命名空间下的 Recall 卡片，避免卡片晚一轮显示。
 *       b) 「手动切另一个会话」：其他任何 sessionId 变化场景
 *          → 换 stableChatId，清理旧命名空间下的 annotations，useChat 实例重建。
 *  3. 请求 body 注入 sessionId（后端据此把 user/assistant 消息持久化到该会话 + 读取历史上下文窗口）。
 *  4. 拦截响应：读取 `x-session-id` header，首次发消息后端自动创建会话后会回传新 id，
 *     通过 onSessionId 回调给父级（让 useSessions 刷新列表并选中）。
 *
 * @param {Object} params
 * @param {Object} params.agent
 * @param {string[]} params.techStack
 * @param {string} [params.sessionId]   当前选中的会话 id（空表示无会话/需后端新建）
 * @param {(id:string)=>void} [params.onSessionId]  从响应头读到 sessionId 时回调
 * @returns {Object} useChat 返回值 + setMessages + stableChatId（传给 MessageList 查 Recall 卡片用）
 */
export function useAgentChat({ agent, techStack, sessionId, onSessionId }) {
  const safeSid =
    typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : ''
  const initialStable = safeSid || agent?.id || '__agent_chat__'
  const [stableChatId, setStableChatId] = React.useState(initialStable)
  // ref 版本的 stableChatId：在 effect 中同步更新，避免 state 异步更新导致的时序问题
  const stableChatIdRef = React.useRef(initialStable)
  const prevSidRef = React.useRef(safeSid)

  // 每次 sessionId 变化时把 `x-session-id` 回调 ref 重置，避免异步响应污染
  const sessionCbRef = React.useRef(onSessionId)
  React.useEffect(() => {
    sessionCbRef.current = onSessionId
  }, [onSessionId])

  const chat = useChatWithAnnotations({
    id: stableChatId,
    api: API_CHAT_ENDPOINT,
    body: {
      agentName: agent?.id,
      techStack: techStack ?? [],
      sessionId: safeSid || undefined,
    },

    onResponse: (resp) => {
      try {
        const sid = resp?.headers?.get?.('x-session-id')
        if (typeof sid === 'string' && sid.trim()) {
          const safe = sid.trim()
          sessionCbRef.current?.(safe)
        }
      } catch (err) {
        log.error('[useAgentChat] 读取 x-session-id 响应头失败：', err)
      }
    },
  })

  // 导出 pause/resume 注解清理（ChatPage 加载历史消息期间调用）
  const { pauseAnnotationsClear, resumeAnnotationsClear } = chat

  // 【关键】sessionId prop 变化时处理注解命名空间迁移：
  //  - 首轮自动新建：annotations 写入了 agent.id 命名空间，后端返回 sess_xx 后
  //    需要迁移注解到 sess_xx 命名空间（即使 messages 已被 useChat 重建清空也没关系，
  //    注解存在独立 Map 中，只要 key 对就能查到）。
  //  - 手动切换会话：清理旧命名空间，重建 useChat。
  React.useEffect(() => {
    const newSid = safeSid
    const prevSid = prevSidRef.current
    if (newSid === prevSid) {
      prevSidRef.current = newSid
      return
    }

    const agentDefault = agent?.id || '__agent_chat__'
    const oldStable = stableChatIdRef.current
    const nextStable = newSid || agentDefault

    // 首轮自动新建场景：prev 空、new 非空
    // annotations 写入了 agent.id 命名空间，需要迁移到 sess_xx 命名空间
    const isAutoFirstRound = !prevSid && newSid
    if (isAutoFirstRound && nextStable !== oldStable) {
      try {
        migrateAnnotations(oldStable, nextStable)
      } catch (err) {
        log.error('[useAgentChat] 注解迁移失败：', {
          from: oldStable,
          to: nextStable,
          err,
        })
      }
      stableChatIdRef.current = nextStable
      setStableChatId(nextStable)
      prevSidRef.current = newSid
      return
    }

    // 其他情况：正常切换会话（或手动新建立即选中） → 换 stableId + 清旧队列
    if (nextStable !== oldStable) {
      try {
        clearAnnotationsForChat(oldStable)
      } catch (err) {
        log.error('[useAgentChat] 清理旧命名空间注解失败：', {
          chatId: oldStable,
          err,
        })
      }
      stableChatIdRef.current = nextStable
      setStableChatId(nextStable)
    }
    prevSidRef.current = newSid
  }, [safeSid, chat.messages.length, agent?.id])

  return {
    ...chat,
    // 对外暴露稳定 chatId，供 <MessageList chatId=...> 查表用
    stableChatId,
    // ref 版本：在 effect 回调中使用可获取最新值，避免 state 异步更新的时序问题
    stableChatIdRef,
    // 注解清理控制（ChatPage 加载历史时调用，避免刚恢复就被清掉）
    pauseAnnotationsClear,
    resumeAnnotationsClear,
  }
}

export default useAgentChat
