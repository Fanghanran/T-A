import * as React from 'react'
import { BrowserRouter, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { ThemeProvider } from '@/hooks/useTheme'
import { AuthProvider, useAuth, sanitizeRedirect } from '@/hooks/useAuth'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useGlobalError } from '@/hooks/useGlobalError'
import AuthPage from '@/pages/AuthPage'

// 首次访问（无 localStorage 记忆时）跟随系统深浅色偏好，而非硬编码 dark
const _prefersDark =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
const _systemDefault = _prefersDark ? 'dark' : 'light'

/** 启动/身份判定中的全屏占位（避免闪烁式跳转） */
function AuthSplash() {
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="text-sm">正在确认身份…</p>
    </div>
  )
}

/** 拼接登录页地址（携带回跳目标） */
function loginUrl(redirect) {
  const target = sanitizeRedirect(redirect)
  return target === '/' ? '/auth' : `/auth?redirect=${encodeURIComponent(target)}`
}

/**
 * AuthGate —— 路由拦截（用户模块 v2）
 *
 * 规则：
 *   - loading：全屏启动屏，等 /api/auth/me 判定完成（防止「先跳登录又弹回」闪烁）
 *   - 受保护页面 + unauthenticated → /auth?redirect=<原地址>（登录后原样回跳）
 *   - /auth 页面 + disabled 或已登录 → 回首页（无需登录/重复登录）
 *   - jwt 模式会话中 401（auth:expired 事件）→ 携带当前地址跳登录页
 *   - disabled 模式：除 /auth 重定向外一切照旧，零回归
 */
function AuthGate({ children }) {
  const { status } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const isAuthRoute = location.pathname.startsWith('/auth')
  const here = `${location.pathname}${location.search}`

  React.useEffect(() => {
    if (status !== 'authenticated') return
    // 已登录后令牌再失效（401）→ 跳登录并记录回跳地址
    const onExpired = () => {
      navigate(loginUrl(here), { replace: true })
    }
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [status, here, navigate])

  if (status === 'loading') return <AuthSplash />

  if (isAuthRoute) {
    if (status === 'disabled' || status === 'authenticated') return <Navigate to="/" replace />
    return children // AuthPage（含 /auth/callback 落地视图）
  }

  if (status === 'unauthenticated') return <Navigate to={loginUrl(here)} replace />

  return children
}

/**
 * AuthRoutes —— 按路由分流：/auth* 独立登录版式（无侧边栏），其余走 AppShell
 */
function AuthRoutes() {
  const location = useLocation()
  if (location.pathname.startsWith('/auth')) return <AuthPage />
  return <AppShell />
}

/**
 * App —— 根组件
 * 包裹主题 Provider 与认证 Provider；AuthGate 承载路由拦截。
 */
export default function App() {
  useGlobalError()
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={_systemDefault}>
        <BrowserRouter>
          <AuthProvider>
            <AuthGate>
              <AuthRoutes />
            </AuthGate>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
