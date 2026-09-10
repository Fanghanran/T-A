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
import { fetchVectorOverview } from '@/lib/managementApi'
import { cn } from '@/lib/utils'

/**
 * VectorStructurePage —— 向量库「数据结构」单页浏览（只读，仿 Navicat）
 *
 * 左侧导航栏选择"表"（集合），右侧直接展示该集合的完整结构，
 * 不再跳转子界面：
 *  - 左侧：集合导航列表（名称 / 用途 / 行数），点击切换，可收起为窄条
 *  - 右侧：集合元信息条 + 字段结构表 + 索引表
 *
 * 数据来源：GET /api/management/vector/overview（Strong 一致口径计数，
 * 一次返回全部集合的完整 fields/indexes，切换集合无需二次请求），
 * 只读，不触碰数据。
 *
 * @param {Object} props
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */

/** 集合用途说明（按常见集合名匹配，未匹配时留空） */
export const COLLECTION_DESC = {
  kb_documents: '文档主表：元数据 + title_vector',
  kb_chunks: '知识切片：text_vector + question_vector 双向量',
  kb_memory: '长期记忆事实（会话提炼）',
}

/**
 * CollectionPane —— 右侧单集合完整结构区
 *
 * @param {Object|null} props.col 当前选中集合（null 表示未选择）
 */
