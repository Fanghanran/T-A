import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Layers,
  RefreshCw,
  Loader2,
  Search,
  AlertCircle,
  FileText,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { fetchVectorDocuments, fetchVectorChunks } from '@/lib/managementApi'
import { formatSize } from '@/lib/documentListUtils'
import { cn } from '@/lib/utils'

/**
 * VectorDataPage —— 向量库「数据明细」单页浏览（只读，仿 Navicat）
 *
 * 左侧导航栏选择"表"（文档），右侧直接展示该文档的切片明细，
 * 不再跳转子界面：
 *  - 左侧：文档导航列表（搜索过滤 + 标题 / 分类 / 切片数），点击切换
 *  - 右侧：上半区数据网格——全字段列、可见网格线、冻结表头、
 *    行选择器列（当前记录左侧 ▶ 指示），点击行选中，方向键上下移动
 *  - 右侧：下半区记录面板——「表单 / 网格」两种视图，
 *    底部工具条含记录导航（首条 / 上一条 / 下一条 / 末条 + n/N 计数）
 *
 * 数据来源：GET /api/management/vector/documents 与
 * /api/management/vector/documents/:docId/chunks，只读，不触碰数据。
 *
 * @param {Object} props
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */

/** 向量字段值文本（表单视图）：dim · 范数 · 前 8 维预览 */
function vectorText(v) {
  const head = v.preview.map((x) => x.toFixed(4)).join(', ')
  return `dim ${v.dim} · |v| ${v.norm} · [${head}${v.preview.length > 0 ? ', …' : ''}]`
}

/** 向量字段短文本（网格单元格）：dim · 范数 */
function vectorCell(v) {
  return `${v.dim} · |v| ${v.norm}`
}

/** 记录字段定义（表单 / 网格视图共用）：label 为原始字段名 */
const FIELDS = [
  { label: 'chunk_id', value: (c) => c.id, mono: true },
  { label: 'idx', value: (c) => String(c.idx), mono: true },
  { label: 'heading', value: (c) => c.heading },
  { label: 'topic', value: (c) => c.topic },
  { label: 'display_title', value: (c) => c.displayTitle },
  { label: 'category', value: (c) => c.category },
  { label: 'tags', value: (c) => c.tags.join('，') },
  { label: 'status', value: (c) => c.status },
  {
    label: 'indexed_at',
    value: (c) =>
      c.indexedAt ? new Date(c.indexedAt).toLocaleString('zh-CN') : '',
  },
  { label: 'owner_id', value: (c) => c.ownerId, mono: true },
  { label: 'questions', value: (c) => c.questions.join('\n'), long: true },
  { label: 'text', value: (c) => c.text, long: true },
  {
    label: 'text_vector',
    value: (c) => vectorText(c.textVector),
    mono: true,
    vec: 'textVector',
  },
  {
    label: 'question_vector',
    value: (c) => vectorText(c.questionVector),
    mono: true,
    vec: 'questionVector',
  },
]

