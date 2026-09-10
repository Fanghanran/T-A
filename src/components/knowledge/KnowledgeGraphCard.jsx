import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Network,
  RefreshCw,
  Loader2,
  Search,
  AlertCircle,
  Orbit,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { fetchVectorGraph } from '@/lib/managementApi'
import {
  FETCH_THRESHOLD,
  SLIDER_MIN,
  SLIDER_MAX,
  DEFAULT_THRESHOLD,
  FORCE_LIMIT,
  deriveGraphView,
} from '@/lib/knowledgeGraphShared'
import KnowledgeGraph2D from './KnowledgeGraph2D'

/** 3D 视图懒加载（three.js 依赖较大，仅在 3D 模式下按需加载，不进首屏） */
const KnowledgeGraph3D = React.lazy(() => import('./KnowledgeGraph3D'))

/**
 * KnowledgeGraphCard —— 知识库网络图（仪表盘内嵌卡片）
 *
 * 节点 = 知识切片（按文档着色，大小 = 关联度数），边 = text_vector 余弦
 * 相似度。数据一次拉取服务端低阈值（0.5）全量边，前端阈值滑杆在本地
 * 调高过滤（更强边必在低阈值 top-K 邻居内，语义与服务端直接裁边等价）。
 * 卡片固定不带 wiki 词条节点（includeWiki=false，独立页面「知识网络」
 * 才展示 LLM 词条），保持仪表盘嵌入形态的简洁与行为不变。
 *
 * 视图派生与 2D/3D 渲染共享自 knowledgeGraphShared / KnowledgeGraph2D /
 * KnowledgeGraph3D（与独立页 KnowledgeGraphPage 同口径）。
 *
 * 交互：
 *  - 视图切换：3D 立体（默认，Three.js 力导向星系）/ 2D 平面（ECharts），选择持久化
 *  - 检索框：按标题/主题/摘要/文档名匹配节点，Enter 定位首个匹配
 *    （2D 弹 tooltip；3D 相机聚焦）
 *  - 阈值滑杆：本地过滤边密度，孤立节点自动淡化
 *  - 点击节点：跳转「数据明细」并定位到该文档与切片
 *  - 图例：按文档显示/隐藏子图；2D 滚轮缩放/拖拽平移，3D 拖拽旋转/滚轮缩放
 *
 * 数据来源：GET /api/management/vector/graph（只读，5 分钟服务端缓存）。
 *
 * @param {Object} props
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向页面级上报忙碌状态
 */
