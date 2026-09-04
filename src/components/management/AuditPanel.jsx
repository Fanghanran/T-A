import * as React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { fetchAudit } from '@/lib/managementApi'

/**
 * AuditPanel —— 操作审计表格面板（常开，无折叠）
 *
 * 自包含：挂载即拉取数据，右上角自带「刷新」。数据来源：
 * GET /api/management/audit?limit（append-only audit.jsonl，时间倒序）。
 *
 * 使用方：pages/AuditPage.jsx（侧边栏「操作审计」独立菜单视图）。
 *
 * @param {Object} [props]
 * @param {number} [props.limit=50] 拉取条数上限
 */
export function AuditPanel({ limit = 50 }) {
  const [items, setItems] = React.useState(null)
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const d = await fetchAudit(limit)
      setItems(d.items)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [limit])

  React.useEffect(() => {
    load()
  }, [load])

  return (
    <section aria-label="操作审计">
      {/* 工具行：条数徽标 + 刷新 */}
      <div className="mb-3 flex items-center gap-2">
        {items && items.length > 0 && (
          <Badge variant="secondary" className="text-[10px]">
            {items.length} 条
          </Badge>
        )}
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          刷新
        </button>
      </div>

      <Card className="py-0">
        <CardContent className="p-4">
          {loading && !items && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载中…
            </div>
          )}
          {items && items.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无操作记录</p>
          )}
          {items && items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="whitespace-nowrap px-3 py-2 font-medium">
                      时间
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium">
                      操作
                    </th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium">
                      对象
                    </th>
                    <th className="px-3 py-2 font-medium">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a, i) => {
                    const { target, detail } = auditTarget(a)
                    return (
                      <tr
                        key={`${a.ts}-${i}`}
                        className="border-b transition-colors last:border-b-0 hover:bg-accent/40"
                      >
                        <td className="whitespace-nowrap px-3 py-2">
                          <code className="text-muted-foreground">
                            {formatTs(a.ts)}
                          </code>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <Badge
                            variant={
                              a.action?.endsWith('disable')
                                ? 'destructive'
                                : 'outline'
                            }
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {AUDIT_LABELS[a.action] ?? a.action}
                          </Badge>
                        </td>
                        <td
                          className="max-w-[16rem] truncate px-3 py-2"
                          title={target}
                        >
                          {target || '—'}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {detail || '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

/** 审计动作 → 中文标签 */
const AUDIT_LABELS = {
  'tool.enable': '启用工具',
  'tool.disable': '禁用工具',
  'workflow.enable': '启用工作流',
  'workflow.disable': '禁用工作流',
  'registry.reset': '恢复默认（启停）',
  'tunable.set': '修改参数',
  'tunable.reset': '恢复默认（参数）',
}

/** 审计条目 → 表格的「对象 / 详情」两列内容 */
function auditTarget(a) {
  if (a.action === 'tunable.set') {
    return {
      target: a.label ?? a.key ?? '',
      detail: `${String(a.from)} → ${String(a.to)}`,
    }
  }
  if (a.action === 'tunable.reset') {
    return { target: '全部调优参数', detail: '恢复默认值' }
  }
  if (a.action === 'registry.reset') {
    const n = a.removed?.length ?? 0
    return { target: `${a.scope ?? ''} 命名空间`, detail: `清空 ${n} 个禁用项` }
  }
  return { target: a.label ?? a.name ?? '', detail: '' }
}

/** ISO 时间 → 本地短格式 */
function formatTs(ts) {
  try {
    const d = new Date(ts)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return ts
  }
}

export default AuditPanel