/** 表单视图：字段名 : 值 纵向列表（Navicat Form） */
function FormView({ record }) {
  return (
    <div className="min-w-0">
      {FIELDS.map((f) => {
        const val = f.value(record) || '—'
        return (
          <div
            key={f.label}
            className="flex border-b border-border/50 last:border-b-0"
          >
            <div className="w-44 shrink-0 border-r border-border/50 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
              {f.label}
            </div>
            <div className="min-w-0 flex-1 px-2.5 py-1.5 text-xs">
              {f.long ? (
                <div className="max-h-44 overflow-auto whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
                  {val}
                </div>
              ) : (
                <span
                  className={cn('break-all', f.mono && 'font-mono text-[11px]')}
                >
                  {val}
                </span>
              )}
              {f.vec && record[f.vec].isZero && (
                <Badge
                  variant="destructive"
                  className="ml-1.5 px-1.5 py-0 text-[10px]"
                >
                  零向量
                </Badge>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 网格视图：当前记录按字段横向平铺（Navicat Grid） */
function GridView({ record }) {
  return (
    <table className="border-collapse text-xs">
      <thead>
        <tr>
          {FIELDS.map((f) => (
            <th
              key={f.label}
              className="whitespace-nowrap border border-border/60 bg-muted/70 px-2.5 py-1.5 text-left font-mono text-[11px] font-medium text-muted-foreground"
            >
              {f.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {FIELDS.map((f) => {
            const val = f.value(record) || '—'
            return (
              <td
                key={f.label}
                className="max-w-[18rem] truncate border border-border/50 px-2.5 py-1.5"
                title={val}
              >
                <span className={cn(f.mono && 'font-mono text-[11px]')}>
                  {val}
                </span>
              </td>
            )
          })}
        </tr>
      </tbody>
    </table>
  )
}

/** 记录导航：首条 / 上一条 / 下一条 / 末条 + n/N 计数（Navicat 底栏） */
function RecordNav({ index, total, onGo }) {
  const base =
    'flex h-6 w-6 items-center justify-center border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground'
  return (
    <div className="flex items-center gap-2">
      <div className="flex">
        <button
          type="button"
          className={base}
          disabled={index <= 0}
          onClick={() => onGo(0)}
          title="首条"
          aria-label="首条记录"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn(base, 'border-l-0')}
          disabled={index <= 0}
          onClick={() => onGo(index - 1)}
          title="上一条"
          aria-label="上一条记录"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn(base, 'border-l-0')}
          disabled={index >= total - 1}
          onClick={() => onGo(index + 1)}
          title="下一条"
          aria-label="下一条记录"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn(base, 'border-l-0')}
          disabled={index >= total - 1}
          onClick={() => onGo(total - 1)}
          title="末条"
          aria-label="末条记录"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <span className="tabular-nums text-[11px] text-muted-foreground">
        {total > 0 ? `${index + 1} / ${total}` : `0 / ${total}`}
      </span>
    </div>
  )
}

/** 底部面板视图切换按钮（表单 / 网格） */
function PaneTabBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-6 items-center rounded px-2.5 text-[11px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        active
          ? 'bg-card font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * DocDetailPane —— 右侧单文档切片明细区（Navicat 表数据浏览）
 *
 * @param {Object} props
 * @param {Object|null} props.doc 当前选中文档元信息（null 表示未选择）
 * @param {string} [props.focusChunkId] 外部定位切片 ID（知识网络图跳入），明细加载后自动选中
 * @param {()=>void} [props.onRefreshToken] 列表刷新后的联动信号（递增触发重载）
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向页面级上报明细忙碌状态
 */
function DocDetailPane({ doc, focusChunkId, refreshToken, onLoadingChange }) {
  const [chunks, setChunks] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selectedIdx, setSelectedIdx] = React.useState(0)
  const [viewTab, setViewTab] = React.useState('form')
  const gridRef = React.useRef(null)

  // 以 docId 字符串为依赖（doc 对象引用随列表刷新变化，id 不变则不重载）
  const docId = doc?.id
  /** 拉取选中文档的切片明细 */
  const load = React.useCallback(async () => {
    if (!docId) return
    setLoading(true)
    setError('')
    setChunks(null)
    try {
      const r = await fetchVectorChunks(docId)
      setChunks(r)
      setSelectedIdx(0)
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [docId])

  React.useEffect(() => {
    load()
  }, [load, refreshToken])

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  const items = chunks?.items ?? []
  const current = items[selectedIdx] ?? null

  // 外部定位（知识网络图跳入）：明细加载完成后选中目标切片
  React.useEffect(() => {
    if (!chunks || !focusChunkId) return
    const idx = chunks.items.findIndex((c) => c.id === focusChunkId)
    if (idx >= 0 && idx !== selectedIdx) setSelectedIdx(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks, focusChunkId])

  /** 记录跳转（夹取到有效范围） */
  const goTo = (i) => {
    if (items.length === 0) return
    setSelectedIdx(Math.min(Math.max(i, 0), items.length - 1))
  }

  /** 选中记录变化时，网格内滚动跟随（记录导航时保持可见） */
  React.useEffect(() => {
    if (!current) return
    const el = document.querySelector(`tr[data-row="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, current])

  /** 网格键盘导航：方向键上下移动选中记录 */
  const handleGridKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      goTo(selectedIdx + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      goTo(selectedIdx - 1)
    }
  }

  /** 选中行并聚焦网格（保证方向键可用） */
  const selectRow = (i) => {
    setSelectedIdx(i)
    gridRef.current?.focus()
  }

  // 未选中文档：空态提示
  if (!doc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Layers className="h-8 w-8 text-muted-foreground/30" />
        从左侧选择文档，查看其切片与双向量明细
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 文档元信息条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-background/60 px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1 font-medium text-foreground">
          <FileText className="h-3.5 w-3.5 text-primary" />
          {doc.title || doc.id}
        </span>
        {chunks && (
          <>
            <span className="text-border">|</span>
            <span>{chunks.items.length} 条记录</span>
          </>
        )}
        {doc.category && (
          <>
            <span className="text-border">|</span>
            <span>{doc.category}</span>
          </>
        )}
        {doc.size > 0 && (
          <>
            <span className="text-border">|</span>
            <span>{formatSize(doc.size)}</span>
          </>
        )}
        {doc.uploadedAt && (
          <>
            <span className="text-border">|</span>
            <span>上传于 {new Date(doc.uploadedAt).toLocaleString('zh-CN')}</span>
          </>
        )}
        {doc.status && doc.status !== 'indexed' && (
          <>
            <span className="text-border">|</span>
            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
              {doc.status}
            </Badge>
          </>
        )}
        {chunks?.truncated && (
          <span className="text-muted-foreground/70">
            切片较多，仅展示前 {chunks.items.length} 条
          </span>
        )}
      </div>

      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <span className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </span>
        </div>
      )}
      {loading && !chunks && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中…
        </div>
      )}
      {chunks && items.length === 0 && !loading && (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          该文档暂无切片
        </div>
      )}

      {chunks && items.length > 0 && (
        <>
          {/* 上半区：数据网格 */}
          <div
            ref={gridRef}
            tabIndex={0}
            onKeyDown={handleGridKeyDown}
            className="min-h-0 flex-1 overflow-auto scrollbar-thin focus-visible:outline-none"
          >
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th
                    className="sticky top-0 z-10 w-8 border border-border/60 bg-muted/70 px-1 py-1.5"
                    aria-label="记录指示"
                  />
                  {[
                    'chunk_id',
                    'idx',
                    'heading',
                    'topic',
                    'text',
                    'category',
                    'tags',
                    'status',
                    'text_vector',
                    'question_vector',
                  ].map((name) => (
                    <th
                      key={name}
                      className="sticky top-0 z-10 whitespace-nowrap border border-border/60 bg-muted/70 px-2.5 py-1.5 text-left font-mono text-[11px] font-medium text-muted-foreground"
                    >
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((c, i) => (
                  <tr
                    key={c.id}
                    data-row={i}
                    onClick={() => selectRow(i)}
                    className={cn(
                      'cursor-pointer transition-colors',
                      i === selectedIdx ? 'bg-primary/10' : 'hover:bg-accent/40',
                    )}
                  >
                    {/* 行选择器列：当前记录 ▶ 指示 */}
                    <td className="w-8 border border-border/50 bg-muted/20 px-1 py-1.5 text-center">
                      {i === selectedIdx && (
                        <ChevronRight className="mx-auto h-3 w-3 text-primary" />
                      )}
                    </td>
                    <td className="whitespace-nowrap border border-border/50 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                      {c.id}
                    </td>
                    <td className="border border-border/50 px-2.5 py-1.5 tabular-nums">
                      {c.idx}
                    </td>
                    <td
                      className="max-w-[13rem] truncate border border-border/50 px-2.5 py-1.5"
                      title={c.heading}
                    >
                      {c.heading || '—'}
                    </td>
                    <td
                      className="max-w-[13rem] truncate border border-border/50 px-2.5 py-1.5"
                      title={c.topic}
                    >
                      {c.topic || '—'}
                    </td>
                    <td
                      className="max-w-[26rem] truncate border border-border/50 px-2.5 py-1.5 text-foreground/85"
                      title={c.text}
                    >
                      {c.text}
                    </td>
                    <td className="max-w-[9rem] truncate border border-border/50 px-2.5 py-1.5 text-muted-foreground">
                      {c.tags.join('，') || '—'}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap border border-border/50 px-2.5 py-1.5',
                        c.status !== 'indexed' && 'text-destructive',
                      )}
                    >
                      {c.status}
                    </td>
                    <td className="whitespace-nowrap border border-border/50 px-2.5 py-1.5">
                      <span
                        className={cn(
                          'font-mono text-[11px] text-muted-foreground',
                          c.textVector.isZero && 'text-destructive',
                        )}
                      >
                        {vectorCell(c.textVector)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap border border-border/50 px-2.5 py-1.5">
                      <span
                        className={cn(
                          'font-mono text-[11px] text-muted-foreground',
                          c.questionVector.isZero && 'text-destructive',
                        )}
                      >
                        {vectorCell(c.questionVector)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 下半区：记录面板（表单 / 网格 + 记录导航） */}
          <div className="flex h-[45%] min-h-[220px] shrink-0 flex-col border-t border-border bg-card">
            <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
              {current && viewTab === 'form' && <FormView record={current} />}
              {current && viewTab === 'grid' && <GridView record={current} />}
            </div>
            <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-2">
              <div className="flex h-7 items-center gap-0.5 rounded-md border border-border/70 bg-muted/40 p-0.5">
                <PaneTabBtn
                  active={viewTab === 'form'}
                  onClick={() => setViewTab('form')}
                >
                  表单
                </PaneTabBtn>
                <PaneTabBtn
                  active={viewTab === 'grid'}
                  onClick={() => setViewTab('grid')}
                >
                  网格
                </PaneTabBtn>
              </div>
              <div className="ml-auto">
                <RecordNav
                  index={selectedIdx}
                  total={items.length}
                  onGo={goTo}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function VectorDataPage({ onLoadingChange }) {
  const [searchParams, setSearchParams] = useSearchParams()
  // URL 参数（知识网络图跳入）：?docId= 定位文档，&chunkId= 定位切片
  const urlDocId = searchParams.get('docId') ?? ''
  const urlChunkId = searchParams.get('chunkId') ?? ''
  const [docs, setDocs] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [updatedAt, setUpdatedAt] = React.useState(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  // 当前选中文档 ID（左侧导航点击切换，单页内浏览，不跳子界面）；
  // 初始值取 URL 参数（网络图跳入时直接定位目标文档）
  const [selectedDocId, setSelectedDocId] = React.useState(() => urlDocId)
  // 左侧文档导航收起态（收起为窄条，只剩展开按钮），localStorage 持久化
  const [navCollapsed, setNavCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem('ui:vector-data-nav-collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleNavCollapsed = React.useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('ui:vector-data-nav-collapsed', next ? '1' : '0')
      } catch {
        /* 隐私模式等场景下静默忽略 */
      }
      return next
    })
  }, [])
  // 刷新令牌：列表刷新后联动重载右侧明细
  const [refreshToken, setRefreshToken] = React.useState(0)
  // 右侧明细区忙碌状态（与列表忙碌合并后上报 AppShell）
  const [detailLoading, setDetailLoading] = React.useState(false)

  /** 刷新文档列表 */
  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const dl = await fetchVectorDocuments()
      setDocs(dl.items ?? [])
      setUpdatedAt(new Date())
      setRefreshToken((t) => t + 1)
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  // URL docId 参数变化（如知识网络图在其他入口跳入本页）→ 同步选中态
  React.useEffect(() => {
    if (urlDocId && urlDocId !== selectedDocId) setSelectedDocId(urlDocId)
  }, [urlDocId, selectedDocId])

  /** 左侧导航选择文档：同步 URL（保留 docId，清除切片定位参数） */
  const selectDoc = React.useCallback(
    (id) => {
      setSelectedDocId(id)
      if (id !== urlDocId) {
        setSearchParams(id ? { docId: id } : {}, { replace: true })
      }
    },
    [urlDocId, setSearchParams],
  )

  // 列表或明细任一忙碌 → AppShell Header 思考态
  React.useEffect(() => {
    onLoadingChange?.(loading || detailLoading)
  }, [loading, detailLoading, onLoadingChange])

  // 本地过滤（文档全量已加载，无需再发请求）
  const filteredDocs = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return docs
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q),
    )
  }, [docs, searchQuery])

  const selectedDoc = React.useMemo(
    () => docs.find((d) => d.id === selectedDocId) ?? null,
    [docs, selectedDocId],
  )

  const totalChunks = React.useMemo(
    () => docs.reduce((s, d) => s + (d.chunkCount ?? 0), 0),
    [docs],
  )

  return (
    // main 为 h-dvh 的 flex 列容器（含 Header），根节点用 flex-1 占据剩余高度
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Layers}
        title="数据明细"
        description={
          updatedAt
            ? `${docs.length} 篇文档 · ${totalChunks} 切片 · 更新于 ${updatedAt.toLocaleTimeString('zh-CN')}`
            : '文档切片与双向量明细只读浏览'
        }
      >
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          刷新
        </Button>
      </PageHeader>

      {/* 主体：左文档导航 + 右明细区（Navicat 布局） */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧：文档导航（"表"列表）；收起态为窄条，仅保留展开按钮 */}
        {navCollapsed ? (
          <aside className="flex w-10 shrink-0 flex-col border-r border-border bg-card/40">
            <button
              type="button"
              onClick={toggleNavCollapsed}
              title="展开文档导航"
              aria-label="展开文档导航"
              className="flex h-9 w-full items-center justify-center border-b border-border/60 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </aside>
        ) : (
        <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-card/40 md:w-60">
          {/* 顶部：标题 + 收起按钮 */}
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              文档
            </span>
            <button
              type="button"
              onClick={toggleNavCollapsed}
              title="收起文档导航"
              aria-label="收起文档导航"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <ChevronsLeft className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 搜索过滤 */}
          <div className="shrink-0 border-b border-border/60 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="过滤文档…"
                className="h-8 pl-8 text-xs"
                aria-label="过滤文档"
              />
            </div>
          </div>

          {/* 文档列表 */}
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {loading && docs.length === 0 && (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                加载中…
              </div>
            )}
            {error && (
              <div className="flex items-start gap-1.5 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}
            {!loading && !error && filteredDocs.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">
                {docs.length === 0 ? '向量库暂无文档' : '无匹配文档'}
              </p>
            )}
            {filteredDocs.map((d) => {
              const active = d.id === selectedDocId
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => selectDoc(d.id)}
                  title={d.title || d.id}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-border/40 px-2.5 py-2 text-left transition-colors',
                    active
                      ? 'bg-primary/10'
                      : 'hover:bg-accent/40 active:bg-accent/60',
                  )}
                >
                  <FileText
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      active
                        ? 'text-primary'
                        : 'text-muted-foreground/60',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-xs',
                        active
                          ? 'font-medium text-foreground'
                          : 'text-foreground/85',
                      )}
                    >
                      {d.title || d.id}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {[d.category, d.size > 0 ? formatSize(d.size) : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {/* 切片数徽章；非 indexed 状态标红点 */}
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] tabular-nums',
                      active
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {d.status !== 'indexed' && (
                      <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                    )}
                    {d.chunkCount}
                  </span>
                </button>
              )
            })}
          </div>
        </aside>
        )}

        {/* 右侧：选中文档的明细区 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DocDetailPane
            doc={selectedDoc}
            focusChunkId={urlChunkId}
            refreshToken={refreshToken}
            onLoadingChange={setDetailLoading}
          />
        </div>
      </div>
    </div>
  )
}

export default VectorDataPage
