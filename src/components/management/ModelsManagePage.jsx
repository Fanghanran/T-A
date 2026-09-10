import * as React from 'react'
import { Bot, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/PageHeader'
import { ModelsSection } from '@/components/management/ModelsSection'

/**
 * ModelsManagePage —— 模型管理页（系统管理子菜单）
 *
 * 壳组件：页头 + ModelsSection（多模型 profile / 可搜索的默认模型选择 /
 * 角色路由 / 智能体绑定 / qwen3 思考模式开关 / 新增模型）。
 */
export function ModelsManagePage({ onLoadingChange }) {
  const [busy, setBusy] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  React.useEffect(() => {
    onLoadingChange?.(busy)
  }, [busy, onLoadingChange])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Bot}
        title="模型管理"
        description="多模型 profile · 可搜索路由绑定 · 思考模式开关"
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5"
          onClick={() => {
            setBusy(true)
            // 触发 ModelsSection 内部重载：通过 key 重建（简单直接）
            setReloadKey((k) => k + 1)
          }}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {busy ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl animate-page-in px-4 py-6 md:px-6">
          <ModelsSection key={reloadKey} onLoadingChange={setBusy} />
        </div>
      </div>
    </div>
  )
}

export default ModelsManagePage
