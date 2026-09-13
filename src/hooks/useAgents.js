import * as React from 'react'
import { listAgents, subscribeAgents } from '@/lib/agentRegistry'

/**
 * useAgents —— 订阅智能体注册表的 React hook（P1 服务端化）
 *
 * Sidebar / AppShell 等以 hook 订阅替代静态 AGENTS 快照：
 * 服务端清单加载、管理页增改、图标覆盖等注册变化都会触发重渲染。
 * hidden 项（内部路由智能体）不进入侧栏类消费场景，由调用方按需过滤。
 */
export function useAgents({ includeHidden = false } = {}) {
  const agents = React.useSyncExternalStore(subscribeAgents, listAgents)
  return React.useMemo(
    () => (includeHidden ? agents : agents.filter((a) => !a.hidden)),
    [agents, includeHidden],
  )
}
