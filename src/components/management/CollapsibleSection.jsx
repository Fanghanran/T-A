import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 可折叠分区壳：标题行点击切换，默认收起 */
export function CollapsibleSection({
  icon,
  title,
  hint,
  badge,
  children,
  defaultOpen = false,
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <section>
      <button
        type="button"
        className="mb-3 flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {badge}
        {hint && (
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        )}
      </button>
      {open && <div className="flex flex-col gap-2.5">{children}</div>}
    </section>
  )
}
