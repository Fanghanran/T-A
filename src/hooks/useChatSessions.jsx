import * as React from 'react'
import { useSessions } from '@/hooks/useSessions'
import { child } from '@/lib/logger'

const log = child('chat:sessions')

/**
 * useSessionList —— 聊天会话列表管理
 *
 * 职责：
 *  - 会话列表（useSessions）与当前选中会话
 *  - 处理后端 x-session-id 响应头：首轮自动新建会话的延迟切换
 *    （等流式结束再切，避免流式进行中改 currentSessionId 导致 useChat 重建中断推流）
 *
 * @param {string} agentName 智能体 id
 */
export function useSessionList(agentName) {
  const {
    sessions,
    currentSessionId,
    loading: sessionsLoading,
    setCurrentSessionId,
    reload: reloadSessions,
    create: createSession,
    rename: renameSession,
    delete: deleteSession,
  } = useSessions({ agentName })

  // 首轮自动创建的会话 id（header 回传）：等本轮流式结束后再自动切换选中
  const autoPendingSidRef = React.useRef('')

  /** 后端在响应头里回传了 sessionId（要么是匹配到已有的，要么是自动新建的） */
  const handleSessionIdFromHeader = React.useCallback(
    (sid) => {
      if (!sid) return
      // 1）当前已经有选中会话 → 直接刷新列表（让它的 updatedAt 上浮），不切选中项
      if (currentSessionId) {
        if (sid === currentSessionId) {
          reloadSessions().catch((e) =>
            log.warn('[useSessionList] 刷新会话列表失败', e),
          )
        }
        return
      }
      // 2）当前还没选中会话 → 说明这是"首轮自动新建"的会话，存 pending，等流式结束后再切
      autoPendingSidRef.current = sid
    },
    [currentSessionId, reloadSessions],
  )

  /** 流式结束后由页面调用：若有 pending 新建会话 id，刷新列表并选中。
   *  仅当刷新成功且列表确实包含该 sid 才切换（失败/已被删则不切，避免选中不存在的会话）。 */
  const flushPendingSessionSwitch = React.useCallback(
    (isStreaming) => {
      if (isStreaming) return
      const sid = autoPendingSidRef.current
      if (!sid) return
      autoPendingSidRef.current = ''
      if (currentSessionId) return
      reloadSessions().then((list) => {
        if (Array.isArray(list) && list.some((s) => s.id === sid)) {
          setCurrentSessionId(sid)
        } else {
          log.warn('[useSessionList] pending 会话不在列表中，放弃自动切换', { sid })
        }
      })
    },
    [currentSessionId, reloadSessions, setCurrentSessionId],
  )

  return {
    sessions,
    currentSessionId,
    sessionsLoading,
    setCurrentSessionId,
    reloadSessions,
    createSession,
    renameSession,
    deleteSession,
    handleSessionIdFromHeader,
    flushPendingSessionSwitch,
  }
}