function CollectionPane({ col }) {
  // 未选中集合：空态提示
  if (!col) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Database className="h-8 w-8 text-muted-foreground/30" />
        从左侧选择集合，查看其字段结构与索引
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <div className="mx-auto max-w-6xl px-4 py-4 md:px-6">
        {/* 集合元信息条 */}
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-mono text-sm font-semibold text-foreground">
            <Table2 className="h-3.5 w-3.5 text-primary" />
            {col.name}
          </span>
          <span className="text-border">|</span>
          <span className="font-medium text-foreground/85">
            {COLLECTION_DESC[col.name] ?? '—'}
          </span>
          <span className="text-border">|</span>
          <span className="tabular-nums">{col.rowCount} 行</span>
          <span className="text-border">|</span>
          <span className="tabular-nums">{col.fields.length} 字段</span>
          <span className="text-border">|</span>
          <span className="tabular-nums">{col.indexes.length} 索引</span>
          {col.createdTime && (
            <>
              <span className="text-border">|</span>
              <span>
                创建于 {new Date(col.createdTime).toLocaleString('zh-CN')}
              </span>
            </>
          )}
        </div>

        {/* 字段结构表 */}
        <section className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="text-sm font-semibold">字段结构</h3>
            <span className="text-xs text-muted-foreground">
              {col.fields.length}
            </span>
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
                      <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 text-right font-medium">
                        向量维度
                      </th>
                      <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 text-right font-medium">
                        最大长度
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {col.fields.map((f) => (
                      <tr
                        key={f.name}
                        className={cn(
                          'border-b transition-colors last:border-b-0 hover:bg-accent/40',
                          f.isVector && 'bg-primary/[0.04]',
                        )}
                      >
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono font-medium">
                          {f.name}
                        </td>
                        <td
                          className={cn(
                            'whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono',
                            f.isVector
                              ? 'font-medium text-primary'
                              : 'text-muted-foreground',
                          )}
                        >
                          {f.type}
                        </td>
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5">
                          {f.isPrimaryKey ? (
                            <Badge
                              variant="outline"
                              className="px-1.5 py-0 text-[10px]"
                            >
                              PK
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-right tabular-nums">
                          {f.dim ?? (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                          {f.maxLength ?? (
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

        {/* 索引表 */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Gauge className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="text-sm font-semibold">索引</h3>
            <span className="text-xs text-muted-foreground">
              {col.indexes.length}
            </span>
          </div>
          <Card className="py-0">
            <CardContent className="p-0">
              {col.indexes.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  该集合无索引
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                          字段
                        </th>
                        <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                          索引类型
                        </th>
                        <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                          度量方式
                        </th>
                        <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 text-right font-medium">
                          已索引行数
                        </th>
                        <th className="whitespace-nowrap border border-border/60 bg-muted/70 px-3 py-2.5 font-medium">
                          状态
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {col.indexes.map((ix) => (
                        <tr
                          key={ix.field}
                          className="border-b transition-colors last:border-b-0 hover:bg-accent/40"
                        >
                          <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 font-mono font-medium">
                            {ix.field}
                          </td>
                          <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-muted-foreground">
                            {ix.indexType || '—'}
                          </td>
                          <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-muted-foreground">
                            {ix.metricType || '—'}
                          </td>
                          <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                            {ix.indexedRows}
                          </td>
                          <td className="whitespace-nowrap border border-border/50 px-3 py-2.5 text-muted-foreground">
                            {ix.state || '—'}
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
      </div>
    </div>
  )
}

export function VectorStructurePage({ onLoadingChange }) {
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [updatedAt, setUpdatedAt] = React.useState(null)
  // 当前选中集合名（左侧导航点击切换，单页内浏览，不跳子界面）
  const [selectedName, setSelectedName] = React.useState('')
  // 左侧集合导航收起态（收起为窄条，只剩展开按钮），localStorage 持久化
  const [navCollapsed, setNavCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem('ui:vector-structure-nav-collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleNavCollapsed = React.useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('ui:vector-structure-nav-collapsed', next ? '1' : '0')
      } catch {
        /* 隐私模式等场景下静默忽略 */
      }
      return next
    })
  }, [])

  /** 刷新集合结构总览 */
  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setOverview(await fetchVectorOverview())
      setUpdatedAt(new Date())
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

  const collections = React.useMemo(
    () => overview?.collections ?? [],
    [overview],
  )
  const selectedCol = React.useMemo(
    () => collections.find((c) => c.name === selectedName) ?? null,
    [collections, selectedName],
  )
  const totalRows = collections.reduce((s, c) => s + c.rowCount, 0)

  return (
    // main 为 h-dvh 的 flex 列容器（含 Header），根节点用 flex-1 占据剩余高度
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Database}
        title="数据结构"
        description={
          updatedAt
            ? `${collections.length} 个集合 · ${totalRows} 行 · 更新于 ${updatedAt.toLocaleTimeString('zh-CN')}`
            : 'Milvus 集合结构只读浏览'
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

      {/* 主体：左集合导航 + 右结构区（Navicat 布局） */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧：集合导航（"表"列表）；收起态为窄条，仅保留展开按钮 */}
        {navCollapsed ? (
          <aside className="flex w-10 shrink-0 flex-col border-r border-border bg-card/40">
            <button
              type="button"
              onClick={toggleNavCollapsed}
              title="展开集合导航"
              aria-label="展开集合导航"
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
                集合
              </span>
              <button
                type="button"
                onClick={toggleNavCollapsed}
                title="收起集合导航"
                aria-label="收起集合导航"
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 集合列表 */}
            <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
              {loading && !overview && (
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
              {overview && collections.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">
                  未发现任何集合
                </p>
              )}
              {collections.map((col) => {
                const active = col.name === selectedName
                return (
                  <button
                    key={col.name}
                    type="button"
                    onClick={() => setSelectedName(col.name)}
                    title={col.name}
                    className={cn(
                      'flex w-full items-center gap-2 border-b border-border/40 px-2.5 py-2 text-left transition-colors',
                      active
                        ? 'bg-primary/10'
                        : 'hover:bg-accent/40 active:bg-accent/60',
                    )}
                  >
                    <Table2
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
                          'block truncate font-mono text-xs',
                          active
                            ? 'font-medium text-foreground'
                            : 'text-foreground/85',
                        )}
                      >
                        {col.name}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {COLLECTION_DESC[col.name] ?? `${col.fields.length} 字段`}
                      </span>
                    </span>
                    {/* 行数徽章 */}
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums',
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {col.rowCount}
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>
        )}

        {/* 右侧：选中集合的结构区 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <CollectionPane col={selectedCol} />
        </div>
      </div>
    </div>
  )
}

export default VectorStructurePage
