import * as React from 'react'
import {
  RefreshCw,
  Loader2,
  Settings2,
  Wrench,
  Workflow,
  RotateCcw,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  fetchOverview,
  setToolEnabled,
  setWorkflowEnabled,
  resetRegistry,
  setAuditEnabled,
} from '@/lib/managementApi'
import { cn } from '@/lib/utils'
import { SectionTitle } from '@/components/management/SectionTitle'
import { RegistryRow } from '@/components/management/RegistryRow'
import { ToggleSwitch } from '@/components/management/ToggleSwitch'
import { TunablesSection } from '@/components/management/TunablesSection'
import { ModelsSection } from '@/components/management/ModelsSection'
import { UsersSection } from '@/components/management/UsersSection'

/**
 * ManagementPage —— 系统管理独立菜单视图
 *
 * 组成（各自独立成模块）：
 *  - RegistryRow   工具/工作流单行启停行（一行一项：名称 + 统计 + 开关）
 *  - 操作审计开关行（审计功能总开关；记录查看在侧边栏「操作审计」菜单）
 *  - TunablesSection 调优参数面板（懒加载，默认折叠）
 *
 * 数据来源：/api/management/*（server/lib/management/）。
 *  - 工具禁用 → 智能体 System Prompt 不再列出该工具（LLM 不可见）；
 *    若有启用中的项声明依赖它（dependents），行内展示级联影响并要求二次确认
 *  - 工作流禁用 → 对应聊天分支回退 action 关键词路由
 *  - 运行统计 → 本次进程内的调用次数 / 平均耗时 / 失败次数（重启清零）
 *
 * @param {Object} props
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */
export function ManagementPage({ onLoadingChange }) {
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [toggling, setToggling] = React.useState('') // 正在启停的 name（行级禁用）
  const [confirming, setConfirming] = React.useState('') // 等待二次确认禁用的 name
  const [auditToggling, setAuditToggling] = React.useState(false) // 审计开关请求中

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

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  /** 执行启停（确认后或无需确认时）；成功后局部更新 */
  const doToggle = async (kind, name, enabled) => {
    setToggling(name)
    setConfirming('')
    setError('')
    try {
      const api = kind === 'tool' ? setToolEnabled : setWorkflowEnabled
      const { item } = await api(name, enabled)
      setOverview((prev) => {
        if (!prev) return prev
        const key = kind === 'tool' ? 'tools' : 'workflows'
        const section = prev[key]
        return {
          ...prev,
          [key]: {
            ...section,
            items: section.items.map((x) =>
              x.name === name ? { ...x, ...item } : x,
            ),
            enabled: section.enabled + (enabled ? 1 : -1),
            disabled: section.disabled + (enabled ? -1 : 1),
          },
        }
      })
    } catch (err) {
      setError(err.message || '操作失败')
    } finally {
      setToggling('')
    }
  }

  /**
   * 启停入口：禁用且有启用中的依赖方（dependents）→ 行内二次确认；
   * 其余情况直接执行。
   */
  const handleToggle = (kind, item, enabled) => {
    if (!enabled && item.dependents?.length) {
      setConfirming(item.name)
      return
    }
    doToggle(kind, item.name, enabled)
  }

  /** 恢复默认（清空全部启停覆盖）后整页重载 */
  const handleResetRegistry = async () => {
    setError('')
    try {
      await resetRegistry('all')
      await load()
    } catch (err) {
      setError(err.message || '恢复默认失败')
    }
  }

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
      {/* 顶栏：标题 + 恢复默认 + 刷新 */}
      <div className="flex items-center gap-2 border-b px-4 py-3 md:px-6">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold tracking-tight">系统管理</h2>
        <span className="text-[11px] text-muted-foreground">
          工具 / 工作流启停 · 运行统计 · 审计开关 · 调优参数
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={handleResetRegistry}
            disabled={loading}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认
          </Button>
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
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          {error && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* ===== 工作流：一行一项 ===== */}
          <section>
            <SectionTitle
              icon={<Workflow className="h-3.5 w-3.5" />}
              title="工作流"
              stats={overview?.workflows}
            />
            <Card className="py-0">
              <CardContent className="divide-y divide-border p-0">
                {overview?.workflows?.items?.map((w) => (
                  <RegistryRow
                    key={w.name}
                    item={w}
                    kind="workflow"
                    toggling={toggling === w.name}
                    confirming={confirming === w.name}
                    onToggle={handleToggle}
                    onCancelConfirm={() =>
                      confirming === w.name && setConfirming('')
                    }
                  />
                ))}
                {!overview?.workflows?.items?.length && !loading && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    暂无已注册的工作流
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

          <Separator className="my-6" />

          {/* ===== 工具：一行一项 ===== */}
          <section>
            <SectionTitle
              icon={<Wrench className="h-3.5 w-3.5" />}
              title="工具"
              stats={overview?.tools}
            />
            <Card className="py-0">
              <CardContent className="divide-y divide-border p-0">
                {overview?.tools?.items?.map((t) => (
                  <RegistryRow
                    key={t.name}
                    item={t}
                    kind="tool"
                    toggling={toggling === t.name}
                    confirming={confirming === t.name}
                    onToggle={handleToggle}
                    onCancelConfirm={() =>
                      confirming === t.name && setConfirming('')
                    }
                  />
                ))}
                {!overview?.tools?.items?.length && !loading && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    暂无已注册的工具
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

          <Separator className="my-6" />

          {/* ===== 操作审计开关（记录页在侧边栏「操作审计」菜单） ===== */}
          <section>
            <SectionTitle
              icon={<History className="h-3.5 w-3.5" />}
              title="操作审计"
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
                      审计记录
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground/80">
                      记录启停 / 参数修改 /
                      恢复默认操作；关闭后不再写入（历史保留可查，查看入口在侧边栏「操作审计」）
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

          <Separator className="my-6" />

          {/* ===== 调优参数（默认折叠） ===== */}
          <TunablesSection onError={setError} />

          {/* ===== 模型管理（多模型 profile + 角色路由，ADR-006） ===== */}
          <div className="mt-6">
            <ModelsSection />
            <div className="mt-6">
              <UsersSection />
            </div>
          </div>

          {loading && !overview && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ManagementPage
