import * as React from 'react'
import { cn } from '@/lib/utils'

// Input —— shadcn/ui 文本输入框
const Input = React.forwardRef(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        'flex h-10 w-full rounded-lg border border-input bg-secondary/40 px-3 py-2 text-sm placeholder:text-muted-foreground transition-colors focus-visible:border-primary/40 focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input }
