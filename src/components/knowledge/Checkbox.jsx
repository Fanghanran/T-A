import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 选择框（项目未引入 shadcn Checkbox，用原生 + 样式保证视觉一致）
 */
export function Checkbox({
  checked,
  indeterminate,
  onCheckedChange,
  disabled,
  title,
}) {
  const ref = React.useRef(null)
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <label
      className={cn(
        'inline-flex h-4 w-4 items-center justify-center rounded border border-input bg-background transition-colors',
        'focus-visible:focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        (checked || indeterminate) &&
          'bg-primary border-primary text-primary-foreground',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      title={title}
    >
      <input
        ref={ref}
        type="checkbox"
        className="absolute h-0 w-0 opacity-0"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
      />
      {checked ? (
        <Check className="h-3 w-3" strokeWidth={3} />
      ) : indeterminate ? (
        <span className="block h-[2px] w-2 rounded-sm bg-background" />
      ) : null}
    </label>
  )
}
