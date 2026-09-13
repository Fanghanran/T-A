import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, Moon, Sun, CircleUserRound, LogOut, UserRoundCog } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AGENT_STATUS, AGENT_STATUS_LABEL } from '@/lib/constants'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'

/** 用户菜单 —— 当前身份徽章 + 退出登录（身份来自全局 useAuth，与路由拦截同源） */
function UserMenu() {
  const navigate = useNavigate()
  const { status, mode, user, me, logout: authLogout } = useAuth()
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef(null)

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const authenticated = status === 'authenticated'
  const userOf = user ?? me?.user
  const displayName = authenticated
    ? userOf?.userId
    : mode === 'disabled' || status === 'disabled'
      ? 'local'
      : '未登录'

  const logout = () => {
    setOpen(false)
    authLogout() // 全局状态切 unauthenticated → AuthGate 自动跳登录页（disabled 模式仅清令牌）
    navigate('/')
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2"
        onClick={() => setOpen((v) => !v)}
        aria-label="用户菜单"
        title="当前身份"
      >
        <CircleUserRound className={cn('h-4 w-4', authenticated && 'text-primary')} />
        <span className="max-w-[10rem] truncate text-xs font-medium">{displayName}</span>
      </Button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-56 rounded-lg border bg-card p-2 shadow-soft">
          <div className="border-b px-2 pb-2">
            <p className="text-sm font-medium">{displayName}</p>
            <p className="text-[11px] text-muted-foreground">
              {mode === 'disabled'
                ? '单用户模式（AUTH_MODE=disabled）'
                : authenticated
                  ? [userOf?.role, userOf?.label].filter(Boolean).join(' · ') || '已登录'
                  : '未登录 —— 请先登录'}
            </p>
            {authenticated && userOf?.usage && (
              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                知识库 {userOf.usage.documents}/{userOf.usage.limits?.maxDocuments ?? '—'} 篇 ·{' '}
                {userOf.usage.chunks}/{userOf.usage.limits?.maxChunks ?? '—'} 切片
              </p>
            )}
          </div>
          <div className="pt-1">
            {authenticated ? (
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-accent/50"
              >
                <LogOut className="h-3.5 w-3.5" />
                {mode === 'disabled' ? '清除令牌' : '退出登录'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate('/auth')
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-accent/50"
              >
                <UserRoundCog className="h-3.5 w-3.5" />
                前往登录
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Header —— 顶部状态栏
 *
 * 布局：[移动端菜单] [视图图标徽章 + 名称 + 状态] ... 说明文字（lg+） [用户菜单] [主题切换]
 * 说明文字取当前 agent.description，窄屏隐藏保证标题完整。
 *
 * @param {Object} props
 * @param {Object} props.agent         当前智能体（或虚拟视图 agent）
 * @param {string} props.status       连接状态（取自 AGENT_STATUS）
 * @param {() => void} [props.onOpenSidebar] 打开移动端抽屉
 */
export function Header({ agent, status, onOpenSidebar, onOpenFavorites }) {
  const { theme, toggleTheme } = useTheme()
  const statusColor = {
    [AGENT_STATUS.ONLINE]: 'bg-emerald-500',
    [AGENT_STATUS.THINKING]: 'bg-primary animate-pulse',
    [AGENT_STATUS.OFFLINE]: 'bg-muted-foreground/40',
  }[status]
  const Icon = agent?.icon

  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-3 border-b bg-background/70 px-4 backdrop-blur-md md:px-6">
      {/* 移动端菜单按钮 */}
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onOpenSidebar}
        aria-label="打开菜单"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* 视图上下文：图标徽章 + 名称 + 状态点 */}
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && (
          <span className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-soft sm:flex">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <h1 className="truncate text-[15px] font-semibold tracking-tight">
          {agent?.name ?? '未选择智能体'}
        </h1>
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusColor)}
          aria-hidden
        />
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {AGENT_STATUS_LABEL[status] ?? ''}
        </span>
      </div>

      {/* 视图说明（宽屏展示，作为面包屑级上下文） */}
      {agent?.description && (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground/70 lg:inline lg:max-w-[36ch] lg:border-l lg:border-border lg:pl-3">
          {agent.description}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {onOpenFavorites && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenFavorites}
            aria-label="我的收藏"
            title="我的收藏（错题本）"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <Star className="h-4 w-4" />
          </Button>
        )}
        <UserMenu />
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label="切换主题"
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
        >
          {theme === 'dark' ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </Button>
      </div>
    </header>
  )
}

export default Header
