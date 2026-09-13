import * as React from 'react'
import {
  BookOpen,
  LayoutDashboard,
  Network,
  Settings2,
  Database,
  Layers,
} from 'lucide-react'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { getAgent, getDefaultAgent } from '@/lib/agentRegistry'
import { loadAgentsFromServer } from '@/lib/agentRegistry'
import { ChatRegistryProvider, useChatRegistry } from '@/lib/chatRegistry'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { Suspense } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { AuthTokenDialog } from '@/components/layout/AuthTokenDialog'
import { FavoritesDialog } from '@/components/chat/FavoritesDialog'
import { Star } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { ShieldOff } from 'lucide-react'

const ChatPage = React.lazy(() => import('@/pages/ChatPage'))
const FileManagerPage = React.lazy(() => import('@/pages/FileManagerPage'))
const KnowledgeGraphPage = React.lazy(() => import('@/pages/KnowledgeGraphPage'))
const DocReaderPage = React.lazy(() => import('@/pages/DocReaderPage'))
const DashboardPage = React.lazy(() => import('@/pages/DashboardPage'))
const RegistryManagePage = React.lazy(
  () => import('@/components/management/RegistryManagePage'),
)
const ParamsManagePage = React.lazy(
  () => import('@/components/management/ParamsManagePage'),
)
const AuditManagePage = React.lazy(
  () => import('@/components/management/AuditManagePage'),
)
const ModelsManagePage = React.lazy(
  () => import('@/components/management/ModelsManagePage'),
)
const UsersManagePage = React.lazy(
  () => import('@/components/management/UsersManagePage'),
)
const RolesManagePage = React.lazy(
  () => import('@/components/management/RolesManagePage'),
)
const AgentsManagePage = React.lazy(
  () => import('@/components/management/AgentsManagePage'),
)
const VectorStructurePage = React.lazy(
  () => import('@/pages/VectorStructurePage'),
)
const VectorDataPage = React.lazy(() => import('@/pages/VectorDataPage'))
const DbStructurePage = React.lazy(() => import('@/pages/DbStructurePage'))
const DbDataPage = React.lazy(() => import('@/pages/DbDataPage'))

// 确保内置智能体注册副作用已执行（constants 会间接导入，但路由可独立使用）
import '@/lib/agentDefinitions'
import { fetchDbTables, fetchDbRows } from '@/lib/managementApi'

/** 数据库目录的加载器（模块级稳定引用，避免通用页 props 变化导致重复拉取） */
const fetchDbTablesMemory = () => fetchDbTables('memory')
const fetchDbRowsMemory = (name, opts) => fetchDbRows('memory', name, opts)
const fetchDbTablesSession = () => fetchDbTables('session')
const fetchDbRowsSession = (name, opts) => fetchDbRows('session', name, opts)
const fetchDbTablesBase = () => fetchDbTables('base')
const fetchDbRowsBase = (name, opts) => fetchDbRows('base', name, opts)
const fetchDbTablesAudit = () => fetchDbTables('audit')
const fetchDbRowsAudit = (name, opts) => fetchDbRows('audit', name, opts)

/** 路由参数 agentId 无效时回退默认智能体 */
function resolveChatAgent(agentId) {
  return getAgent(agentId) ?? getDefaultAgent()
}

/** 系统管理子视图的 Header 展示元数据（新增子视图必须同步补键，否则 Header 读 undefined.name 崩溃） */
const MGMT_HEADER_META = {
  mgmtWorkflows: {
    name: '工作流管理',
    description: '工作流启停与运行统计；禁用后对应聊天分支回退关键词路由',
  },
  mgmtTools: {
    name: '工具管理',
    description:
      '工具启停与运行统计；禁用后智能体 System Prompt 不再列出该工具',
  },
  mgmtParams: {
    name: '参数管理',
    description: '调优参数 · ES 关键词索引 · 用户令牌',
  },
  mgmtAudit: {
    name: '操作审计',
    description: '管理操作记录 · 启停开关 · 历史查询',
  },
  mgmtModels: {
    name: '模型管理',
    description: '多模型 profile · 可搜索路由绑定 · 思考模式开关',
  },
  mgmtUsers: {
    name: '成员管理',
    description: '账号增删改查 · 角色分配 · 禁用/解锁 · 密码重置',
  },
  mgmtRoles: {
    name: '角色管理',
    description: '角色与权限矩阵 · 内置角色保护 · 权限点目录',
  },
  mgmtAgents: {
    name: '智能体管理',
    description: 'Agent Spec 配置：新建/编辑/启停智能体，改动实时生效',
  },
}

