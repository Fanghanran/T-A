import * as React from 'react'
import { cn } from '@/lib/utils'

/** 轻量开关（无第三方依赖）：胶囊滑块，点击切换 */
export function ToggleSwitch({ checked, disabled, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      onClick={() => onToggle(!checked)}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
