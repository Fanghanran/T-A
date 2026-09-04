import * as React from 'react'
import { FileEdit, X, Loader2, Save, FileType } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_TAG_OPTIONS } from '@/lib/constants'
import { cn } from '@/lib/utils'

// 与 Input 组件风格一致的原生 textarea
function Textarea({ className, rows = 6, disabled, ...props }) {
  return (
    <textarea
      rows={rows}
      disabled={disabled}
      className={cn(
        'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Tabs（简易版，项目尚未引入 shadcn/ui Tabs，够用即可）
 */
function SimpleTabs({ tabs, value, onChange }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5">
      {tabs.map((t) => (
        <button
          type="button"
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            'rounded px-3 py-1 text-xs font-medium transition-colors',
            value === t.value
              ? 'bg-background shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/40',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/**
 * DocumentEditDialog —— 编辑文档弹窗
 *
 * 提供两个 Tab：
 * - "元数据"：改 title / category / tags / source（PATCH meta，不重切片、不重嵌入）
 * - "正文内容"：直接改 content（PATCH content，触发后端重切片 + 重嵌入向量）
 *
 * 受控 open/onOpenChange，initialDoc 必填。
 *
 * 成功：返回 updated doc；失败：保留表单，错误由上层统一错误条展示。
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(open:boolean)=>void} props.onOpenChange
 * @param {Object|null|undefined} props.initialDoc  被编辑的文档详情对象（含 content）
 * @param {(changes:{title?,category?,tags?,source?,content?},mode:'meta'|'content')=>Promise<Object|null>} props.onSubmit
 * @param {boolean} props.submitting
 * @param {string[]} [props.existingCategories]
 * @param {string[]} [props.existingTags]
 */
export function DocumentEditDialog({
  open,
  onOpenChange,
  initialDoc,
  onSubmit,
  submitting,
  existingCategories = [],
  existingTags = [],
}) {
  const [tab, setTab] = React.useState('meta')

  // —— 元数据字段 ——
  const [title, setTitle] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [categoryManual, setCategoryManual] = React.useState(false)
  const [tags, setTags] = React.useState([])
  const [tagInput, setTagInput] = React.useState('')
  const [source, setSource] = React.useState('')

  // —— 正文字段 ——
  const [content, setContent] = React.useState('')

  // 初始化：打开时用 initialDoc 回填
  React.useEffect(() => {
    if (!open) return
    setTab('meta')
    setTitle(initialDoc?.title ?? '')
    setCategory(initialDoc?.category ?? '')
    setCategoryManual(false)
    setTags(Array.isArray(initialDoc?.tags) ? [...initialDoc.tags] : [])
    setTagInput('')
    setSource(initialDoc?.source ?? '')
    setContent(initialDoc?.content ?? '')
  }, [open, initialDoc])

  const categoryOptions = React.useMemo(() => {
    const merged = []
    for (const c of existingCategories) if (!merged.includes(c)) merged.push(c)
    for (const c of KNOWLEDGE_CATEGORIES)
      if (!merged.includes(c)) merged.push(c)
    return merged
  }, [existingCategories])
  const tagSuggestions = React.useMemo(() => {
    const merged = []
    for (const t of existingTags) if (!merged.includes(t)) merged.push(t)
    for (const t of KNOWLEDGE_TAG_OPTIONS)
      if (!merged.includes(t)) merged.push(t)
    return merged
  }, [existingTags])

  const addTag = (v) => {
    const t = v.trim()
    if (!t || tags.includes(t)) return
    setTags((prev) => [...prev, t])
    setTagInput('')
  }

  // 比较 meta 与 initialDoc，只提交变更（避免后端把"相同字段"误判成脏写）
  const computeMetaPatch = () => {
    const patch = {}
    const nextTitle = title.trim()
    if (nextTitle && nextTitle !== (initialDoc?.title ?? ''))
      patch.title = nextTitle
    const nextCat = category.trim()
    if (nextCat !== (initialDoc?.category ?? '')) patch.category = nextCat
    const nextTags = tags.length ? [...tags] : []
    const prevTags = Array.isArray(initialDoc?.tags) ? [...initialDoc.tags] : []
    const sameTags =
      nextTags.length === prevTags.length &&
      nextTags.every((t, i) => t === prevTags[i])
    if (!sameTags) patch.tags = nextTags
    const nextSource = source.trim()
    if (nextSource !== (initialDoc?.source ?? '')) patch.source = nextSource
    return patch
  }

  const canSubmitMeta = React.useMemo(() => {
    if (submitting) return false
    const patch = computeMetaPatch()
    return (
      Object.keys(patch).length > 0 &&
      (patch.title === undefined || patch.title.length > 0)
    )
  }, [submitting, title, category, tags, source, initialDoc])

  const contentLen = content.length
  const contentChanged = content !== (initialDoc?.content ?? '')
  const canSubmitContent = !submitting && contentChanged && contentLen >= 10

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (tab === 'meta' && !canSubmitMeta) return
    if (tab === 'content' && !canSubmitContent) return
    let result = null
    if (tab === 'meta') {
      result = await onSubmit(computeMetaPatch(), 'meta')
    } else {
      result = await onSubmit({ content }, 'content')
    }
    if (result) onOpenChange(false)
  }

  const selectClass = cn(
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="flex items-center gap-2">
            <FileEdit className="h-4 w-4" />
            编辑文档
            {initialDoc?.title && (
              <span className="truncate text-xs text-muted-foreground font-normal">
                （{initialDoc.title}）
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            支持分别编辑「元数据」和「正文」。元数据保存只更新索引字段；保存正文会重新切片并重新嵌入向量（耗时更长）。
          </DialogDescription>
        </div>

        <div className="py-1">
          <SimpleTabs
            tabs={[
              { value: 'meta', label: '元数据' },
              { value: 'content', label: '正文内容' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 pt-1 max-h-[68vh] overflow-auto pr-1"
        >
          {tab === 'meta' && (
            <>
              {/* 标题 */}
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  标题 <span className="text-destructive">*</span>
                </span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  disabled={submitting}
                />
              </label>

              {/* 分类 + 来源 */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    分类（扁平字符串）
                  </span>
                  {categoryManual ? (
                    <div className="flex gap-2">
                      <Input
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="自定义分类名…"
                        maxLength={40}
                        disabled={submitting}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCategoryManual(false)}
                        disabled={submitting}
                      >
                        选预设
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className={selectClass}
                        disabled={submitting}
                      >
                        <option value="">不选择</option>
                        {categoryOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCategoryManual(true)}
                        disabled={submitting}
                      >
                        自定义
                      </Button>
                    </div>
                  )}
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    来源（选填）
                  </span>
                  <Input
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    maxLength={200}
                    disabled={submitting}
                  />
                </label>
              </div>

              {/* 标签 */}
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  标签（扁平字符串，回车添加）
                </span>
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm',
                    'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
                  )}
                >
                  {tags.map((t) => (
                    <Badge
                      key={t}
                      variant="secondary"
                      className="gap-1 pr-1 text-xs"
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() =>
                          setTags((prev) => prev.filter((x) => x !== t))
                        }
                        className="rounded-full p-0.5 hover:bg-foreground/10"
                        disabled={submitting}
                        aria-label={`移除 ${t}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addTag(tagInput)
                      }
                    }}
                    list="edit-tag-options"
                    placeholder={tags.length ? '' : '回车添加标签…'}
                    className="flex-1 min-w-[80px] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                    disabled={submitting}
                  />
                  <datalist id="edit-tag-options">
                    {tagSuggestions
                      .filter((o) => !tags.includes(o))
                      .map((o) => (
                        <option key={o} value={o} />
                      ))}
                  </datalist>
                </div>
              </div>
            </>
          )}

          {tab === 'content' && (
            <>
              <div className="flex items-center gap-1.5 rounded-md border border-amber-300/60 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <FileType className="h-3.5 w-3.5" />
                保存正文会重新解析章节、切分为多块，为每块重新生成向量并覆盖旧向量索引。
                建议完整调整后一次性保存，避免频繁重嵌入。
              </div>
              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span>
                    正文内容
                    {contentLen > 0 && contentLen < 30 && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">
                        建议 ≥ 30 字，否则检索质量偏低
                      </span>
                    )}
                    {!contentChanged && contentLen > 0 && (
                      <span className="ml-2 text-sky-600 dark:text-sky-400">
                        暂未修改
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {contentLen} 字
                  </span>
                </span>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={14}
                  placeholder="# 章节一\n\n正文正文正文…"
                  className="resize-y min-h-[240px] font-mono text-[13px] leading-relaxed"
                  disabled={submitting}
                />
              </label>
            </>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={tab === 'meta' ? !canSubmitMeta : !canSubmitContent}
            className="gap-1.5"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {submitting ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DocumentEditDialog
