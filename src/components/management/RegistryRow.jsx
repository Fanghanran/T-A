import * as React from 'react'
import { Loader2, TriangleAlert, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ToggleSwitch } from './ToggleSwitch'
import { cn } from '@/lib/utils'

/**
 * 注册项单行启停行：一行完成「查看状态 + 启用/禁用」。
 * 布局（单行，不换行）：[标签+名称] [描述截断] [统计徽标] …… [开关]。
 * 禁用且存在启用中的依赖方时，开关位置切换为行内二次确认（仍是同一行）：
 *   [⚠影响N项] [确认] [取消]。
 */
export function RegistryRow({
  item,
  kind,
  toggling,
  confirming,
  onToggle,
  onCancelConfirm,
}) {
  const enabled = !!item.enabled
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 transition-colors',
        !enabled && 'opacity-60',
      )}
    >
      {/* 左：标签 + 名称 + 统计 */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-[13px] font-medium">
          {item.label || item.name}
        </span>
        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {item.name}
        </code>
        <span
          className="min-w-0 truncate text-xs text-muted-foreground/80"
          title={item.description}
        >
          {item.description}
        </span>
        {item.stats?.calls > 0 && (
          <Badge
            variant="outline"
            className="shrink-0 gap-1 px-1.5 py-0 text-[10px] text-muted-foreground"
          >
            <Activity className="h-3 w-3" />
            {item.stats.calls} 次 · 均 {item.stats.avgMs ?? '–'}ms
            {item.stats.failures > 0 ? ` · 失败 ${item.stats.failures}` : ''}
          </Badge>
        )}
      </div>
      {/* 右：开关（或行内二次确认） */}
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
            title={item.dependents.map((d) => d.label).join('、')}
          >
            <TriangleAlert className="h-3.5 w-3.5" />
            影响 {item.dependents.length} 项
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={onCancelConfirm}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 px-2 text-xs"
            disabled={toggling}
            onClick={() => onToggle(kind, item, false)}
          >
            {toggling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              '确认禁用'
            )}
          </Button>
        </div>
      ) : (
        <ToggleSwitch
          checked={enabled}
          disabled={toggling}
          onToggle={(next) => onToggle(kind, item, next)}
        />
      )}
    </div>
  )
}
