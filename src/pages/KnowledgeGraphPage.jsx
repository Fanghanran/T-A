import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Network,
  Orbit,
  RefreshCw,
  Loader2,
  Search,
  AlertCircle,
  ChevronsRight,
  X,
  BookMarked,
  FilePlus2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  fetchVectorGraph,
  fetchWikiJob,
  fetchWikiStatus,
  clearWiki,
} from '@/lib/managementApi'
import {
  FETCH_THRESHOLD,
  SLIDER_MIN,
  SLIDER_MAX,
  DEFAULT_THRESHOLD,
  deriveGraphView,
} from '@/lib/knowledgeGraphShared'
import KnowledgeGraph2D from '@/components/knowledge/KnowledgeGraph2D'
import ConfirmDialog from '@/components/ui/ConfirmDialog'

/** 3D 视图懒加载（three.js 依赖较大，仅在 3D 模式下按需加载，不进首屏） */
const KnowledgeGraph3D = React.lazy(() =>
  import('@/components/knowledge/KnowledgeGraph3D'),
)

/** 生成阶段中文标签 */

/**
 * KnowledgeGraphPage —— 知识网络独立页（知识库子菜单 /knowledge/graph）
 *
 * 与仪表盘内嵌卡片（KnowledgeGraphCard）共享同一套视图派生与渲染组件
 * （knowledgeGraphShared / KnowledgeGraph2D / KnowledgeGraph3D），本页在其
 * 基础上扩展完整工作台形态：
 *  - 左栏顶部：检索条件（关键词定位 / 相似度阈值 / 是否含 Wiki 词条节点）
 *  - 左栏中部：文档复选列表（按文档筛选子图，含各文档切片计数）
 *  - 左栏底部：LLM Wiki 词条生成（手动触发后台任务 + 进度轮询 + 取消/清空）
 *  - 右侧：纯网络图画布（2D ECharts / 3D 力导向切换，均持久化偏好）
 *
 * wiki 词条节点（琥珀色）点击弹出词条详情浮层（名称/别名/摘要/提及上下文）；
 * 切片节点点击跳转「数据明细」定位到该切片（与卡片行为一致）。
 *
 * 生成任务轮询：页面刷新后经 fetchWikiStatus 恢复（任务记录保留 10 分钟），
 * 完成后自动重拉网络图（词条节点与提及边实时叠加，无需等待切片图缓存过期）。
 */
