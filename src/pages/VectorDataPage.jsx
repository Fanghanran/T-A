import * as React from 'react'
import {
  Database,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/PageHeader'
import { fetchVectorCollections, fetchCollectionRows } from '@/lib/managementApi'
import { cn } from '@/lib/utils'

/**
 * VectorDataPage —— 向量库「数据明细」单页浏览（只读，v3）
 *
 * 有几张表就几个明细：左侧表列表（v3 存活集合），右侧该表的行网格 ——
 * 字段 = 集合 schema 原生字段（kb_vectors 的双向量以 dim/范数/前 8 维预览展示，
 * 完整向量不整包下发）。数据来源：
 * GET /api/management/vector/collections 与 /vector/collections/:name/rows
 */

const SCHEMA_FIELDS = {
  kb_vectors: [
    { key: 'vec_id', label: 'vec_id', mono: true },
    { key: 'owner_id', label: 'owner_id', mono: true },
    { key: 'doc_id', label: 'doc_id', mono: true },
    { key: 'idx', label: 'idx' },
    { key: 'text_vector', label: 'text_vector', vec: true },
    { key: 'question_vector', label: 'question_vector', vec: true },
  ],
  kb_memory: [
    { key: 'mem_id', label: 'mem_id', mono: true },
    { key: 'owner_id', label: 'owner_id', mono: true },
    { key: 'scope', label: 'scope' },
    { key: 'session_id', label: 'session_id', mono: true },
    { key: 'agent_name', label: 'agent_name' },
    { key: 'kind', label: 'kind' },
    { key: 'text', label: 'text', long: true },
    { key: 'content_hash', label: 'content_hash', mono: true },
    { key: 'ts', label: 'ts' },
    { key: 'text_vector', label: 'text_vector', vec: true },
  ],
}

function vecText(v) {
  if (!v || v.dim === 0) return '—'
  const norm = Number(v.norm || 0).toFixed(4)
  const head = (v.preview ?? []).map((x) => Number(x).toFixed(4)).join(', ')
  return 'dim ' + v.dim + ' · |v| ' + norm + ' · [' + head + ', …]'
}

/** 向量预览对象识别（SCHEMA_FIELDS 未登记的新集合，列没有 vec 标记也能正确格式化） */
function isVecPreview(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(v.dim)
}

function cellText(row, field) {
  const v = row[field.key]
  if (field.vec || isVecPreview(v)) return vecText(v)
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.join('，')
  return String(v)
}

export function VectorDataPage({ onLoadingChange }) {
  const [collections, setCollections] = React.useState([])
  const [current, setCurrent] = React.useState('')
  const [rows, setRows] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [rowsLoading, setRowsLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState(0)
  // 分页（后端 limit/offset + 全量 total）
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [total, setTotal] = React.useState(0)
  // 新集合动态列（SCHEMA_FIELDS 未登记时回退到后端返回的 columns，自动展示无需改前端）
  const [dynCols, setDynCols] = React.useState([])

  React.useEffect(() => {
    onLoadingChange?.(loading || rowsLoading)
  }, [loading, rowsLoading, onLoadingChange])

  // 加载集合列表（v3：kb_vectors / kb_memory）
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetchVectorCollections()
        if (cancelled) return
        const items = r?.items ?? []
        setCollections(items)
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
  }, [])

  // 加载当前表行（分页：limit/offset，响应带全量 total）
  React.useEffect(() => {
    if (!current) return
    let cancelled = false
    setRowsLoading(true)
    setSelected(0)
    ;(async () => {
      try {
        const r = await fetchCollectionRows(current, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
        })
        if (cancelled) return
        setRows(r?.rows ?? [])
        setDynCols(Array.isArray(r?.columns) ? r.columns : [])
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
  }, [current, page, pageSize])

  // 已登记集合用静态列定义（含格式标记）；新集合回退为动态列（自动展示）
  const fields =
    SCHEMA_FIELDS[current] ??
    dynCols.map((c) => ({ key: c, label: c }))

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载集合列表…
      </div>
    )
  }

  if (error) {
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
        title="数据明细"
        description={<>向量库按集合浏览：字段 = 集合 schema 原生字段（只读）</>}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5"
          onClick={() => setCurrent((c) => c)}
          disabled={rowsLoading}
        >
          {rowsLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          刷新
        </Button>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {/* 左：表列表（有几张表就几个明细） */}
        <aside className="scrollbar-thin w-52 shrink-0 overflow-y-auto border-r">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            集合
          </div>
          {collections.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => { setCurrent(c.name); setPage(1) }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                current === c.name
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50',
              )}
            >
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate font-mono">{c.name}</span>
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
                  {fields.map((f) => (
                    <th key={f.key} className={cn('px-3 py-2 font-medium', f.long && 'min-w-[16rem]')}>
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row, i) => (
                  <tr
                    key={row[fields[0]?.key] ?? i}
                    className={cn('border-b', i === selected ? 'bg-accent/40' : 'hover:bg-accent/30')}
                    onClick={() => setSelected(i)}
                  >
                    {fields.map((f) => (
                      <td
                        key={f.key}
                        className={cn(
                          'px-3 py-2 align-top',
                          f.mono && 'font-mono text-[11px]',
                          f.long && 'max-w-[20rem] break-all',
                          f.vec && 'whitespace-nowrap font-mono text-[11px]',
                        )}
                      >
                        {cellText(row, f)}
                      </td>
                    ))}
                  </tr>
                ))}
                {(rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={fields.length} className="py-8 text-center text-muted-foreground">
                      该集合暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {/* 分页器：记录导航 + 每页条数（下拉框） */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">
              共 {total} 条 · 第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
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

export default VectorDataPage
