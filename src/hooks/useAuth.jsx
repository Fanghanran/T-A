import * as React from 'react'
import { setUserToken } from '@/lib/api'
import { fetchAuthMe } from '@/lib/authClient'

/**
 * useAuth —— 全局认证状态（用户模块 v2 路由拦截的核心）
 *
 * status 四态：
 *   loading          启动时 /me 查询中（渲染启动屏，避免闪烁跳转）
 *   disabled         AUTH_MODE=disabled 单用户模式（拦截全放行，零回归）
 *   authenticated    jwt 模式且令牌有效
 *   unauthenticated  jwt 模式未登录 / 令牌缺失或失效
 *
 * 事件约定：
 *   - api.request() 在 401 时广播 `auth:required`（既有行为）
 *   - 本 Provider 按模式分流：jwt → 清令牌 + 广播 `auth:expired`（AuthGate
 *     监听后跳 /auth?redirect=...）；disabled / legacy token → 不处理
 *     （后者由 AuthTokenDialog 弹粘贴框兜底）
 */

const AuthContext = React.createContext(null)

export function AuthProvider({ children }) {
  // me 保留原始响应（registrationEnabled / oauth / usage 等供菜单直接消费）
  const [state, setState] = React.useState({ status: 'loading', mode: null, user: null, me: null })

  const applyMe = React.useCallback((me) => {
    const status = me?.authenticated
      ? 'authenticated'
      : me?.mode === 'disabled'
        ? 'disabled'
        : 'unauthenticated'
    setState({ status, mode: me?.mode ?? null, user: me?.user ?? null, me: me ?? null })
  }, [])

  /**
   * 权限判定（RBAC）：disabled 单用户恒全权（'*'）；admin 角色后端返回 ['*']。
   * perm 传权限点 key（见后端 PERM_CATALOG），anyOf 传多个点表示「满足其一即可」。
   */
  const hasPerm = React.useCallback(
    (...keys) => {
      if (state.status === 'disabled') return true
      const holds = state.user?.perms ?? []
      if (holds.includes('*')) return true
      return keys.some((k) => holds.includes(k))
    },
    [state.status, state.user],
  )

  const refresh = React.useCallback(async () => {
    try {
      applyMe(await fetchAuthMe())
    } catch {
      // 网络抖动不把已认证用户踢下线；仅未知态降级为未登录
      setState((s) =>
        s.status === 'authenticated' ? s : { status: 'unauthenticated', mode: s.mode, user: null, me: null },
      )
    }
  }, [applyMe])

  const logout = React.useCallback(() => {
    setUserToken('')
    setState((s) => ({
      status: s.mode === 'disabled' ? 'disabled' : 'unauthenticated',
      mode: s.mode,
      user: null,
      me: s.me ? { ...s.me, authenticated: false, user: null } : null,
    }))
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  React.useEffect(() => {
    // 多标签同步：任一窗口改了令牌，本窗口重新判定身份
    const onStorage = (e) => {
      if (e.key === 'userToken') refresh()
    }
    // 401 分流：jwt 模式令牌失效 → 清令牌并广播 auth:expired（AuthGate 跳登录）
    const onRequired = (e) => {
      setState((s) => {
        if (s.mode !== 'jwt') return s // disabled / legacy token / 未判定：交给原兜底（弹窗）
        setUserToken('')
        window.dispatchEvent(new CustomEvent('auth:expired', { detail: { message: e?.detail?.message } }))
        return { status: 'unauthenticated', mode: s.mode, user: null, me: null }
      })
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('auth:required', onRequired)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('auth:required', onRequired)
    }
  }, [refresh])

  const value = React.useMemo(
    () => ({ ...state, hasPerm, refresh, logout }),
    [state, hasPerm, refresh, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  return ctx
}

/** 仅允许站内路径（防 open-redirect：拒绝 //host、/\host、绝对 URL） */
export function sanitizeRedirect(raw) {
  const v = String(raw || '')
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/'
  return v
}
