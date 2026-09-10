import * as React from 'react'
import { Loader2, RefreshCw, RotateCcw, Workflow, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  fetchOverview,
  setToolEnabled,
  setWorkflowEnabled,
  resetRegistry,
} from '@/lib/managementApi'
import { SectionTitle } from '@/components/management/SectionTitle'
import { RegistryRow } from '@/components/management/RegistryRow'

/**
 * RegistryManagePage —— 工作流 / 工具启停管理页（系统管理子菜单）
 *
 * kind='workflows' | 'tools'，共用注册表启停逻辑：
 *  - 一行一项：名称 + 运行统计（调用次数/失败/平均耗时） + 启停开关
 *  - 禁用被依赖项（dependents）→ 行内二次确认
 *  - 工作流禁用 → 对应聊天分支回退关键词路由；工具禁用 → 智能体 System Prompt 不再列出
 *  - 恢复默认仅重置本区（scope = kind）
 *
 * @param {Object} props
 * @param {'workflows'|'tools'} props.kind
 * @param {(busy:boolean)=>void} [props.onLoadingChange]
 */
export function RegistryManagePage({ kind, onLoadingChange }) {
  const isWorkflow = kind === 'workflows'
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [toggling, setToggling] = React.useState('') // 正在启停的 name（行级禁用）
  const [confirming, setConfirming] = React.useState('') // 等待二次确认禁用的 name

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
  const doToggle = async (itemKind, name, enabled) => {
    setToggling(name)
    setConfirming('')
    setError('')
    try {
      const api = itemKind === 'tool' ? setToolEnabled : setWorkflowEnabled
      const { item } = await api(name, enabled)
      setOverview((prev) => {
        if (!prev) return prev
        const key = itemKind === 'tool' ? 'tools' : 'workflows'
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

  /** 禁用且有启用中的依赖方 → 行内二次确认；否则直接执行 */
  const handleToggle = (itemKind, item, enabled) => {
    if (!enabled && item.dependents?.length) {
      setConfirming(item.name)
      return
    }
    doToggle(itemKind, item.name, enabled)
  }

  /** 恢复默认（仅重置本区启停覆盖）后整页重载 */
  const handleReset = async () => {
    setError('')
    try {
      await resetRegistry(isWorkflow ? 'workflows' : 'tools')
      await load()
    } catch (err) {
      setError(err.message || '恢复默认失败')
    }
  }

  const section = isWorkflow ? overview?.workflows : overview?.tools
  const rowKind = isWorkflow ? 'workflow' : 'tool'

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={isWorkflow ? Workflow : Wrench}
        title={isWorkflow ? '工作流管理' : '工具管理'}
        description={
          isWorkflow
            ? '工作流启停与运行统计；禁用后对应聊天分支回退关键词路由'
            : '工具启停与运行统计；禁用后智能体 System Prompt 不再列出该工具'
        }
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={handleReset}
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
      </PageHeader>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl animate-page-in px-4 py-6 md:px-6">
          {error && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <section>
            <SectionTitle
              icon={
                isWorkflow ? (
                  <Workflow className="h-3.5 w-3.5" />
                ) : (
                  <Wrench className="h-3.5 w-3.5" />
                )
              }
              title={isWorkflow ? '工作流' : '工具'}
              stats={section}
            />
            <Card className="py-0">
              <CardContent className="divide-y divide-border p-0">
                {section?.items?.map((it) => (
                  <RegistryRow
                    key={it.name}
                    item={it}
                    kind={rowKind}
                    toggling={toggling === it.name}
                    confirming={confirming === it.name}
                    onToggle={handleToggle}
                    onCancelConfirm={() =>
                      confirming === it.name && setConfirming('')
                    }
                  />
                ))}
                {!section?.items?.length && !loading && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    暂无已注册的{isWorkflow ? '工作流' : '工具'}
                  </p>
                )}
              </CardContent>
            </Card>
          </section>

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

export default RegistryManagePage
