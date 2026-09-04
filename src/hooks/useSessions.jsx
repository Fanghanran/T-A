import * as React from 'react'
import * as sessionApi from '@/lib/sessionApi'
import { child } from '@/lib/logger'

const log = child('session')

/**
 * useSessions —— 会话列表 & 当前选中会话 Hook（每个 agent 绑定一份自己的会话）
 *
 * 核心职责：
 *  1. 加载/刷新当前 agentName 对应的会话列表（按 updatedAt 倒序，后端已排序）
 *  2. 维护 currentSessionId：新建 / 切换 / 删除后自动选中合适的会话
 *  3. 暴露 create / rename / delete / select 操作
 *
 * @param {{ agentName: string }} param0
 */
export function useSessions({ agentName }) {
  const [sessions, setSessions] = React.useState([])
  const [currentSessionId, setCurrentSessionId] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const safeAgentName = typeof agentName === 'string' ? agentName : ''

  // 竞态守卫：快速切换 agent 时，仅最后一次 reload 允许落 state（旧 agent 的列表直接丢弃）
  const reloadSeq = React.useRef(0)

  // 切 agent → 1) 清空 currentSessionId  2) 拉该 agent 的会话列表
  const reload = React.useCallback(async () => {
    if (!safeAgentName) {
      setSessions([])
      setCurrentSessionId('')
      return
    }
    const seq = ++reloadSeq.current
    setLoading(true)
    try {
      const list = await sessionApi.listSessions(safeAgentName)
      if (seq !== reloadSeq.current) return list // 已切到其他 agent，丢弃过期列表
      setSessions(list)
      setCurrentSessionId((prev) => {
        // 如果之前选中的会话还在该 agent 的列表里，保留它；否则选中最新一条
        if (prev && list.some((s) => s.id === prev)) return prev
        return list[0]?.id ?? ''
      })
      return list
    } catch (err) {
      if (seq !== reloadSeq.current) return []
      log.error('[useSessions] 列表加载失败：', err)
      return []
    } finally {
      if (seq === reloadSeq.current) setLoading(false)
    }
  }, [safeAgentName])

  React.useEffect(() => {
    reload()
  }, [reload])

  // 新建会话
  // - 当前会话存在且消息数为 0（空会话）时，默认复用它而不是再建一个空壳
  // - force=true 跳过复用逻辑（删除后、或者业务必须要一个新会话的场景使用）
  const create = React.useCallback(
    async ({ title, force = false } = {}) => {
      if (!safeAgentName) return null
      if (!force) {
        const cur = currentSessionId
          ? sessions.find((s) => s.id === currentSessionId)
          : undefined
        if (cur && (cur.messageCount ?? 0) === 0) {
          // 空会话直接复用：如果调用方指定了 title，顺手改掉当前空会话的标题
          if (
            typeof title === 'string' &&
            title.trim() &&
            cur.title !== title.trim()
          ) {
            try {
              const meta = await sessionApi.renameSession(
                cur.id,
                title.trim().slice(0, 100),
              )
              if (meta) {
                setSessions((prev) =>
                  prev.map((s) => (s.id === cur.id ? { ...s, ...meta } : s)),
                )
              }
            } catch (err) {
              log.error('[useSessions] 复用空会话时重命名失败：', err)
            }
          }
          return cur
        }
      }
      const meta = await sessionApi.createSession({
        agentName: safeAgentName,
        title,
      })
      if (meta) {
        setSessions((prev) => [meta, ...prev])
        setCurrentSessionId(meta.id)
      }
      return meta
    },
    [safeAgentName, currentSessionId, sessions],
  )

  // 删除会话
  const remove = React.useCallback(async (id) => {
    if (!id) return
    await sessionApi.deleteSession(id)
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      setCurrentSessionId((cur) => {
        if (cur !== id) return cur
        // 删的是当前选中的 → 优先选前一条，没有就选后一条，再没有就空
        const idx = prev.findIndex((s) => s.id === id)
        if (next[idx]) return next[idx].id
        if (next[idx - 1]) return next[idx - 1].id
        if (next[0]) return next[0].id
        return ''
      })
      return next
    })
  }, [])

  // 重命名会话（乐观更新）
  const rename = React.useCallback(async (id, title) => {
    if (!id) return
    const safe =
      typeof title === 'string' && title.trim()
        ? title.trim().slice(0, 100)
        : ''
    if (!safe) return
    try {
      const meta = await sessionApi.renameSession(id, safe)
      if (meta) {
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, ...meta } : s)),
        )
      }
    } catch (err) {
      log.error('[useSessions] 重命名失败：', err)
      throw err
    }
  }, [])

  return {
    sessions,
    currentSessionId,
    loading,
    setCurrentSessionId,
    reload,
    create,
    rename,
    delete: remove,
  }
}

export default useSessions
