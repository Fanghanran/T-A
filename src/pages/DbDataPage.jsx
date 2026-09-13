import * as React from 'react'
import {
  Database,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'

/**
 * DbDataPage —— 数据库目录通用的「数据明细」页（只读）
 *
 * 供「记忆库 / 会话库」复用（向量库有独立的 VectorDataPage）：
 *  - 左侧：表列表（load() 返回的 items，kind 徽标区分 milvus/sqlite）
 *  - 右侧：行网格 —— 列 = loadRows() 返回的 columns（动态），向量预览对象
 *    （{dim,norm,preview}）格式化为「dim · |v| · [前 8 维, …]」
 *
 * @param {Object} props
 * @param {string} props.title        页头标题
 * @param {string} props.description  页头描述
 * @param {() => Promise<{items: Array<{name:string,kind:string,desc?:string}>}>} props.load 表清单
 * @param {(name:string, opts:{limit:number, offset:number}) => Promise<{columns?:string[], total:number, rows:Array<object>}>} props.loadRows
 *   行分页加载函数（store 由闭包携带）
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */

/** 向量预览对象 → 紧凑文本；null/undefined → '—' */
function cellText(v) {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.join('，')
  if (typeof v === 'object') {
    if (Number.isFinite(v.dim)) {
      if (v.dim === 0) return '—'
      const norm = Number(v.norm || 0).toFixed(4)
      const head = (v.preview ?? []).map((x) => Number(x).toFixed(4)).join(', ')
      return `dim ${v.dim} · |v| ${norm} · [${head}, …]`
    }
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

export function DbDataPage({ title, description, load, loadRows, onLoadingChange }) {
  const [tables, setTables] = React.useState([])
  const [current, setCurrent] = React.useState('')
  const [columns, setColumns] = React.useState([])
  const [rows, setRows] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [rowsLoading, setRowsLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [total, setTotal] = React.useState(0)

  React.useEffect(() => {
    onLoadingChange?.(loading || rowsLoading)
  }, [loading, rowsLoading, onLoadingChange])

  // 加载表清单
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await load()
        if (cancelled) return
        const items = r?.items ?? []
        setTables(items)
        if (items.length) setCurrent(items[0].name)
      } catch (err) {
        if (!cancelled) setError(err?.message ?? '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  // 加载当前表行（分页）
  React.useEffect(() => {
    if (!current) return
    let cancelled = false
    setRowsLoading(true)
    setSelected(0)
    ;(async () => {
      try {
        const r = await loadRows(current, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
        })
        if (cancelled) return
        setRows(r?.rows ?? [])
        setColumns(r?.columns ?? [])
        setTotal(Number(r?.total) || 0)
      } catch (err) {
        if (!cancelled) {
          setError(err?.message ?? '加载失败')
          setRows([])
        }
      } finally {
        if (!cancelled) setRowsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [current, page, pageSize, loadRows])

  const currentTable = tables.find((t) => t.name === current)

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载表清单…
      </div>
    )
  }

  if (error && !rows) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          刷新页面
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Database}
        title={title}
        description={description}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5"
          onClick={() => setPage((p) => p)}
          disabled={rowsLoading}
        >
          {rowsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          刷新
        </Button>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {/* 左：表列表 */}
        <aside className="scrollbar-thin w-52 shrink-0 overflow-y-auto border-r">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            表
          </div>
          {tables.map((t) => (
            <button
              key={`${t.kind}:${t.name}`}
              type="button"
              onClick={() => {
                setCurrent(t.name)
                setPage(1)
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                current === t.name ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{t.name}</span>
                {t.kind && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {t.kind === 'milvus' ? 'Milvus' : 'SQLite'}
                  </span>
                )}
              </span>
            </button>
          ))}
        </aside>

        {/* 右：行网格（动态字段列） */}
        <main className="scrollbar-thin min-w-0 flex-1 overflow-auto">
          {rowsLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载…
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                <tr className="border-b text-left text-[10px] text-muted-foreground">
                  {columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row, i) => (
                  <tr
                    key={row[columns[0]] ?? i}
                    className={cn('border-b', i === selected ? 'bg-accent/40' : 'hover:bg-accent/30')}
                    onClick={() => setSelected(i)}
                  >
                    {columns.map((c) => (
                      <td
                        key={c}
                        className={cn(
                          'px-3 py-2 align-top',
                          typeof row[c] === 'string' && row[c].length > 60
                            ? 'max-w-[20rem] break-all'
                            : 'whitespace-nowrap',
                          typeof row[c] === 'object' && 'whitespace-nowrap font-mono text-[11px]',
                        )}
                      >
                        {cellText(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
                {(rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={Math.max(1, columns.length)} className="py-8 text-center text-muted-foreground">
                      该表暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {/* 分页器 */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">
              {currentTable?.desc ? `${currentTable.desc} · ` : ''}共 {total} 条 · 第 {page} /{' '}
              {Math.max(1, Math.ceil(total / pageSize))} 页
            </span>
            <div className="flex items-center gap-1">
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) || 50)
                  setPage(1)
                }}
                className="h-6 rounded border bg-background px-1 text-[11px]"
                aria-label="每页条数"
              >
                {[20, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>
                    {n} 条/页
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={page <= 1}
                onClick={() => setPage(1)}
                aria-label="首条"
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="上一条"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
                onClick={() => setPage((p) => p + 1)}
                aria-label="下一条"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
                onClick={() => setPage(Math.max(1, Math.ceil(total / pageSize)))}
                aria-label="末条"
              >
                <ChevronsRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

export default DbDataPage
