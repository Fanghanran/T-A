import * as React from 'react'
import {
  Bot,
  ChevronRight,
  BookOpen,
  LayoutDashboard,
  Folder,
  Network,
  History,
  Settings2,
  Workflow,
  Wrench,
  SlidersHorizontal,
  Database,
  Table2,
  Layers,
  BrainCircuit,
  MessagesSquare,
  UserRound,
  ShieldCheck,
  ScrollText,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useAgents } from '@/hooks/useAgents'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/** 激活态左侧刻度线（展开模式的精密指示） */
function ActiveNotch() {
  return (
    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
  )
}

/**
 * NavItem —— 导航行（展开 / 图标栏双形态）
 *
 * 展开态：图标 + 文字 + 右侧状态（未读徽标 / 忙碌脉点 / 箭头），激活行左侧有刻度线
 * 图标态（collapsed）：只渲染 40px 图标方块，原生 title 提示；未读转为右上角小圆点
 */
function NavItem({
  icon: Icon,
  label,
  active,
  disabled,
  collapsed,
  onClick,
  children, // 右侧自定义内容（徽标/脉点，仅展开态显示）
  titleExtra,
}) {
  if (collapsed) {
    const unread = typeof titleExtra === 'number' && titleExtra > 0
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        title={label}
        aria-current={active ? 'true' : undefined}
        aria-label={label}
        className={cn(
          'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          active
            ? 'bg-primary text-primary-foreground shadow-soft'
            : disabled
              ? 'cursor-not-allowed text-muted-foreground opacity-40'
              : 'text-foreground/70 hover:bg-accent hover:text-foreground',
        )}
      >
        <Icon className="h-[17px] w-[17px]" />
        {unread && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-card bg-primary" />
        )}
      </button>
    )
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        active
          ? 'bg-primary/10 font-medium text-primary'
          : disabled
            ? 'cursor-not-allowed text-muted-foreground opacity-45'
            : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
        disabled && 'cursor-not-allowed',
      )}
    >
      {active && <ActiveNotch />}
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {children}
      {active && <ChevronRight className="h-4 w-4 shrink-0 text-primary/60" />}
    </button>
  )
}

/** 忙碌脉点 / 未读徽标（展开态行尾状态） */
function AgentTailState({ busyBackground, unread }) {
  if (busyBackground)
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
        title="该智能体正在后台生成回复"
      />
    )
  if (unread > 0)
    return (
      <Badge className="h-4 min-w-4 shrink-0 rounded-full px-1 text-[10px] leading-4">
        {unread > 99 ? '99+' : unread}
      </Badge>
    )
  return null
}

/**
 * 可折叠目录组（展开态）：父按钮 + 缩进子项
 * 支持嵌套（nested）：数据库 ▾ → 向量库 ▾ → 数据结构 / 数据明细
 * 知识库 / 数据库共用同一交互模式
 */