/**
 * 权限路由守卫：无对应权限点时渲染 403 卡片（与后端 requirePerm 双层生效）。
 * disabled 单用户 / admin（'*'）恒放行；perm 传 PERM_CATALOG 的 key。
 */
function RequirePerm({ perm, children }) {
  const { hasPerm } = useAuth()
  const navigate = useNavigate()
  if (hasPerm(perm)) return children
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-8 text-center shadow-soft">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <ShieldOff className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">无权访问该页面</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          当前账号缺少权限「{perm}」，请联系管理员在「系统管理 → 角色管理」中为所属角色勾选开通。
        </p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-1 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
        >
          返回对话
        </button>
      </div>
    </div>
  )
}

function RouteLoadingFallback() {
  return (
    <div
      className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      role="status"
    >
      加载中…
    </div>
  )
}

/**
 * AppShell —— 应用外壳（React Router 路由 + 侧边栏 + Header）
 *
 * 路由：
 *   /chat/:agentId                 聊天智能体（插件化注册）
 *   /dashboard                     知识库仪表盘
 *   /knowledge                     文档管理
 *   /knowledge/graph               知识网络（切片网络图 + LLM Wiki 词条）
 *   /management/workflows|tools|params|audit|models   系统管理子菜单
 *   /vector-structure|/vector-data 向量库只读浏览
 *   /memory-structure|/memory-data 记忆库只读浏览（Milvus kb_memory + SQLite session_memory）
 *   /session-structure|/session-data 会话库只读浏览（SQLite sessions_clean.db）
 *   /audit                         旧入口 → 重定向操作审计子菜单
 *
 * 新增智能体只需 registerAgent()；ChatRoute 会自动匹配 /chat/:agentId。
 *
 * M4 并行（ADR-008）：聊天区渲染 ChatRegistry 中所有已打开的窗格（每智能体一个
 * 常驻 ChatPage 实例），URL /chat/:agentId 只决定哪个窗格可见 —— 切换不打断其他
 * 窗格进行中的流式对话。
 */
export function AppShell() {
  return (
    <ChatRegistryProvider>
      <AppShellInner />
    </ChatRegistryProvider>
  )
}

