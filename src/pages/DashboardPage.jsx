import * as React from 'react'
import { RefreshCw, Loader2, LayoutDashboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDocumentStats } from '@/hooks/useDocumentStats'
import { KbStatsPanel } from '@/components/knowledge/KbStatsPanel'

/**
 * DashboardPage —— 仪表盘（独立菜单视图）
 *
 * 只加载知识库统计数据，不触发文档列表、筛选或 facet 请求。
 *
 * 数据来源：/api/health → { documents, chunks, knowledgeByCategory }
 *
 * @param {Object} props
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */
export function DashboardPage({ onLoadingChange }) {
  const statsState = useDocumentStats()
  const [refreshing, setRefreshing] = React.useState(false)

  // 进入页面强制刷一次统计（即便 hook 已预取，确保数据新鲜）
  React.useEffect(() => {
    statsState.loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    onLoadingChange?.(statsState.statsLoading || refreshing)
  }, [statsState.statsLoading, refreshing, onLoadingChange])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await statsState.loadStats()
    } finally {
      setRefreshing(false)
    }
  }

  const loading =
    statsState.statsLoading || refreshing || !statsState.stats?.loaded

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：标题 + 更新时间 + 刷新按钮 */}
      <div className="flex items-center gap-2 border-b px-4 py-3 md:px-6">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold tracking-tight">仪表盘</h2>
        <span className="text-[11px] text-muted-foreground">
          知识库与系统总览
          {statsState.stats?.updatedAt && !loading
            ? ` · 更新于 ${new Date(statsState.stats.updatedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}`
            : ''}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-8 gap-1.5"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {/* 主体：统计面板（居中限宽，避免宽屏拉伸条形图过窄难比较） */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          <KbStatsPanel stats={statsState.stats} loading={loading} />
        </div>
      </div>
    </div>
  )
}

export default DashboardPage
