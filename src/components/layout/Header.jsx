import { Menu, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AGENT_STATUS, AGENT_STATUS_LABEL } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'

/**
 * Header —— 顶部状态栏（简约：仅保留智能体名 + 在线状态 + 主题切换）
 *
 * @param {Object} props
 * @param {Object} props.agent         当前智能体
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

      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-[15px] font-semibold tracking-tight">
          {agent?.name ?? '未选择智能体'}
        </h1>
        <span
          className={cn('h-1.5 w-1.5 rounded-full shrink-0', statusColor)}
          aria-hidden
        />
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {AGENT_STATUS_LABEL[status] ?? ''}
        </span>
      </div>

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
