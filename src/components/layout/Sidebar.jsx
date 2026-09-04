import * as React from 'react'
import {
  Bot,
  ChevronRight,
  BookOpen,
  LayoutDashboard,
  FileText,
  Settings2,
  History,
} from 'lucide-react'
import { AGENTS } from '@/lib/constants'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/**
 * Sidebar —— 左侧边栏
 *
 * 结构：
 *   智能体
 *     └ 面试题检索 / 知识库 / ...
 *   管理
 *     ├ 知识库 ▾       ← 可折叠目录（directory）
 *     │   ├ 仪表盘     ← 子菜单（统计面板）
 *     │   └ 文档管理   ← 子菜单（CRUD + 检索 + 批量）
 *     ├ 系统管理       ← 独立入口（工具/工作流启停 + 调优参数）
 *     └ 操作审计       ← 独立入口（启停/参数修改历史记录）
 *
 * 视图状态：activeView ∈ {'chat','dashboard','knowledge','management','audit'}
 *   - 'chat'       → ChatPage（agentId 决定具体智能体）
 *   - 'dashboard'  → DashboardPage（统计面板）
 *   - 'knowledge'  → KnowledgeBasePage（文档管理）
 *   - 'management' → ManagementPage（系统管理：工具/工作流注册表启停）
 *   - 'audit'      → AuditPage（操作审计）
 *
 * 行为：
 *   - 点击「仪表盘」/「文档管理」通过 onNavigateView(view) 切换主区域。
 *   - 「知识库」目录行点击只折叠/展开子菜单，不切换视图。
 *   - 知识库目录默认展开（首次进入能直接看到两个子项）。
 *   - 任一子项激活时，父目录行也保留浅高亮提示"当前在知识库下"。
 *
 * @param {Object} props
 * @param {string} props.currentAgentId    当前选中的聊天智能体 id
 * @param {string} [props.activeView]      'chat' | 'dashboard' | 'knowledge'
 * @param {(agent: Object) => void} props.onSelectAgent  选中聊天智能体
 * @param {(view: 'dashboard' | 'knowledge') => void} [props.onNavigateView] 切换管理视图
 * @param {() => void} [props.onNavigate]   任意导航后触发（用于移动端关闭抽屉）
 */
export function Sidebar({
  currentAgentId,
  activeView = 'chat',
  onSelectAgent,
  onNavigateView,
  onNavigate,
}) {
  // 知识库目录是否展开（默认展开，避免首次进入看不到「文档管理」入口）
  const [kbExpanded, setKbExpanded] = React.useState(true)

  const handleSelectAgent = (agent) => {
    if (!agent.available) return
    onSelectAgent?.(agent)
    onNavigate?.()
  }
  const handleNavigate = (view) => {
    onNavigateView?.(view)
    onNavigate?.()
  }

  const isChatAgentActive = (agentId) =>
    activeView === 'chat' && agentId === currentAgentId
  const isDashboard = activeView === 'dashboard'
  const isDocMgmt = activeView === 'knowledge'
  const isSysMgmt = activeView === 'management'
  const isAudit = activeView === 'audit'

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-soft">
          <Bot className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Interview Agent</span>
          <span className="text-[11px] text-muted-foreground">
            主从调度智能体
          </span>
        </div>
      </div>

      {/* ===== 上方：智能体列表（聊天视图） ===== */}
      <div className="px-3 py-4">
        <p className="px-2 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          智能体
        </p>
        <nav className="flex flex-col gap-1">
          {AGENTS.map((agent) => {
            const Icon = agent.icon
            const active = isChatAgentActive(agent.id)
            const disabled = !agent.available
            return (
              <button
                key={agent.id}
                type="button"
                disabled={disabled}
                onClick={() => handleSelectAgent(agent)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'group relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : !disabled && 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
                  disabled && 'cursor-not-allowed text-muted-foreground opacity-45',
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                )}
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{agent.name}</span>
                {disabled && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    即将上线
                  </Badge>
                )}
                {active && (
                  <ChevronRight className="h-4 w-4 text-primary" />
                )}
              </button>
            )
          })}
        </nav>
      </div>

      <Separator />

      {/* ===== 下方：管理区（知识库目录） ===== */}
      <div className="px-3 py-4">
        <p className="px-2 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          管理
        </p>
        <nav className="flex flex-col gap-1">
          {/* 知识库：可折叠目录（点击行只折叠/展开，不切视图） */}
          <div>
            <button
              type="button"
              onClick={() => setKbExpanded((v) => !v)}
              aria-expanded={kbExpanded}
              className={cn(
                'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                isDashboard || isDocMgmt
                  ? 'bg-accent/60 text-accent-foreground'
                  : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <BookOpen className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">知识库</span>
              <ChevronRight
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  kbExpanded && 'rotate-90',
                )}
              />
            </button>

            {/* 子菜单：仪表盘 + 文档管理 */}
            {kbExpanded && (
              <div className="mt-0.5 ml-3 flex flex-col gap-0.5 border-l pl-2">
                <button
                  type="button"
                  onClick={() => handleNavigate('dashboard')}
                  aria-current={isDashboard ? 'true' : undefined}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    isDashboard
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">仪表盘</span>
                  {isDashboard && (
                    <ChevronRight className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleNavigate('knowledge')}
                  aria-current={isDocMgmt ? 'true' : undefined}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    isDocMgmt
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">文档管理</span>
                  {isDocMgmt && (
                    <ChevronRight className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              </div>
            )}
          </div>

          {/* 系统管理：独立入口（工具/工作流注册表启停 + 调优参数） */}
          <button
            type="button"
            onClick={() => handleNavigate('management')}
            aria-current={isSysMgmt ? 'true' : undefined}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              isSysMgmt
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Settings2 className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">系统管理</span>
            {isSysMgmt && (
              <ChevronRight className="h-4 w-4 text-primary" />
            )}
          </button>

          {/* 操作审计：独立入口（启停/参数修改历史记录） */}
          <button
            type="button"
            onClick={() => handleNavigate('audit')}
            aria-current={isAudit ? 'true' : undefined}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              isAudit
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <History className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">操作审计</span>
            {isAudit && (
              <ChevronRight className="h-4 w-4 text-primary" />
            )}
          </button>
        </nav>
      </div>

      <div className="mt-auto p-4">
        <Separator className="mb-4" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          切换智能体会自动隔离对话上下文；管理区独立维护仪表盘与知识库。
        </p>
      </div>
    </div>
  )
}

export default Sidebar
