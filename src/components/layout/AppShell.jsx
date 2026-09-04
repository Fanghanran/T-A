import * as React from 'react'
import { BookOpen, LayoutDashboard, Settings2, History } from 'lucide-react'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { getAgent, getDefaultAgent, listAgents } from '@/lib/agentRegistry'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { Suspense } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

const ChatPage = React.lazy(() => import('@/pages/ChatPage'))
const KnowledgeBasePage = React.lazy(() => import('@/pages/KnowledgeBasePage'))
const DashboardPage = React.lazy(() => import('@/pages/DashboardPage'))
const ManagementPage = React.lazy(() => import('@/pages/ManagementPage'))
const AuditPage = React.lazy(() => import('@/pages/AuditPage'))

// 确保内置智能体注册副作用已执行（constants 会间接导入，但路由可独立使用）
import '@/lib/agentDefinitions'

/** 路由参数 agentId 无效时回退默认智能体 */
function resolveChatAgent(agentId) {
  return getAgent(agentId) ?? getDefaultAgent()
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
 *   /chat/:agentId  聊天智能体（插件化注册）
 *   /dashboard      知识库仪表盘
 *   /knowledge      文档管理
 *   /management     系统管理
 *   /audit          操作审计
 *
 * 新增智能体只需 registerAgent()；ChatRoute 会自动匹配 /chat/:agentId。
 */
export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const [techStack, setTechStack] = React.useState([])
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false)
  const [viewLoading, setViewLoading] = React.useState(false)

  const currentAgent = React.useMemo(() => {
    const match = location.pathname.match(/^\/chat\/([^/]+)/)
    return resolveChatAgent(match?.[1])
  }, [location.pathname])

  const activeView = location.pathname.startsWith('/dashboard')
    ? 'dashboard'
    : location.pathname.startsWith('/knowledge')
      ? 'knowledge'
      : location.pathname.startsWith('/management')
        ? 'management'
        : location.pathname.startsWith('/audit')
          ? 'audit'
          : 'chat'

  const handleSelectAgent = React.useCallback(
    (agent) => {
      if (!agent?.available) return
      navigate(`/chat/${agent.id}`)
      setTechStack([])
      setViewLoading(false)
      setMobileSidebarOpen(false)
    },
    [navigate],
  )

  const handleNavigateView = React.useCallback(
    (view) => {
      const routes = {
        dashboard: '/dashboard',
        knowledge: '/knowledge',
        management: '/management',
        audit: '/audit',
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
        : activeView === 'management'
          ? {
              id: '__management__',
              name: '系统管理',
              description: '智能体工具与工作流的注册、启停管理',
              icon: Settings2,
              available: true,
            }
          : activeView === 'audit'
            ? {
                id: '__audit__',
                name: '操作审计',
                description: '启停 / 调优参数修改 / 恢复默认的历史记录',
                icon: History,
                available: true,
              }
            : currentAgent

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      {/* 桌面端侧边栏 */}
      <aside className="hidden w-64 shrink-0 border-r md:block">
        <Sidebar
          currentAgentId={currentAgent.id}
          activeView={activeView}
          onSelectAgent={handleSelectAgent}
          onNavigateView={handleNavigateView}
        />
      </aside>

      {/* 移动端抽屉侧边栏 */}
      <Dialog open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <DialogContent className="left-0 top-0 h-dvh w-72 max-w-[80vw] translate-x-0 translate-y-0 rounded-none rounded-r-2xl p-0">
          <DialogTitle className="sr-only">导航</DialogTitle>
          <Sidebar
            currentAgentId={currentAgent.id}
            activeView={activeView}
            onSelectAgent={handleSelectAgent}
            onNavigateView={handleNavigateView}
            onNavigate={() => setMobileSidebarOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* 主区域 */}
      <main className="flex h-dvh min-w-0 flex-1 flex-col">
        <Header
          agent={headerAgent}
          status={viewLoading ? 'thinking' : 'online'}
          onOpenSidebar={() => setMobileSidebarOpen(true)}
        />
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
            <Route
              path="/chat/:agentId"
              element={
                <ChatRoute
                  techStack={techStack}
                  onTechStackChange={setTechStack}
                  onLoadingChange={setViewLoading}
                />
              }
            />
            <Route
              path="/dashboard"
              element={<DashboardPage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/knowledge"
              element={<KnowledgeBasePage onLoadingChange={setViewLoading} />}
            />
            <Route
              path="/management"
              element={<ManagementPage onLoadingChange={setViewLoading} />}
            />
            <Route path="/audit" element={<AuditPage />} />
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

/** 路由级 ChatPage：从 URL 参数解析已注册智能体 */
function ChatRoute({ techStack, onTechStackChange, onLoadingChange }) {
  const { agentId } = useParams()
  const navigate = useNavigate()
  const agent = resolveChatAgent(agentId)

  React.useEffect(() => {
    if (!getAgent(agentId)) {
      navigate(`/chat/${agent.id}`, { replace: true })
    }
  }, [agentId, agent.id, navigate])

  return (
    <ChatPage
      agent={agent}
      techStack={techStack}
      onTechStackChange={onTechStackChange}
      onLoadingChange={onLoadingChange}
    />
  )
}

export default AppShell