function AppShellInner() {
  const navigate = useNavigate()
  const location = useLocation()
  const registry = useChatRegistry()
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false)
  const [favoritesOpen, setFavoritesOpen] = React.useState(false)
  const [viewLoading, setViewLoading] = React.useState(false)
  // 桌面侧边栏折叠态（图标栏模式），localStorage 持久化
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem('ui:sidebar-collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleSidebarCollapsed = React.useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('ui:sidebar-collapsed', next ? '1' : '0')
      } catch {
        /* 隐私模式等场景下静默忽略 */
      }
      return next
    })
  }, [])

  const currentAgent = React.useMemo(() => {
    const match = location.pathname.match(/^\/chat\/([^/]+)/)
    return resolveChatAgent(match?.[1])
  }, [location.pathname])

  const activeView = location.pathname.startsWith('/dashboard')
    ? 'dashboard'
    : location.pathname.startsWith('/knowledge/graph')
      ? 'knowledgeGraph'
      : location.pathname.startsWith('/knowledge')
        ? 'knowledge'
        : location.pathname.startsWith('/management/workflows')
        ? 'mgmtWorkflows'
        : location.pathname.startsWith('/management/tools')
          ? 'mgmtTools'
          : location.pathname.startsWith('/management/params')
            ? 'mgmtParams'
            : location.pathname.startsWith('/management/audit')
              ? 'mgmtAudit'
              : location.pathname.startsWith('/management/models')
                ? 'mgmtModels'
                : location.pathname.startsWith('/management/users')
                  ? 'mgmtUsers'
                  : location.pathname.startsWith('/management/roles')
                    ? 'mgmtRoles'
                    : location.pathname.startsWith('/management/agents')
                      ? 'mgmtAgents'
                      : location.pathname.startsWith('/vector-structure')
                  ? 'vectorStructure'
                  : location.pathname.startsWith('/vector-data')
                    ? 'vectorData'
                    : location.pathname.startsWith('/memory-structure')
                      ? 'memoryStructure'
                      : location.pathname.startsWith('/memory-data')
                        ? 'memoryData'
                        : location.pathname.startsWith('/session-structure')
                          ? 'sessionStructure'
                          : location.pathname.startsWith('/session-data')
                            ? 'sessionData'
                            : location.pathname.startsWith('/base-structure')
                              ? 'baseStructure'
                              : location.pathname.startsWith('/base-data')
                                ? 'baseData'
                                : location.pathname.startsWith('/audit-structure')
                                  ? 'auditStructure'
                                  : location.pathname.startsWith('/audit-data')
                                    ? 'auditData'
                                    : 'chat'

  const handleSelectAgent = React.useCallback(
    (agent) => {
      if (!agent?.available) return
      navigate(`/chat/${agent.id}`)
      setMobileSidebarOpen(false)
    },
    [navigate],
  )

  // P1：智能体注册表服务端同步——挂载拉取；管理页保存后广播 agents:changed 重拉
  React.useEffect(() => {
    loadAgentsFromServer()
    const onChanged = () => {
      loadAgentsFromServer()
    }
    window.addEventListener('agents:changed', onChanged)
    return () => window.removeEventListener('agents:changed', onChanged)
  }, [])

  const handleNavigateView = React.useCallback(
    (view) => {
      const routes = {
        dashboard: '/dashboard',
        knowledge: '/knowledge',
        knowledgeGraph: '/knowledge/graph',
        mgmtWorkflows: '/management/workflows',
        mgmtTools: '/management/tools',
        mgmtParams: '/management/params',
        mgmtAudit: '/management/audit',
        mgmtModels: '/management/models',
        mgmtUsers: '/management/users',
        mgmtRoles: '/management/roles',
        mgmtAgents: '/management/agents',
        vectorStructure: '/vector-structure',
        vectorData: '/vector-data',
        memoryStructure: '/memory-structure',
        memoryData: '/memory-data',
        sessionStructure: '/session-structure',
        sessionData: '/session-data',
        baseStructure: '/base-structure',
        baseData: '/base-data',
        auditStructure: '/audit-structure',
        auditData: '/audit-data',
        audit: '/management/audit',
        chat: `/chat/${currentAgent.id}`,
      }
      navigate(routes[view] ?? '/dashboard')
      setMobileSidebarOpen(false)
    },
    [navigate, currentAgent.id],
  )

  // 非聊天视图使用虚拟 agent 描述，仅用于 Header 展示
  const headerAgent =
    activeView === 'dashboard'
      ? {
          id: '__dashboard__',
          name: '仪表盘',
          description: '知识库总览：文档数 / 切片数 / 分类分布',
          icon: LayoutDashboard,
          available: true,
        }
      : activeView === 'knowledge'
          ? {
              id: '__knowledge_admin__',
              name: '文档管理',
              description: '知识库文档录入、分类/标签、检索与批量管理',
              icon: BookOpen,
              available: true,
            }
          : activeView === 'knowledgeGraph'
            ? {
                id: '__knowledge_graph__',
                name: '知识网络',
                description:
                  '切片语义网络 + LLM Wiki 词条：文档筛选、关键词定位、词条生成与详情',
                icon: Network,
                available: true,
              }
        : activeView.startsWith('mgmt')
          ? (() => {
              const meta = MGMT_HEADER_META[activeView] ?? { name: '系统管理', description: '' }
              return {
                id: '__management__',
                name: meta.name,
                description: meta.description,
                icon: Settings2,
                available: true,
              }
            })()
          : activeView === 'vectorStructure'
            ? {
                id: '__vector_structure__',
                name: '数据结构',
                description: 'Milvus 集合结构与索引的只读浏览',
                icon: Database,
                available: true,
              }
            : activeView === 'vectorData'
              ? {
                  id: '__vector_data__',
                  name: '数据明细',
                  description: '文档切片与双向量明细的只读浏览',
                  icon: Layers,
                  available: true,
                }
              : activeView === 'memoryStructure'
                ? {
                    id: '__memory_structure__',
                    name: '记忆库 · 数据结构',
                    description: '长期记忆事实（Milvus）与会话摘要（SQLite）的表结构',
                    icon: Database,
                    available: true,
                  }
                : activeView === 'memoryData'
                  ? {
                      id: '__memory_data__',
                      name: '记忆库 · 数据明细',
                      description: '长期记忆事实与会话滚动摘要的行级浏览',
                      icon: Database,
                      available: true,
                    }
                  : activeView === 'sessionStructure'
                    ? {
                        id: '__session_structure__',
                        name: '会话库 · 数据结构',
                        description: '会话 / 消息 / 注解 / 反思记录等 SQLite 表结构',
                        icon: Database,
                        available: true,
                      }
                    : activeView === 'sessionData'
                      ? {
                          id: '__session_data__',
                          name: '会话库 · 数据明细',
                          description: '会话库各表行级浏览（按 rowid 排序）',
                          icon: Database,
                          available: true,
                        }
                      : activeView === 'baseStructure'
                        ? {
                            id: '__base_structure__',
                            name: '基础库 · 数据结构',
                            description: '与 RAG 无关的基础表结构（用户账号等 SQLite）',
                            icon: Database,
                            available: true,
                          }
                        : activeView === 'baseData'
                          ? {
                              id: '__base_data__',
                              name: '基础库 · 数据明细',
                              description: '用户账号等基础表行级浏览（敏感列已掩码）',
                              icon: Database,
                              available: true,
                            }
                          : activeView === 'auditStructure'
                            ? {
                                id: '__audit_structure__',
                                name: '审计库 · 数据结构',
                                description: '审计数据库表结构（audit.db · 管理操作记录）',
                                icon: Database,
                                available: true,
                              }
                            : activeView === 'auditData'
                              ? {
                                  id: '__audit_data__',
                                  name: '审计库 · 数据明细',
                                  description: '审计日志行级浏览（最新在前）',
                                  icon: Database,
                                  available: true,
                                }
                              : currentAgent

  // 聊天视图：焦点窗格忙（流式/加载历史）→ Header 思考态
  const chatBusy = React.useMemo(() => {
    if (activeView !== 'chat') return false
    return registry.chats.some((c) => c.agentId === currentAgent.id && c.busy)
  }, [activeView, registry.chats, currentAgent.id])
  React.useEffect(() => {
    setViewLoading(chatBusy)
  }, [chatBusy])

  return (
    <div className="flex h-dvh w-full overflow-hidden border border-border bg-background">
      {/* 桌面端侧边栏（可折叠为图标栏） */}
      <aside
        className={cn(
          'hidden shrink-0 border-r transition-[width] duration-200 ease-out md:block',
          sidebarCollapsed ? 'w-[3.75rem]' : 'w-64',
        )}
      >
        <Sidebar
          currentAgentId={currentAgent.id}
          activeView={activeView}
          chatStates={registry.chats}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapsed}
          onSelectAgent={handleSelectAgent}
          onNavigateView={handleNavigateView}
        />
      </aside>

      {/* 移动端抽屉侧边栏（始终展开形态） */}
      <Dialog open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <DialogContent className="left-0 top-0 h-dvh w-72 max-w-[80vw] translate-x-0 translate-y-0 rounded-none rounded-r-2xl p-0">
          <DialogTitle className="sr-only">导航</DialogTitle>
          <Sidebar
            currentAgentId={currentAgent.id}
            activeView={activeView}
            chatStates={registry.chats}
            onSelectAgent={handleSelectAgent}
            onNavigateView={handleNavigateView}
            onNavigate={() => setMobileSidebarOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* 主区域（app-canvas：顶部极淡靛蓝晕染，营造纵深） */}
      <main className="app-canvas flex h-dvh min-w-0 flex-1 flex-col">
        <Header
          agent={headerAgent}
          status={viewLoading ? 'thinking' : 'online'}
          onOpenSidebar={() => setMobileSidebarOpen(true)}
          onOpenFavorites={() => setFavoritesOpen(true)}
        />
        <AuthTokenDialog />
        <FavoritesDialog open={favoritesOpen} onOpenChange={setFavoritesOpen} />
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route
              path="/"
              element={<Navigate to={`/chat/${currentAgent.id}`} replace />}
            />
            <Route
              path="/chat"
              element={<Navigate to={`/chat/${currentAgent.id}`} replace />}
            />
            <Route path="/chat/:agentId" element={<ChatRoute />} />
            <Route
              path="/dashboard"
              element={
                <RequirePerm perm="dashboard">
                  <DashboardPage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/knowledge"
              element={
                <RequirePerm perm="kb">
                  <FileManagerPage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/knowledge/graph"
              element={
                <RequirePerm perm="graph">
                  <KnowledgeGraphPage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            {/* 切片阅读器（v3）：按锚点分段渲染，路由挂在 /knowledge 下复用「文档管理」视图态 */}
            <Route
              path="/knowledge/read/:docId"
              element={
                <RequirePerm perm="kb">
                  <DocReaderPage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            {/* 系统管理子菜单：/management 兜底跳工作流管理 */}
            <Route
              path="/management"
              element={<Navigate to="/management/workflows" replace />}
            />
            <Route
              path="/management/workflows"
              element={
                <RequirePerm perm="mgmt.workflows">
                  <RegistryManagePage
                    kind="workflows"
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/management/tools"
              element={
                <RequirePerm perm="mgmt.tools">
                  <RegistryManagePage
                    kind="tools"
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/management/params"
              element={
                <RequirePerm perm="mgmt.params">
                  <ParamsManagePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/management/audit"
              element={
                <RequirePerm perm="mgmt.audit">
                  <AuditManagePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/management/models"
              element={
                <RequirePerm perm="mgmt.models">
                  <ModelsManagePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/management/users"
              element={
                <RequirePerm perm="mgmt.users">
                  <UsersManagePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/management/roles"
              element={
                <RequirePerm perm="mgmt.roles">
                  <RolesManagePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/management/agents"
              element={
                <RequirePerm perm="mgmt.agents">
                  <AgentsManagePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/vector-structure"
              element={
                <RequirePerm perm="db">
                  <VectorStructurePage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            <Route
              path="/vector-data"
              element={
                <RequirePerm perm="db">
                  <VectorDataPage onLoadingChange={setViewLoading} />
                </RequirePerm>
              }
            />
            {/* 数据库目录：记忆库 / 会话库（通用只读浏览页） */}
            <Route
              path="/memory-structure"
              element={
                <RequirePerm perm="db">
                  <DbStructurePage
                    title="记忆库 · 数据结构"
                    description="长期记忆事实（Milvus kb_memory）与会话摘要（SQLite session_memory）的表结构"
                    load={fetchDbTablesMemory}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/memory-data"
              element={
                <RequirePerm perm="db">
                  <DbDataPage
                    title="记忆库 · 数据明细"
                    description="长期记忆事实与会话滚动摘要的行级浏览（只读）"
                    load={fetchDbTablesMemory}
                    loadRows={fetchDbRowsMemory}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/session-structure"
              element={
                <RequirePerm perm="db">
                  <DbStructurePage
                    title="会话库 · 数据结构"
                    description="会话库（SQLite）各表的字段结构与行数"
                    load={fetchDbTablesSession}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/session-data"
              element={
                <RequirePerm perm="db">
                  <DbDataPage
                    title="会话库 · 数据明细"
                    description="会话库各表行级浏览（按 rowid 排序，只读）"
                    load={fetchDbTablesSession}
                    loadRows={fetchDbRowsSession}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            {/* 数据库目录：基础库（与 RAG 无关的 SQLite 表：用户账号等，敏感列掩码） */}
            <Route
              path="/base-structure"
              element={
                <RequirePerm perm="db">
                  <DbStructurePage
                    title="基础库 · 数据结构"
                    description="基础库（SQLite accounts.db）的表结构与行数：用户账号等"
                    load={fetchDbTablesBase}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/base-data"
              element={
                <RequirePerm perm="db">
                  <DbDataPage
                    title="基础库 · 数据明细"
                    description="基础库各表行级浏览（按 rowid 排序，只读；敏感列以掩码显示）"
                    load={fetchDbTablesBase}
                    loadRows={fetchDbRowsBase}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            {/* 数据库目录：审计库（audit.db 只读浏览） */}
            <Route
              path="/audit-structure"
              element={
                <RequirePerm perm="db">
                  <DbStructurePage
                    title="审计库 · 数据结构"
                    description="审计数据库（SQLite audit.db）的表结构：管理操作记录"
                    load={fetchDbTablesAudit}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            <Route
              path="/audit-data"
              element={
                <RequirePerm perm="db">
                  <DbDataPage
                    title="审计库 · 数据明细"
                    description="审计日志行级浏览（最新在前，只读）"
                    load={fetchDbTablesAudit}
                    loadRows={fetchDbRowsAudit}
                    onLoadingChange={setViewLoading}
                  />
                </RequirePerm>
              }
            />
            {/* 旧入口兼容：/audit → 操作审计子菜单 */}
            <Route
              path="/audit"
              element={<Navigate to="/management/audit" replace />}
            />
            <Route
              path="*"
              element={<Navigate to={`/chat/${currentAgent.id}`} replace />}
            />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}

/** 路由级聊天区：校验 agentId 并渲染并行窗格宿主 */
function ChatRoute() {
  const { agentId } = useParams()
  const navigate = useNavigate()
  const agent = resolveChatAgent(agentId)

  React.useEffect(() => {
    if (!getAgent(agentId)) {
      navigate(`/chat/${agent.id}`, { replace: true })
    }
  }, [agentId, agent.id, navigate])

  return <ChatPaneHost focusedAgentId={agent.id} />
}

/**
 * ChatPaneHost —— 并行聊天窗格宿主（M4 / ADR-008）
 *
 * registry 中每个已打开的智能体渲染一个常驻 ChatPage 实例：
 *   - 焦点窗格（URL 指向）用 display:contents 融入布局
 *   - 后台窗格 display:none 隐藏但保持挂载 → useChat/流式继续
 */
function ChatPaneHost({ focusedAgentId }) {
  const registry = useChatRegistry()
  const { chats, openChat, markUnread, setBusy } = registry

  // URL 指向的智能体必须已在 registry 中打开（首次进入/刷新兜底）
  React.useEffect(() => {
    openChat(focusedAgentId)
  }, [focusedAgentId, openChat])

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {chats.map((c) => (
        <div
          key={c.agentId}
          className={c.agentId === focusedAgentId ? 'contents' : 'hidden'}
        >
          <ChatPage
            agent={resolveChatAgent(c.agentId)}
            focused={c.agentId === focusedAgentId}
            onBusyChange={setBusy}
            onStreamSettled={markUnread}
          />
        </div>
      ))}
    </div>
  )
}

export default AppShell