export function KnowledgeGraphPage({ onLoadingChange }) {
  const navigate = useNavigate()
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [keyword, setKeyword] = React.useState('')
  const [threshold, setThreshold] = React.useState(DEFAULT_THRESHOLD)
  /** 视图模式：3D（默认）/ 2D，与仪表盘卡片共享同一持久化偏好 */
  const [mode, setMode] = React.useState(() =>
    window.localStorage.getItem('ui:knowledge-graph-mode') === '2d' ? '2d' : '3d',
  )
  /** Enter 定位信号（3D 模式下驱动相机聚焦首个匹配节点） */
  const [focusSignal, setFocusSignal] = React.useState(0)
  const chartRef = React.useRef(null)

  /** 左栏折叠态（与数据页同款交互），localStorage 持久化 */
  const [navCollapsed, setNavCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem('ui:knowledge-graph-nav-collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleNavCollapsed = React.useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('ui:knowledge-graph-nav-collapsed', next ? '1' : '0')
      } catch {
        /* 隐私模式等场景下静默忽略 */
      }
      return next
    })
  }, [])

  /** 文档筛选：null = 全部文档；否则只显示集合内文档的切片节点 */
  const [selectedDocIds, setSelectedDocIds] = React.useState(null)
  /** 是否包含 LLM Wiki 词条节点（默认含） */
  /** 词条详情浮层（点击 wiki 节点打开；携带图节点全量字段） */
  const [selectedWiki, setSelectedWiki] = React.useState(null)

  /* ---------- LLM Wiki 生成任务状态 ---------- */
  const [, setJob] = React.useState(null)
  const [clearOpen, setClearOpen] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)
  /** 轮询定时器（ref 持有便于卸载清理与防重入） */
  const pollRef = React.useRef(null)

  /** 拉取网络图数据（固定低阈值 + topK 命中服务端缓存；含 wiki 词条节点） */
  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(
        await fetchVectorGraph({
          threshold: FETCH_THRESHOLD,
          topK: 6,
          includeWiki: true,
        }),
      )
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /** 拉取 Wiki 统计（词条数/已摘要/已抽取切片） */
  const refreshWikiStats = React.useCallback(async () => {
    try {
      const r = await fetchWikiStatus()
      setWikiStats(r?.stats ?? null)
      return r
    } catch {
      return null
    }
  }, [])

  /** 停止轮询（幂等） */
  const stopPolling = React.useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  /** 任务终态统一处理：刷新统计 + 重拉网络图（词条节点实时生效） */
  const settleJob = React.useCallback(
    (finished) => {
      setJob(finished)
      refreshWikiStats()
      load()
    },
    [refreshWikiStats, load],
  )

  /** 启动 / 恢复任务轮询（1.5s 间隔，终态停止并结算） */
  const startPolling = React.useCallback(
    (jobId) => {
      stopPolling()
      pollRef.current = setInterval(async () => {
        try {
          const j = await fetchWikiJob(jobId)
          setJobError('')
          if (j.status !== 'running') {
            stopPolling()
            settleJob(j)
          } else {
            setJob(j)
          }
        } catch (err) {
          // 任务 404（后端重启超出保留窗口）或网络抖动：停止轮询，保留已有词条
          stopPolling()
          setJob(null)
          setJobError(`任务进度查询失败（${err.message}），已停止跟踪；词条数据仍保留，可重新触发生成`)
          refreshWikiStats()
        }
      }, 1500)
    },
    [stopPolling, settleJob, refreshWikiStats],
  )



  /** 清空词条（二次确认；成功后重拉图与统计） */
  const handleClear = React.useCallback(async () => {
    setClearing(true)
    try {
      await clearWiki()
      setClearOpen(false)
      setSelectedWiki(null)
      setWikiStats(null)
      load()
    } catch (err) {
      setJobError(err.message || '清空失败')
    } finally {
      setClearing(false)
    }
  }, [load])

  React.useEffect(() => {
    load()
    return stopPolling
  }, [load, stopPolling])

  /** 挂载恢复：刷新页面后接续进行中的任务轮询（任务记录保留 10 分钟） */
  React.useEffect(() => {
    let unmounted = false
    ;(async () => {
      const r = await refreshWikiStats()
      if (unmounted || !r?.current) return
      setJob(r.current)
      startPolling(r.current.id)
    })()
    return () => {
      unmounted = true
    }
  }, [refreshWikiStats, startPolling])

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  /** 派生视图（共享口径）：文档筛选 + wiki 开关 + 阈值过滤 + 关键词匹配 */
  const view = React.useMemo(
    () =>
      deriveGraphView(data, {
        threshold,
        keyword,
        selectedDocIds,
      }),
    [data, threshold, keyword, selectedDocIds],
  )

  /** 各文档切片计数（左栏列表徽标） */
  const docChunkCounts = React.useMemo(() => {
    const m = new Map()
    for (const n of data?.nodes ?? []) {
      if (n.type === 'wiki') continue
      m.set(n.docId, (m.get(n.docId) ?? 0) + 1)
    }
    return m
  }, [data])

  /** 文档复选切换（null ↔ 具体集合互转） */
  const toggleDoc = (docId) => {
    setSelectedDocIds((prev) => {
      if (!prev) {
        // 全部 → 仅该文档
        return new Set([docId])
      }
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next.size === (data?.docs?.length ?? 0) ? null : next
    })
  }

  /**
   * 点击节点：wiki 词条开浮层；切片节点跳**切片阅读器**（D9 语义）。
   *
   * 此前跳 /vector-data（管理端数据明细，看到的是一行数据库记录）；
   * v3 起改为跳阅读器并按 chunk 定位 —— 节点直接落到文件里的那段实际正文，
   * 贯彻「文件为事实源」。传入 chunkId（阅读器同时兼容 idx 与 chunkId）。
   */
  const handleNodeClick = React.useCallback(
    (n) => {
      if (n.type === 'wiki') {
        setSelectedWiki(n)
        return
      }
      navigate(
        `/knowledge/read/${encodeURIComponent(n.docId)}?chunk=${encodeURIComponent(n.id)}`,
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

  /** 切换视图模式并持久化（与仪表盘卡片共享偏好） */
  const switchMode = (m) => {
    setMode(m)
    window.localStorage.setItem('ui:knowledge-graph-mode', m)
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* ===== 左栏：检索条件 + 文档列表 + LLM Wiki（可折叠，收起为窄条） ===== */}
      {navCollapsed ? (
        <aside className="flex w-10 shrink-0 flex-col border-r border-border bg-card/40">
          <button
            type="button"
            onClick={toggleNavCollapsed}
            title="展开面板"
            aria-label="展开面板"
            className="flex h-9 w-full items-center justify-center border-b border-border/60 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        </aside>
      ) : (
        <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/40 scrollbar-thin md:w-64">
          {/* 左上：检索条件 */}
          <div className="shrink-0 space-y-3 border-b border-border/60 p-3">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              检索条件
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && locateFirstMatch()}
                placeholder="检索节点，Enter 定位…"
                className="h-8 pl-8 text-xs"
                aria-label="检索网络图节点"
              />
            </div>
            {view?.kw && (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {view.matched.size} 个匹配节点
              </p>
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
                className="h-1.5 flex-1 cursor-pointer accent-primary"
                aria-label="相似度阈值"
              />
              <span className="w-8 tabular-nums font-medium text-foreground">
                {threshold.toFixed(2)}
              </span>
            </label>
          </div>

          {/* 中部：文档复选列表（文件管理列） */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
            <div className="flex items-center justify-between pb-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                文档（{data?.docs?.length ?? 0}）
              </p>
              <button
                type="button"
                onClick={() => setSelectedDocIds(null)}
                disabled={!selectedDocIds}
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                全部
              </button>
            </div>
            <div className="space-y-1">
              {(data?.docs ?? []).map((d) => {
                const checked = !selectedDocIds || selectedDocIds.has(d.id)
                return (
                  <label
                    key={d.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/40"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDoc(d.id)}
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground/85" title={d.title}>
                      {d.title}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {docChunkCounts.get(d.id) ?? 0}
                    </span>
                  </label>
                )
              })}
              {data && (data?.docs?.length ?? 0) === 0 && (
                <p className="px-1 text-[11px] text-muted-foreground">暂无文档</p>
              )}
            </div>
          </div>

        </aside>
      )}

      {/* ===== 右侧：网络图画布（仅图 + 浮动工具条 + 浮层态） ===== */}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-muted/10">
        {/* 画布 */}
        <div className="h-full w-full">
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
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
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
        </div>

        {/* 浮动工具条（右上角）：统计 + 视图切换 + 刷新 */}
        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
          <div className="pointer-events-auto flex items-center rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
            {view
              ? `${view.nodes.length} 节点 · ${view.edges.length} 边`
              : '…'}
          </div>
          <div
            className="pointer-events-auto flex items-center rounded-md border border-border bg-background/80 p-0.5 backdrop-blur-sm"
            role="group"
            aria-label="视图模式切换"
          >
            <button
              type="button"
              onClick={() => switchMode('3d')}
              className={cn(
                'flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium transition-colors',
                mode === '3d'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              title="3D 立体视图（Three.js 力导向）"
            >
              <Orbit className="h-3.5 w-3.5" />
              3D
            </button>
            <button
              type="button"
              onClick={() => switchMode('2d')}
              className={cn(
                'flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium transition-colors',
                mode === '2d'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              title="2D 平面视图（ECharts 力导向）"
            >
              <Network className="h-3.5 w-3.5" />
              2D
            </button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="pointer-events-auto h-8 w-8 border border-border bg-background/80 p-0 backdrop-blur-sm"
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

        {/* 词条详情浮层（点击 wiki 节点；叠于画布右上，避开工具条） */}
        {selectedWiki && (
          <div className="absolute right-3 top-14 w-72 max-h-[60%] overflow-y-auto rounded-lg border border-amber-500/30 bg-background/95 p-3 shadow-lg backdrop-blur-sm scrollbar-thin">
            <div className="flex items-start gap-2">
              <BookMarked className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug break-words">
                  {selectedWiki.name}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {selectedWiki.raw?.type || selectedWiki.entityType || '词条'} ·
                  提及 {selectedWiki.degree ?? (selectedWiki.raw?.mentionChunkIds ?? []).length} 处
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedWiki(null)}
                title="关闭"
                aria-label="关闭词条详情"
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {(selectedWiki.aliases?.length > 0 || selectedWiki.raw?.aliases?.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1">
                {(selectedWiki.aliases ?? selectedWiki.raw?.aliases ?? []).map((a) => (
                  <Badge
                    key={a}
                    variant="outline"
                    className="h-4 max-w-full truncate px-1.5 text-[10px] font-normal text-muted-foreground"
                  >
                    {a}
                  </Badge>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-foreground/85">
              {selectedWiki.summary || '摘要尚未生成（重新触发生成可补齐）。'}
            </p>
            {(selectedWiki.raw?.mentionContexts ?? []).length > 0 && (
              <div className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  知识库提及
                </p>
                {(selectedWiki.raw?.mentionContexts ?? [])
                  .slice(0, 6)
                  .map((c, i) => (
                    <p
                      key={i}
                      className="rounded bg-muted/50 px-2 py-1 text-[11px] leading-relaxed text-foreground/75"
                    >
                      {c.length > 90 ? `${c.slice(0, 90)}…` : c}
                    </p>
                  ))}
                {(selectedWiki.raw?.mentionChunkIds ?? []).length > 6 && (
                  <p className="text-[10px] text-muted-foreground">
                    等 {(selectedWiki.raw?.mentionChunkIds ?? []).length} 处提及（节点点击可跳转数据明细）
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 覆盖态：加载 / 错误 / 空数据 */}
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
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-border/60 bg-background/80 px-8 py-7 text-center shadow-sm backdrop-blur-sm">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                {selectedDocIds || (data.docs?.length ?? 0) > 0 ? (
                  <Network className="h-5 w-5 text-primary/70" />
                ) : (
                  <FilePlus2 className="h-5 w-5 text-primary/70" />
                )}
              </div>
              {selectedDocIds ? (
                <>
                  <p className="text-sm font-medium">所选文档在当前阈值下无节点</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    试试调低左侧相似度阈值，或清除文档筛选查看全库网络。
                  </p>
                  <Button size="sm" variant="outline" onClick={() => setSelectedDocIds(null)}>
                    清除文档筛选
                  </Button>
                </>
              ) : (data.docs?.length ?? 0) === 0 ? (
                <>
                  <p className="text-sm font-medium">知识库还是空的</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    上传文档并完成解析入库后，这里会以语义相似度网络展示你的知识切片。
                    当前账号名下还没有任何文档。
                  </p>
                  <Button size="sm" onClick={() => navigate('/knowledge')}>
                    <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
                    去上传文档
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">暂无可视化节点</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    已有文档但切片向量缺失或相似度未达阈值。可尝试调低左侧阈值，或回到文档管理重新解析。
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 清空 Wiki 二次确认 */}
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清空全部 Wiki 词条？"
        description="将删除全部词条、摘要与切片抽取记录（网络图中的词条节点随之消失）。知识库文档与切片不受影响，可随时重新生成。"
        confirmLabel="清空"
        destructive
        onConfirm={handleClear}
        submitting={clearing}
      />
    </div>
  )
}

export default KnowledgeGraphPage
