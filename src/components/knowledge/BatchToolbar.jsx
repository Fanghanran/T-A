import * as React from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** 批量操作工具栏：选中时显示 */
export function BatchToolbar({
  selN,
  batchLoading,
  onClearSelection,
  onBatchPrompt,
  onBatchDelete,
}) {
  if (!selN) return null
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2">
      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
        已选 {selN} 篇
      </span>
      {onClearSelection && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onClearSelection}
          disabled={batchLoading}
        >
          清空选择
        </Button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => onBatchPrompt?.('setCategory')}
          disabled={batchLoading}
        >
          批量改分类
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => onBatchPrompt?.('addTags')}
          disabled={batchLoading}
        >
          批量加标签
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => onBatchPrompt?.('removeTag')}
          disabled={batchLoading}
        >
          批量去标签
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onBatchDelete}
          disabled={batchLoading}
        >
          {batchLoading ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-3 w-3" />
          )}
          批量删除
        </Button>
      </div>
    </div>
  )
}
