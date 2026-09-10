import * as React from 'react'
import { History, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/PageHeader'
import { fetchOverview, setAuditEnabled } from '@/lib/managementApi'
import { cn } from '@/lib/utils'
import { SectionTitle } from '@/components/management/SectionTitle'
import { ToggleSwitch } from '@/components/management/ToggleSwitch'
import { AuditPanel } from '@/components/management/AuditPanel'

/**
 * AuditManagePage —— 操作审计页（系统管理子菜单）
 *
 * 两块：审计开关（关闭后不再写入，历史保留可查） · 审计历史记录（常开面板，时间倒序）。
 */
export function AuditManagePage() {
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [auditToggling, setAuditToggling] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setOverview(await fetchOverview())
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  /** 审计功能总开关（关闭后管理操作不再写审计日志；历史记录保留可查） */
  const handleAuditToggle = async (enabled) => {
    setAuditToggling(true)
    setError('')
    try {
      await setAuditEnabled(enabled)
      setOverview((prev) => (prev ? { ...prev, audit: { enabled } } : prev))
    } catch (err) {
      setError(err.message || '操作失败')
    } finally {
      setAuditToggling(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={History}
        title="操作审计"
        description="管理操作记录 · 启停开关 · 历史查询"
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl animate-page-in px-4 py-6 md:px-6">
          {error && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* ===== 审计开关 ===== */}
          <section>
            <SectionTitle
              icon={<History className="h-3.5 w-3.5" />}
              title="审计记录"
            />
            <Card className="py-0">
              <CardContent className="p-0">
                <div
                  className={cn(
                    'flex items-center gap-3 px-4 py-2.5 transition-colors',
                    !overview?.audit?.enabled && 'opacity-60',
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0 text-[13px] font-medium">
                      审计功能
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground/80">
                      记录启停 / 参数修改 / 恢复默认操作；关闭后不再写入（历史保留可查）
                    </span>
                  </div>
                  <ToggleSwitch
                    checked={!!overview?.audit?.enabled}
                    disabled={auditToggling || !overview}
                    onToggle={handleAuditToggle}
                  />
                </div>
              </CardContent>
            </Card>
          </section>

          {/* ===== 审计历史记录（常开面板，自包含加载与刷新） ===== */}
          <div className="mt-6">
            <AuditPanel limit={100} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default AuditManagePage
