import * as React from 'react'
import { X, Plus, ChevronsUpDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TECH_STACK_OPTIONS } from '@/lib/constants'
import { cn } from '@/lib/utils'

/**
 * TechStackSelector —— 技术栈标签多选输入
 *
 * 交互：
 * - 已选标签以 Badge 展示，点击 × 移除。
 * - 输入框聚焦时弹出下拉，按输入文本过滤候选；点击候选即加入已选。
 * - 回车可把当前输入作为自定义标签加入（去重）。
 * - 选择/移除均通过 onChange 上抛新数组（受控）。
 *
 * @param {Object} props
 * @param {string[]} props.selected       已选技术栈
 * @param {(next: string[]) => void} props.onChange 变更回调
 */
export function TechStackSelector({ selected = [], onChange }) {
  const [query, setQuery] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef(null)

  // 点击外部关闭下拉
  React.useEffect(() => {
    function onPointerDown(e) {
      if (!containerRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return TECH_STACK_OPTIONS.filter(
      (opt) => !selected.includes(opt) && (!q || opt.toLowerCase().includes(q)),
    ).slice(0, 8)
  }, [query, selected])

  const addTag = (tag) => {
    const value = tag.trim()
    if (!value || selected.includes(value)) return
    onChange([...selected, value])
    setQuery('')
  }

  const removeTag = (tag) => {
    onChange(selected.filter((t) => t !== tag))
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTag(query)
    } else if (e.key === 'Backspace' && !query && selected.length) {
      removeTag(selected[selected.length - 1])
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 text-sm',
          'min-h-9 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        )}
        onClick={() => setOpen(true)}
      >
        {selected.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1 text-xs">
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeTag(tag)
              }}
              className="rounded-full p-0.5 hover:bg-foreground/10"
              aria-label={`移除 ${tag}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={selected.length ? '' : '选择或输入技术栈…'}
          className="flex-1 min-w-[80px] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => setOpen((o) => !o)}
          aria-label="展开候选"
          tabIndex={-1}
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 候选下拉 */}
      {open && (filtered.length > 0 || query.trim()) && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-auto rounded-md border bg-popover p-1 shadow-md scrollbar-thin animate-fade-in">
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => addTag(opt)}
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span>{opt}</span>
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ))}
          {query.trim() &&
            !TECH_STACK_OPTIONS.some(
              (o) => o.toLowerCase() === query.trim().toLowerCase(),
            ) && (
              <button
                type="button"
                onClick={() => addTag(query)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>
                  添加自定义：
                  <span className="font-medium">“{query.trim()}”</span>
                </span>
              </button>
            )}
        </div>
      )}
    </div>
  )
}

export default TechStackSelector
