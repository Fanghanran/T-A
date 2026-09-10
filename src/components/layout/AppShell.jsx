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
import { ChatRegistryProvider, useChatRegistry } from '@/lib/chatRegistry'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { Suspense } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { AuthTokenDialog } from '@/components/layout/AuthTokenDialog'

const ChatPage = React.lazy(() => import('@/pages/ChatPage'))
const KnowledgeBasePage = React.lazy(() => import('@/pages/KnowledgeBasePage'))
const KnowledgeGraphPage = React.lazy(() => import('@/pages/KnowledgeGraphPage'))
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
const VectorStructurePage = React.lazy(
  () => import('@/pages/VectorStructurePage'),
)
const VectorDataPage = React.lazy(() => import('@/pages/VectorDataPage'))

// 确保内置智能体注册副作用已执行（constants 会间接导入，但路由可独立使用）
import '@/lib/agentDefinitions'

/** 路由参数 agentId 无效时回退默认智能体 */
function resolveChatAgent(agentId) {
  return getAgent(agentId) ?? getDefaultAgent()
}

/** 系统管理五个子视图的 Header 展示元数据 */
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
                : location.pathname.startsWith('/vector-structure')
                  ? 'vectorStructure'
                  : location.pathname.startsWith('/vector-data')
                    ? 'vectorData'
                    : 'chat'

  const handleSelectAgent = React.useCallback(
    (agent) => {
      if (!agent?.available) return
      navigate(`/chat/${agent.id}`)
      setMobileSidebarOpen(false)
    },
    [navigate],
  )

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
        vectorStructure: '/vector-structure',
        vectorData: '/vector-data',
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
          ? {
              id: '__management__',
              name: MGMT_HEADER_META[activeView].name,
              description: MGMT_HEADER_META[activeView].description,
              icon: Settings2,
              available: true,
            }
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
    <div className="flex h-dvh w-full overflow-hidden bg-background">
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
        />
        <AuthTokenDialog />
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
              element={<DashboardPage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/knowledge"
              element={<KnowledgeBasePage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/knowledge/graph"
              element={<KnowledgeGraphPage onLoadingChange={setViewLoading} />}
            />
            {/* 系统管理子菜单：/management 兜底跳工作流管理 */}
            <Route
              path="/management"
              element={<Navigate to="/management/workflows" replace />}
            />
            <Route
              path="/management/workflows"
              element={
                <RegistryManagePage
                  kind="workflows"
                  onLoadingChange={setViewLoading}
                />
              }
            />
            <Route
              path="/management/tools"
              element={
                <RegistryManagePage
                  kind="tools"
                  onLoadingChange={setViewLoading}
                />
              }
            />
            <Route
              path="/management/params"
              element={<ParamsManagePage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/management/audit"
              element={<AuditManagePage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/management/models"
              element={<ModelsManagePage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/vector-structure"
              element={<VectorStructurePage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/vector-data"
              element={<VectorDataPage onLoadingChange={setViewLoading} />}
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
