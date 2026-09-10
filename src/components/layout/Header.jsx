import { Menu, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AGENT_STATUS, AGENT_STATUS_LABEL } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'

/**
 * Header —— 顶部状态栏
 *
 * 布局：[移动端菜单] [视图图标徽章 + 名称 + 状态] ... 说明文字（lg+） [主题切换]
 * 说明文字取当前 agent.description，窄屏隐藏保证标题完整。
 *
 * @param {Object} props
 * @param {Object} props.agent         当前智能体（或虚拟视图 agent）
 * @param {string} props.status       连接状态（取自 AGENT_STATUS）
 * @param {() => void} [props.onOpenSidebar] 打开移动端抽屉
 */
export function Header({ agent, status, onOpenSidebar }) {
  const { theme, toggleTheme } = useTheme()
  const statusColor = {
    [AGENT_STATUS.ONLINE]: 'bg-emerald-500',
    [AGENT_STATUS.THINKING]: 'bg-primary animate-pulse',
    [AGENT_STATUS.OFFLINE]: 'bg-muted-foreground/40',
  }[status]
  const Icon = agent?.icon

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/70 px-4 backdrop-blur-md md:px-6">
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

      <div className="ml-auto">
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
