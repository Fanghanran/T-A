import * as React from 'react'
import { cn } from '@/lib/utils'

/** 小巧的页码按钮（最多 7 格：首页 + 末页 + 当前 + 前后） */
export function PageButtons({ page, totalPages, onGo, disabled }) {
  const items = React.useMemo(() => {
    const set = new Set([1, totalPages, page - 1, page, page + 1])
    const arr = [...set]
      .filter((n) => n >= 1 && n <= totalPages)
      .sort((a, b) => a - b)
    const out = []
    for (let i = 0; i < arr.length; i++) {
      out.push(arr[i])
      if (i + 1 < arr.length && arr[i + 1] - arr[i] > 1) out.push('…')
    }
    return out
  }, [page, totalPages])
  return (
    <div className="flex items-center gap-0.5">
      {items.map((it, i) =>
        it === '…' ? (
          <span
            key={`gap-${i}`}
            className="h-7 min-w-[24px] px-1.5 text-center text-[11px] text-muted-foreground/60 flex items-center justify-center"
          >
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            disabled={disabled || it === page}
            onClick={() => onGo?.(it)}
            className={cn(
              'h-7 min-w-[24px] rounded border px-1.5 text-center text-[11px] transition-colors',
              it === page
                ? 'border-primary bg-primary/10 text-primary font-medium'
                : 'border-transparent hover:bg-accent disabled:opacity-50',
            )}
          >
            {it}
          </button>
        ),
      )}
    </div>
  )
}