function NavGroup({
  icon: Icon,
  label,
  expanded,
  onToggle,
  inGroup,
  nested = false,
  children,
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'group flex w-full items-center gap-3 rounded-lg text-left transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          nested ? 'px-2 py-1.5 text-[13px]' : 'px-2.5 py-2 text-sm',
          inGroup
            ? 'text-foreground'
            : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <Icon className={cn('shrink-0 text-muted-foreground', nested ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight
          className={cn(
            'text-muted-foreground transition-transform duration-200',
            nested ? 'h-3.5 w-3.5' : 'h-4 w-4',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div className={cn('mt-0.5 flex flex-col gap-0.5 border-l pl-2', nested ? 'ml-3' : 'ml-3')}>
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Sidebar —— 左侧边栏（展开 / 图标栏双形态）
 *
 * 结构：
 *   品牌行（Logo + 折叠开关）
 *   智能体    └ 面试题检索 / 简历分析 / ...
 *   管理
 *     ├ 知识库 ▾   ← 可折叠目录（图标态下拍平为三个独立图标）
 *     │   ├ 仪表盘
 *     │   ├ 文档管理
 *     │   └ 知识网络
 *     ├ 系统管理 ▾ ← 可折叠目录（图标态下拍平为五个独立图标）
 *     │   ├ 工作流管理
 *     │   ├ 工具管理
 *     │   ├ 参数管理
 *     │   ├ 操作审计
 *     │   └ 模型管理
 *     └ 数据库 ▾   ← 可折叠总目录（图标态下拍平为六个叶子图标）
 *         ├ 向量库 ▾   数据结构 / 数据明细
 *         ├ 记忆库 ▾   数据结构 / 数据明细（Milvus kb_memory + SQLite session_memory）
 *         └ 会话库 ▾   数据结构 / 数据明细（SQLite sessions_clean.db）
 *
 * @param {Object} props
 * @param {string} props.currentAgentId    当前选中的聊天智能体 id
 * @param {string} [props.activeView]      'chat' | 'dashboard' | 'knowledge' | 'knowledgeGraph' | 'mgmtWorkflows' | 'mgmtTools' | 'mgmtParams' | 'mgmtAudit' | 'mgmtModels' | 'vectorStructure' | 'vectorData'
 * @param {Array}  [props.chatStates]      并行窗格状态（chatRegistry：agentId/unread/busy）
 * @param {boolean} [props.collapsed]      图标栏模式（rail）
 * @param {() => void} [props.onToggleCollapse] 折叠/展开切换
 * @param {(agent: Object) => void} props.onSelectAgent  选中聊天智能体
 * @param {(view: string) => void} [props.onNavigateView] 切换管理视图
 * @param {() => void} [props.onNavigate]   任意导航后触发（用于移动端关闭抽屉）
 */
export function Sidebar({
  currentAgentId,
  activeView = 'chat',
  chatStates = [],
  collapsed = false,
  onToggleCollapse,
  onSelectAgent,
  onNavigateView,
  onNavigate,
}) {
  // 知识库 / 系统管理 / 数据库目录是否展开（默认展开，避免首次进入看不到子入口）
  const [kbExpanded, setKbExpanded] = React.useState(true)
  const [sysExpanded, setSysExpanded] = React.useState(true)
  const [dbExpanded, setDbExpanded] = React.useState(true)
  const [vsExpanded, setVsExpanded] = React.useState(true)
  const [memExpanded, setMemExpanded] = React.useState(true)
  const [sessExpanded, setSessExpanded] = React.useState(true)
  const [baseExpanded, setBaseExpanded] = React.useState(true)
  const [auditExpanded, setAuditExpanded] = React.useState(true)

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
  const isKnowledgeGraph = activeView === 'knowledgeGraph'
  const isMgmtWorkflows = activeView === 'mgmtWorkflows'
  const isMgmtTools = activeView === 'mgmtTools'
  const isMgmtParams = activeView === 'mgmtParams'
  const isMgmtAudit = activeView === 'mgmtAudit'
  const isMgmtModels = activeView === 'mgmtModels'
  const isMgmtUsers = activeView === 'mgmtUsers'
  const isMgmtRoles = activeView === 'mgmtRoles'
  const isMgmtAgents = activeView === 'mgmtAgents'
  const isVectorStructure = activeView === 'vectorStructure'
  const isVectorData = activeView === 'vectorData'
  const isMemoryStructure = activeView === 'memoryStructure'
  const isMemoryData = activeView === 'memoryData'
  const isSessionStructure = activeView === 'sessionStructure'
  const isSessionData = activeView === 'sessionData'
  const isBaseStructure = activeView === 'baseStructure'
  const isBaseData = activeView === 'baseData'
  const isAuditStructure = activeView === 'auditStructure'
  const isAuditData = activeView === 'auditData'
  const { hasPerm: canPerm } = useAuth()
  const agents = useAgents()
  // 目录级可见性：任一子项有权限才渲染目录（空目录不展示）
  const showKbDir = canPerm('dashboard', 'kb', 'graph')
  const showSysDir = canPerm(
    'mgmt.workflows',
    'mgmt.tools',
    'mgmt.params',
    'mgmt.audit',
    'mgmt.models',
    'mgmt.users',
    'mgmt.roles',
    'mgmt.agents',
  )
  const showDbDir = canPerm('db')
  const inKb = isDashboard || isDocMgmt || isKnowledgeGraph
  const inSys =
    isMgmtWorkflows || isMgmtTools || isMgmtParams || isMgmtAudit || isMgmtModels || isMgmtUsers || isMgmtRoles || isMgmtAgents
  const inVector = isVectorStructure || isVectorData
  const inMemory = isMemoryStructure || isMemoryData
  const inSession = isSessionStructure || isSessionData
  const inBase = isBaseStructure || isBaseData
  const inAuditDb = isAuditStructure || isAuditData
  const inDb = inVector || inMemory || inSession || inBase || inAuditDb

  return (
    <div className="flex h-full flex-col bg-card">
      {/* ===== 品牌行：Logo + 名称 + 折叠开关 ===== */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b',
          collapsed ? 'justify-center px-2' : 'gap-2.5 px-4',
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-soft">
          <Bot className="h-4 w-4" />
        </div>
        {!collapsed && (
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">
              Interview Agent
            </span>
            <span className="text-[11px] text-muted-foreground">
              主从调度智能体
            </span>
          </div>
        )}
        {onToggleCollapse && !collapsed && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="收起为图标栏"
            aria-label="收起为图标栏"
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150',
              'hover:bg-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ===== 导航主体（空间不足时独立滚动） ===== */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin">
        {/* 上方：智能体列表 */}
        <div className={cn('py-4', collapsed ? 'px-2' : 'px-3')}>
          {!collapsed && (
            <p className="px-2 pb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              智能体
            </p>
          )}
          <nav
            className={cn(
              'flex flex-col',
              collapsed ? 'gap-2 items-center' : 'gap-1',
            )}
          >
            {agents.map((agent) => {
              const Icon = agent.icon
              const active = isChatAgentActive(agent.id)
              const state = chatStates.find((c) => c.agentId === agent.id)
              const busyBackground = Boolean(state?.busy) && !active
              const unread = !active ? (state?.unread ?? 0) : 0
              return (
                <NavItem
                  key={agent.id}
                  icon={Icon}
                  label={agent.name}
                  active={active}
                  disabled={!agent.available}
                  collapsed={collapsed}
                  onClick={() => handleSelectAgent(agent)}
                  titleExtra={unread}
                >
                  <AgentTailState
                    busyBackground={busyBackground}
                    unread={unread}
                  />
                </NavItem>
              )
            })}
          </nav>
        </div>

        <Separator className="mx-3 shrink-0" />

        {/* 下方：管理区（三个目录全部无权限时整区隐藏，含「管理」小标题） */}
        {(showKbDir || showSysDir || showDbDir) && (
        <div className={cn('py-4', collapsed ? 'px-2' : 'px-3')}>
          {!collapsed && (
            <p className="px-2 pb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              管理
            </p>
          )}
          <nav
            className={cn(
              'flex flex-col',
              collapsed ? 'gap-2 items-center' : 'gap-1',
            )}
          >
            {/* 知识库目录：展开态为可折叠目录；图标态拍平为「仪表盘 / 文档管理 / 知识网络」三个独立图标（按权限过滤） */}
            {collapsed ? (
              <>
                {canPerm('dashboard') && (
                  <NavItem
                    icon={LayoutDashboard}
                    label="仪表盘"
                    active={isDashboard}
                    collapsed
                    onClick={() => handleNavigate('dashboard')}
                  />
                )}
                {canPerm('kb') && (
                  <NavItem
                    icon={Folder}
                    label="知识管理"
                    active={isDocMgmt}
                    collapsed
                    onClick={() => handleNavigate('knowledge')}
                  />
                )}
                {canPerm('graph') && (
                  <NavItem
                    icon={Network}
                    label="知识网络"
                    active={isKnowledgeGraph}
                    collapsed
                    onClick={() => handleNavigate('knowledgeGraph')}
                  />
                )}
              </>
            ) : showKbDir ? (
              <NavGroup
                icon={BookOpen}
                label="知识库"
                expanded={kbExpanded}
                onToggle={() => setKbExpanded((v) => !v)}
                inGroup={inKb}
              >
                {canPerm('dashboard') && (
                  <NavItem
                    icon={LayoutDashboard}
                    label="仪表盘"
                    active={isDashboard}
                    onClick={() => handleNavigate('dashboard')}
                  />
                )}
                {canPerm('kb') && (
                  <NavItem
                    icon={Folder}
                    label="知识管理"
                    active={isDocMgmt}
                    onClick={() => handleNavigate('knowledge')}
                  />
                )}
                {canPerm('graph') && (
                  <NavItem
                    icon={Network}
                    label="知识网络"
                    active={isKnowledgeGraph}
                    onClick={() => handleNavigate('knowledgeGraph')}
                  />
                )}
              </NavGroup>
            ) : null}

            {/* 图标态下的分组间隔 */}
            {collapsed && <span className="h-px w-5 bg-border" aria-hidden />}

            {/* 系统管理目录：展开态为可折叠目录（7 子菜单）；图标态拍平为独立图标。
                每项按 RBAC 权限过滤（canPerm），无权限的菜单整体隐藏 */}
            {collapsed ? (
              <>
                {canPerm('mgmt.workflows') && (
                  <NavItem
                    icon={Workflow}
                    label="工作流管理"
                    active={isMgmtWorkflows}
                    collapsed
                    onClick={() => handleNavigate('mgmtWorkflows')}
                  />
                )}
                {canPerm('mgmt.tools') && (
                  <NavItem
                    icon={Wrench}
                    label="工具管理"
                    active={isMgmtTools}
                    collapsed
                    onClick={() => handleNavigate('mgmtTools')}
                  />
                )}
                {canPerm('mgmt.params') && (
                  <NavItem
                    icon={SlidersHorizontal}
                    label="参数管理"
                    active={isMgmtParams}
                    collapsed
                    onClick={() => handleNavigate('mgmtParams')}
                  />
                )}
                {canPerm('mgmt.audit') && (
                  <NavItem
                    icon={History}
                    label="操作审计"
                    active={isMgmtAudit}
                    collapsed
                    onClick={() => handleNavigate('mgmtAudit')}
                  />
                )}
                {canPerm('mgmt.models') && (
                  <NavItem
                    icon={Bot}
                    label="模型管理"
                    active={isMgmtModels}
                    collapsed
                    onClick={() => handleNavigate('mgmtModels')}
                  />
                )}
                {canPerm('mgmt.users') && (
                  <NavItem
                    icon={UserRound}
                    label="成员管理"
                    active={isMgmtUsers}
                    collapsed
                    onClick={() => handleNavigate('mgmtUsers')}
                  />
                )}
                {canPerm('mgmt.roles') && (
                  <NavItem
                    icon={ShieldCheck}
                    label="角色管理"
                    active={isMgmtRoles}
                    collapsed
                    onClick={() => handleNavigate('mgmtRoles')}
                  />
                )}
                {canPerm('mgmt.agents') && (
                  <NavItem
                    icon={Bot}
                    label="智能体管理"
                    active={isMgmtAgents}
                    collapsed
                    onClick={() => handleNavigate('mgmtAgents')}
                  />
                )}
              </>
            ) : showSysDir ? (
              <NavGroup
                icon={Settings2}
                label="系统管理"
                expanded={sysExpanded}
                onToggle={() => setSysExpanded((v) => !v)}
                inGroup={inSys}
              >
                {canPerm('mgmt.workflows') && (
                  <NavItem
                    icon={Workflow}
                    label="工作流管理"
                    active={isMgmtWorkflows}
                    onClick={() => handleNavigate('mgmtWorkflows')}
                  />
                )}
                {canPerm('mgmt.tools') && (
                  <NavItem
                    icon={Wrench}
                    label="工具管理"
                    active={isMgmtTools}
                    onClick={() => handleNavigate('mgmtTools')}
                  />
                )}
                {canPerm('mgmt.params') && (
                  <NavItem
                    icon={SlidersHorizontal}
                    label="参数管理"
                    active={isMgmtParams}
                    onClick={() => handleNavigate('mgmtParams')}
                  />
                )}
                {canPerm('mgmt.audit') && (
                  <NavItem
                    icon={History}
                    label="操作审计"
                    active={isMgmtAudit}
                    onClick={() => handleNavigate('mgmtAudit')}
                  />
                )}
                {canPerm('mgmt.models') && (
                  <NavItem
                    icon={Bot}
                    label="模型管理"
                    active={isMgmtModels}
                    onClick={() => handleNavigate('mgmtModels')}
                  />
                )}
                {canPerm('mgmt.users') && (
                  <NavItem
                    icon={UserRound}
                    label="成员管理"
                    active={isMgmtUsers}
                    onClick={() => handleNavigate('mgmtUsers')}
                  />
                )}
                {canPerm('mgmt.roles') && (
                  <NavItem
                    icon={ShieldCheck}
                    label="角色管理"
                    active={isMgmtRoles}
                    onClick={() => handleNavigate('mgmtRoles')}
                  />
                )}
                {canPerm('mgmt.agents') && (
                  <NavItem
                    icon={Bot}
                    label="智能体管理"
                    active={isMgmtAgents}
                    onClick={() => handleNavigate('mgmtAgents')}
                  />
                )}
              </NavGroup>
            ) : null}

            {/* 图标态下的分组间隔 */}
            {collapsed && <span className="h-px w-5 bg-border" aria-hidden />}

            {/* 数据库目录：向量库 / 记忆库 / 会话库 / 基础库 四个子菜单（各含数据结构+数据明细）；
                图标态拍平为八个叶子图标（title 带库名前缀区分）；整体受 db 权限过滤 */}
            {showDbDir && (collapsed ? (
              <>
                <NavItem
                  icon={Table2}
                  label="向量结构"
                  active={isVectorStructure}
                  collapsed
                  onClick={() => handleNavigate('vectorStructure')}
                />
                <NavItem
                  icon={Layers}
                  label="向量明细"
                  active={isVectorData}
                  collapsed
                  onClick={() => handleNavigate('vectorData')}
                />
                <NavItem
                  icon={Table2}
                  label="记忆结构"
                  active={isMemoryStructure}
                  collapsed
                  onClick={() => handleNavigate('memoryStructure')}
                />
                <NavItem
                  icon={Layers}
                  label="记忆明细"
                  active={isMemoryData}
                  collapsed
                  onClick={() => handleNavigate('memoryData')}
                />
                <NavItem
                  icon={Table2}
                  label="会话结构"
                  active={isSessionStructure}
                  collapsed
                  onClick={() => handleNavigate('sessionStructure')}
                />
                <NavItem
                  icon={Layers}
                  label="会话明细"
                  active={isSessionData}
                  collapsed
                  onClick={() => handleNavigate('sessionData')}
                />
                <NavItem
                  icon={Table2}
                  label="基础结构"
                  active={isBaseStructure}
                  collapsed
                  onClick={() => handleNavigate('baseStructure')}
                />
                <NavItem
                  icon={Layers}
                  label="基础明细"
                  active={isBaseData}
                  collapsed
                  onClick={() => handleNavigate('baseData')}
                />
                <NavItem
                  icon={Table2}
                  label="审计结构"
                  active={isAuditStructure}
                  collapsed
                  onClick={() => handleNavigate('auditStructure')}
                />
                <NavItem
                  icon={Layers}
                  label="审计明细"
                  active={isAuditData}
                  collapsed
                  onClick={() => handleNavigate('auditData')}
                />
              </>
            ) : (
              <NavGroup
                icon={Database}
                label="数据库"
                expanded={dbExpanded}
                onToggle={() => setDbExpanded((v) => !v)}
                inGroup={inDb}
              >
                <NavGroup
                  icon={Table2}
                  label="向量库"
                  expanded={vsExpanded}
                  onToggle={() => setVsExpanded((v) => !v)}
                  inGroup={inVector}
                  nested
                >
                  <NavItem
                    icon={Table2}
                    label="数据结构"
                    active={isVectorStructure}
                    onClick={() => handleNavigate('vectorStructure')}
                  />
                  <NavItem
                    icon={Layers}
                    label="数据明细"
                    active={isVectorData}
                    onClick={() => handleNavigate('vectorData')}
                  />
                </NavGroup>
                <NavGroup
                  icon={BrainCircuit}
                  label="记忆库"
                  expanded={memExpanded}
                  onToggle={() => setMemExpanded((v) => !v)}
                  inGroup={inMemory}
                  nested
                >
                  <NavItem
                    icon={Table2}
                    label="数据结构"
                    active={isMemoryStructure}
                    onClick={() => handleNavigate('memoryStructure')}
                  />
                  <NavItem
                    icon={Layers}
                    label="数据明细"
                    active={isMemoryData}
                    onClick={() => handleNavigate('memoryData')}
                  />
                </NavGroup>
                <NavGroup
                  icon={MessagesSquare}
                  label="会话库"
                  expanded={sessExpanded}
                  onToggle={() => setSessExpanded((v) => !v)}
                  inGroup={inSession}
                  nested
                >
                  <NavItem
                    icon={Table2}
                    label="数据结构"
                    active={isSessionStructure}
                    onClick={() => handleNavigate('sessionStructure')}
                  />
                  <NavItem
                    icon={Layers}
                    label="数据明细"
                    active={isSessionData}
                    onClick={() => handleNavigate('sessionData')}
                  />
                </NavGroup>
                <NavGroup
                  icon={UserRound}
                  label="基础库"
                  expanded={baseExpanded}
                  onToggle={() => setBaseExpanded((v) => !v)}
                  inGroup={inBase}
                  nested
                >
                  <NavItem
                    icon={Table2}
                    label="数据结构"
                    active={isBaseStructure}
                    onClick={() => handleNavigate('baseStructure')}
                  />
                  <NavItem
                    icon={Layers}
                    label="数据明细"
                    active={isBaseData}
                    onClick={() => handleNavigate('baseData')}
                  />
                </NavGroup>
                <NavGroup
                  icon={ScrollText}
                  label="审计库"
                  expanded={auditExpanded}
                  onToggle={() => setAuditExpanded((v) => !v)}
                  inGroup={inAuditDb}
                  nested
                >
                  <NavItem
                    icon={Table2}
                    label="数据结构"
                    active={isAuditStructure}
                    onClick={() => handleNavigate('auditStructure')}
                  />
                  <NavItem
                    icon={Layers}
                    label="数据明细"
                    active={isAuditData}
                    onClick={() => handleNavigate('auditData')}
                  />
                </NavGroup>
              </NavGroup>
            ))}
          </nav>
        </div>
        )}
      </div>

      {/* ===== 底部：展开态显示提示语 / 图标态显示展开按钮 ===== */}
      {collapsed ? (
        <div className="flex shrink-0 justify-center border-t p-2">
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title="展开侧边栏"
              aria-label="展开侧边栏"
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150',
                'hover:bg-accent hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              )}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        <div className="shrink-0 p-4">
          <Separator className="mb-3" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            切换智能体会自动隔离对话上下文；管理区独立维护仪表盘与知识库。
          </p>
        </div>
      )}
    </div>
  )
}

export default Sidebar