export function KnowledgeGraphCard({ onLoadingChange }) {
  const navigate = useNavigate()
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [keyword, setKeyword] = React.useState('')
  const [threshold, setThreshold] = React.useState(DEFAULT_THRESHOLD)
  /** 视图模式：3D（默认，Three.js 力导向）/ 2D（ECharts），选择持久化到 localStorage */
  const [mode, setMode] = React.useState(() =>
    window.localStorage.getItem('ui:knowledge-graph-mode') === '2d' ? '2d' : '3d',
  )
  /** Enter 定位信号（3D 模式下驱动相机聚焦首个匹配节点） */
  const [focusSignal, setFocusSignal] = React.useState(0)
  const chartRef = React.useRef(null)

  /** 切换视图模式并持久化 */
  const switchMode = (m) => {
    setMode(m)
    window.localStorage.setItem('ui:knowledge-graph-mode', m)
  }

  /** 拉取网络图数据（固定低阈值 + topK，命中服务端缓存；卡片不含 wiki 节点） */
  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(
        await fetchVectorGraph({
          threshold: FETCH_THRESHOLD,
          topK: 6,
          includeWiki: false,
        }),
      )
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  /** 派生视图（共享口径）：阈值过滤边 → 重算度数 → 关键词匹配集 */
  const view = React.useMemo(
    () => deriveGraphView(data, { threshold, keyword }),
    [data, threshold, keyword],
  )

  /** 点击节点：跳转数据明细（URL 参数定位文档 + 切片） */
  const handleNodeClick = React.useCallback(
    (n) => {
      navigate(
        `/vector-data?docId=${encodeURIComponent(n.docId)}&chunkId=${encodeURIComponent(n.id)}`,
      )
    },
    [navigate],
  )

  /** Enter 定位首个匹配节点（2D 弹 tooltip；3D 相机聚焦） */
  const locateFirstMatch = () => {
    if (!view?.kw || view.matched.size === 0) return
    if (mode === '3d') {
      setFocusSignal((s) => s + 1)
      return
    }
    if (!chartRef.current) return
    const idx = view.nodes.findIndex((n) => view.matched.has(n.id))
    if (idx >= 0) {
      chartRef.current.dispatchAction({
        type: 'showTip',
        seriesIndex: 0,
        dataIndex: idx,
      })
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        {/* 头部：标题 + 统计 + 检索 / 阈值 / 刷新 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Network className="h-4 w-4 text-muted-foreground" />
            知识网络图
          </div>
          {view && (
            <span className="text-xs text-muted-foreground">
              {view.nodes.length} 节点 · {view.edges.length} 边 · 按文档着色
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* 视图模式切换：3D 立体 / 2D 平面（持久化） */}
            <div
              className="flex items-center rounded-md border border-border bg-background p-0.5"
              role="group"
              aria-label="视图模式切换"
            >
              <button
                type="button"
                onClick={() => switchMode('3d')}
                className={`flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium transition-colors ${
                  mode === '3d'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title="3D 立体视图（Three.js 力导向）"
              >
                <Orbit className="h-3.5 w-3.5" />
                3D
              </button>
              <button
                type="button"
                onClick={() => switchMode('2d')}
                className={`flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium transition-colors ${
                  mode === '2d'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title="2D 平面视图（ECharts 力导向）"
              >
                <Network className="h-3.5 w-3.5" />
                2D
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && locateFirstMatch()}
                placeholder="检索节点…"
                className="h-8 w-40 pl-8 text-xs"
                aria-label="检索网络图节点"
              />
            </div>
            {view?.kw && (
              <span className="w-14 text-[11px] tabular-nums text-muted-foreground">
                {view.matched.size} 个匹配
              </span>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              阈值
              <input
                type="range"
                min={SLIDER_MIN}
                max={SLIDER_MAX}
                step={0.05}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="h-1.5 w-24 cursor-pointer accent-primary"
                aria-label="相似度阈值"
              />
              <span className="w-8 tabular-nums font-medium text-foreground">
                {threshold.toFixed(2)}
              </span>
            </label>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={load}
              disabled={loading}
              title="刷新网络图"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        {/* 画布：按视图模式渲染 2D ECharts / 3D 力导向星系 + 覆盖态 */}
        <div className="relative h-[380px] w-full overflow-hidden rounded-md border border-border/60 bg-muted/10 md:h-[460px]">
          {mode === '2d' && view && (
            <KnowledgeGraph2D
              view={view}
              docs={data?.docs ?? []}
              threshold={threshold}
              chartRef={chartRef}
              onNodeClick={handleNodeClick}
            />
          )}
          {mode === '3d' && (
            <React.Suspense
              fallback={
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在加载 3D 视图…
                </div>
              }
            >
              <KnowledgeGraph3D
                view={view}
                docs={data?.docs ?? []}
                threshold={threshold}
                focusSignal={focusSignal}
                onNodeClick={handleNodeClick}
              />
            </React.Suspense>
          )}
          {loading && !data && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在计算切片相似网络…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-sm text-destructive">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </span>
            </div>
          )}
          {!loading && !error && data && view?.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              向量库暂无切片
            </div>
          )}
        </div>

        <p className="mt-2 text-[11px] text-muted-foreground">
          {mode === '2d' && view && view.nodes.length > FORCE_LIMIT
            ? '大图模式（分组预布局 · 渐进渲染） · '
            : ''}
          {mode === '3d'
            ? '拖拽旋转视角 · 滚轮缩放 · 节点拖拽 · '
            : '滚轮缩放 / 拖拽平移 · '}
          点击节点跳转数据明细 · 节点大小 = 关联数 · 边粗细 = 相似度
        </p>
      </CardContent>
    </Card>
  )
}

export default KnowledgeGraphCard
