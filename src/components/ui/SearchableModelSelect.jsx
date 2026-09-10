import * as React from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 子序列匹配：查询串各字符按顺序出现在目标中即可命中。
 * 典型场景：输入 "qwencode" 能命中 "qwen2.5-coder:14b"（容忍型号数字/标点差异）。
 */
function subseqMatch(q, s) {
  if (!q) return true
  let i = 0
  for (const ch of s) {
    if (ch === q[i]) {
      i++
      if (i >= q.length) return true
    }
  }
  return false
}

/**
 * SearchableModelSelect —— 可搜索的模型选择器（combobox）
 *
 * 替代原生 select：模型 profile 多时（新增模型不受限）按名称 / 模型 id
 * 即时过滤定位，键盘上下选择 + 回车确认 + Esc 关闭。
 * 过滤两级：子串包含优先，无命中时子序列模糊兜底（qwencode → qwen2.5-coder）。
 * 选项支持 unregistered 标志（服务发现未注册模型，选用即自动建档）。
 * 触发器显示当前选中（label + model 徽标），空值显示占位文案。
 *
 * @param {Object} props
 * @param {string} props.value                当前选中的 profile id（'' 或 null = 空值）
 * @param {Array<{id:string,label:string,model:string,baseUrl?:string,enabled?:boolean,unregistered?:boolean}>} props.options
 * @param {(id:string)=>void} props.onChange   选中回调（空值选项回传 ''；unregistered 项回传伪 id，由调用方建档）
 * @param {string} [props.placeholder]         空值占位文案
 * @param {string} [props.emptyOptionLabel]    提供「空值」选项的文案（如「默认」「跟随角色默认」）；缺省不显示空值项
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]           触发器附加样式
 */
export function SearchableModelSelect({
  value,
  options = [],
  onChange,
  placeholder = '选择模型…',
  emptyOptionLabel,
  disabled = false,
  className,
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [activeIdx, setActiveIdx] = React.useState(0)
  const rootRef = React.useRef(null)
  const searchRef = React.useRef(null)

  const selected = options.find((p) => p.id === value) || null

  /** 过滤两级：子串包含优先；无命中时子序列模糊兜底 */
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    const substr = options.filter(
      (p) =>
        (p.label || '').toLowerCase().includes(q) ||
        (p.model || '').toLowerCase().includes(q),
    )
    if (substr.length) return substr
    return options.filter(
      (p) =>
        subseqMatch(q, (p.label || '').toLowerCase()) ||
        subseqMatch(q, (p.model || '').toLowerCase()),
    )
  }, [options, query])

  /** 下拉可选项列表（空值项置顶，不参与过滤） */
  const items = React.useMemo(
    () =>
      emptyOptionLabel
        ? [
            { id: '', label: emptyOptionLabel, model: '', isEmpty: true },
            ...filtered,
          ]
        : filtered,
    [emptyOptionLabel, filtered],
  )

  // 打开时重置搜索并聚焦搜索框
  React.useEffect(() => {
    if (open) {
      setQuery('')
      // 高亮当前选中项；未命中（含空值）归零到第一项
      const idx = items.findIndex((x) => x.id === (value ?? ''))
      setActiveIdx(idx < 0 ? 0 : idx)
      // 等下拉渲染完成再聚焦
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // 点击外部 / Esc 关闭
  React.useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = (id) => {
    setOpen(false)
    if (id !== (value ?? '')) onChange?.(id)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[activeIdx]
      if (it) commit(it.id)
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {/* 触发器 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs transition-colors',
          'hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-ring/60 ring-2 ring-ring/30',
        )}
      >
        {selected ? (
          <>
            <span className="min-w-0 truncate font-medium">
              {selected.label || selected.id}
            </span>
            <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {selected.model}
            </code>
          </>
        ) : emptyOptionLabel && (value === '' || value == null) ? (
          <span className="truncate text-muted-foreground">
            {emptyOptionLabel}
          </span>
        ) : (
          <span className="truncate text-muted-foreground">{placeholder}</span>
        )}
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* 下拉面板 */}
      {open && (
        <div
          role="listbox"
          className={cn(
            'absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-lg border bg-popover shadow-lg',
            'animate-in fade-in-0 zoom-in-95 duration-100',
          )}
        >
          {/* 搜索框 */}
          <div className="flex items-center gap-2 border-b px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveIdx(0)
              }}
              onKeyDown={handleKeyDown}
              placeholder="搜索名称或模型 id…"
              className="h-5 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setQuery('')
                  setActiveIdx(0)
                  searchRef.current?.focus()
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* 选项列表 */}
          <div className="max-h-60 overflow-y-auto scrollbar-thin p-1">
            {items.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                没有匹配「{query.trim()}」的模型
              </p>
            )}
            {items.map((p, idx) => {
              const active = idx === activeIdx
              const isSelected = p.id === (value ?? '')
              return (
                <button
                  key={p.id || '__empty__'}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(p.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    active && 'bg-accent',
                    isSelected && 'font-medium',
                  )}
                >
                  {p.isEmpty ? (
                    <span className="truncate text-muted-foreground">
                      {p.label}
                    </span>
                  ) : (
                    <>
                      <span className="min-w-0 truncate">
                        {p.label || p.id}
                      </span>
                      {p.unregistered ? (
                        <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                          未注册 · 选用即添加
                        </span>
                      ) : (
                        <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {p.model}
                        </code>
                      )}
                      {p.enabled === false && !p.unregistered && (
                        <span className="shrink-0 text-[10px] text-destructive">
                          已停用
                        </span>
                      )}
                    </>
                  )}
                  {isSelected && (
                    <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default SearchableModelSelect
