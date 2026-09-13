import * as React from 'react'
import {
  Database,
  RefreshCw,
  Loader2,
  AlertCircle,
  Table2,
  Gauge,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'

/**
 * DbStructurePage —— 数据库目录通用的「数据结构」页（只读，仿 Navicat）
 *
 * 供「记忆库 / 会话库」复用（向量库有独立的 VectorStructurePage，含向量专属列）：
 *  - 左侧：表导航列表（名称 / 用途 / 行数，Milvus 与 SQLite 表混列，kind 徽标区分）
 *  - 右侧：表元信息条 + 字段结构表 + 索引表（无索引不显示）
 *
 * 数据来源由 props 注入：load() → { file?, address?, writable?, items }，
 * items[].columns = [{ name, type, pk, notnull, vector? }]。
 *
 * @param {Object} props
 * @param {string} props.title        页头标题（如「记忆库 · 数据结构」）
 * @param {string} props.description  无数据时的页头描述
 * @param {() => Promise<Object>} props.load 表清单加载函数
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */

/** 单表结构区（右侧） */
function TablePane({ table }) {
  if (!table) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Database className="h-8 w-8 text-muted-foreground/30" />
        从左侧选择表，查看其字段结构与索引
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <div className="mx-auto max-w-6xl px-4 py-4 md:px-6">
        {/* 表元信息条 */}
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-mono text-sm font-semibold text-foreground">
            <Table2 className="h-3.5 w-3.5 text-primary" />
            {table.name}
          </span>
          <span className="text-border">|</span>
          <span className="font-medium text-foreground/85">{table.desc ?? '—'}</span>
          <span className="text-border">|</span>
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">
            {table.kind ?? 'sqlite'}
          </Badge>
          <span className="text-border">|</span>
          <span className="tabular-nums">{table.rowCount} 行</span>
          <span className="text-border">|</span>
          <span className="tabular-nums">{table.columns?.length ?? 0} 字段</span>
          {table.createdTime && (
            <>
              <span className="text-border">|</span>
              <span>创建于 {new Date(table.createdTime).toLocaleString('zh-CN')}</span>
            </>
          )}
        </div>

        {/* 字段结构表 */}
        <section className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="text-sm font-semibold">字段结构</h3>
            <span className="text-xs text-muted-foreground">{table.columns?.length ?? 0}</span>
          </div>
          <Card className="py-0">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                        字段名
                      </th>
                      <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                        类型
                      </th>
                      <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                        主键
                      </th>
                      <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                        非空
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(table.columns ?? []).map((f) => (
                      <tr
                        key={f.name}
                        className={cn(
                          'border-b transition-colors last:border-b-0 hover:bg-accent/40',
                          f.vector && 'bg-primary/[0.04]',
                        )}
                      >
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono font-medium">
                          {f.name}
                        </td>
                        <td
                          className={cn(
                            'whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono',
                            f.vector ? 'font-medium text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {f.type || '—'}
                        </td>
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5">
                          {f.pk ? (
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                              PK
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5">
                          {f.notnull ? (
                            <span className="text-xs font-medium">✓</span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* 索引表（有索引才显示）：兼容两种形态 —— Milvus {field,indexType,...} 与 SQLite {name,columns,unique} */}
        {Array.isArray(table.indexes) && table.indexes.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Gauge className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h3 className="text-sm font-semibold">索引</h3>
              <span className="text-xs text-muted-foreground">{table.indexes.length}</span>
            </div>
            <Card className="py-0">
              <CardContent className="p-0">
                {table.indexes[0]?.field !== undefined ? (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">字段</th>
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">索引类型</th>
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">度量方式</th>
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 text-right font-medium">已索引行数</th>
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.indexes.map((ix, i) => (
                          <tr key={ix.field ?? i} className="border-b transition-colors last:border-b-0 hover:bg-accent/40">
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono font-medium">{ix.field}</td>
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-muted-foreground">{ix.indexType || '—'}</td>
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-muted-foreground">{ix.metricType || '—'}</td>
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-right tabular-nums text-muted-foreground">{ix.indexedRows}</td>
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-muted-foreground">{ix.state || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">索引名</th>
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">字段列</th>
                          <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">唯一</th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.indexes.map((ix, i) => (
                          <tr key={ix.name ?? i} className="border-b transition-colors last:border-b-0 hover:bg-accent/40">
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono font-medium">{ix.name}</td>
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono text-muted-foreground">
                              {(ix.columns ?? []).join(', ') || '—'}
                            </td>
                            <td className="whitespace-nowrap border border-border/50 px-3 py-2.5">
                              {ix.unique ? <Badge variant="outline" className="px-1.5 py-0 text-[10px]">UNIQUE</Badge> : <span className="text-muted-foreground/50">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        )}
      </div>
    </div>
  )
}

export function DbStructurePage({ title, description, load, onLoadingChange }) {
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [updatedAt, setUpdatedAt] = React.useState(null)
  const [selectedName, setSelectedName] = React.useState('')
  const [navCollapsed, setNavCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem(`ui:db-structure-nav-collapsed:${title}`) === '1'
    } catch {
      return false
    }
  })
  const toggleNavCollapsed = React.useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(`ui:db-structure-nav-collapsed:${title}`, next ? '1' : '0')
      } catch {
        /* 隐私模式等场景下静默忽略 */
      }
      return next
    })
  }, [title])

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await load())
      setUpdatedAt(new Date())
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [load])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  // 默认选中第一张表（items 变化后保持既有选择）
  React.useEffect(() => {
    const items = data?.items ?? []
    if (items.length && !items.some((t) => t.name === selectedName)) {
      setSelectedName(items[0].name)
    }
  }, [data, selectedName])

  const tables = data?.items ?? []
  const selected = tables.find((t) => t.name === selectedName) ?? null
  const totalRows = tables.reduce((s, t) => s + t.rowCount, 0)

  // 存储位置描述：SQLite 显示文件路径，Milvus 显示地址
  const storageDesc = data?.file
    ? `${data.file}${data.writable === false ? ' · 只读' : ''}`
    : data?.address
      ? `Milvus ${data.address}`
      : description

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Database}
        title={title}
        description={
          updatedAt
            ? `${tables.length} 张表 · ${totalRows} 行 · 更新于 ${updatedAt.toLocaleTimeString('zh-CN')} · ${storageDesc}`
            : description
        }
      >
        <Button type="button" size="sm" variant="secondary" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
          刷新
        </Button>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {navCollapsed ? (
          <aside className="flex w-10 shrink-0 flex-col border-r border-border bg-card/40">
            <button
              type="button"
              onClick={toggleNavCollapsed}
              title="展开表导航"
              aria-label="展开表导航"
              className="flex h-9 w-full items-center justify-center border-b border-border/60 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </aside>
        ) : (
          <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-card/40 md:w-60">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-2.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">表</span>
              <button
                type="button"
                onClick={toggleNavCollapsed}
                title="收起表导航"
                aria-label="收起表导航"
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
              {loading && !data && (
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
              {data && tables.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">未发现任何表</p>
              )}
              {tables.map((t) => {
                const active = t.name === selectedName
                return (
                  <button
                    key={`${t.kind}:${t.name}`}
                    type="button"
                    onClick={() => setSelectedName(t.name)}
                    title={t.name}
                    className={cn(
                      'flex w-full items-center gap-2 border-b border-border/40 px-2.5 py-2 text-left transition-colors',
                      active ? 'bg-primary/10' : 'hover:bg-accent/40 active:bg-accent/60',
                    )}
                  >
                    <Table2
                      className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground/60')}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate font-mono text-xs',
                          active ? 'font-medium text-foreground' : 'text-foreground/85',
                        )}
                      >
                        {t.name}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {t.desc ?? `${t.columns?.length ?? 0} 字段`}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums',
                        active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {t.rowCount}
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TablePane table={selected} />
        </div>
      </div>
    </div>
  )
}

export default DbStructurePage
