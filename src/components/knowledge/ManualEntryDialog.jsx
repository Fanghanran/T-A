import * as React from 'react'
import { FileEdit, X, Loader2 } from 'lucide-react'
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

// 与 Input 组件风格一致的原生 textarea（项目尚未引入 shadcn/ui Textarea）
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
 * ManualEntryDialog —— 单条知识手动录入弹窗（C2）
 *
 * 受控组件：open/onOpenChange 由父组件控制，避免与 DialogTrigger 混写的复杂状态。
 *
 * 字段：
 * - title（必填）：标题（展示 + 检索引用）
 * - content（必填）：正文（支持 Markdown / 纯文本，后端会按换行与章节做切片）
 * - category（选填）：扁平字符串分类，可从预设选，可自定义
 * - tags[]（选填）：扁平字符串标签数组，回车追加，支持自定义
 * - source（选填）：来源备注（URL、书名、面试录音等）
 *
 * 提交流程：
 *   onSubmit(payload) => Promise<Object | null>
 *   - 成功：关闭弹窗；父组件负责刷新列表与分类/标签
 *   - 失败：保留表单（方便修正），错误由上层错误条展示（同上传/检索/删除逻辑）
 *
 * 联想建议：
 *   - category / tag 除了展示预设 KNOWLEDGE_CATEGORIES / KNOWLEDGE_TAG_OPTIONS，
 *     也会把 props 传入的 existingCategories / existingTags（已有文档统计值）合并进
 *     建议列表，满足 B1「扁平分类优先跑通、不做独立 CRUD、但能复用已有值」。
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(open:boolean)=>void} props.onOpenChange
 * @param {(payload: {title:string,content:string,category?:string,tags?:string[],source?:string}) => Promise<Object|null>} props.onSubmit
 * @param {boolean} props.submitting
 * @param {string[]} [props.existingCategories] 已有分类（合并进预设）
 * @param {string[]} [props.existingTags]       已有标签（合并进预设）
 */
export function ManualEntryDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  existingCategories = [],
  existingTags = [],
}) {
  const [title, setTitle] = React.useState('')
  const [content, setContent] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [categoryManual, setCategoryManual] = React.useState(false)
  const [tags, setTags] = React.useState([])
  const [tagInput, setTagInput] = React.useState('')
  const [source, setSource] = React.useState('')

  const reset = () => {
    setTitle('')
    setContent('')
    setCategory('')
    setCategoryManual(false)
    setTags([])
    setTagInput('')
    setSource('')
  }

  React.useEffect(() => {
    if (!open) reset()
  }, [open])

  // 合并已有 + 预设（去重保持顺序：已有优先，用户能看到「我最近在录的分类」）
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

  const canSubmit =
    title.trim().length > 0 && content.trim().length > 0 && !submitting
  const contentLen = content.length
  const warnLen = contentLen < 30

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    const payload = {
      title: title.trim(),
      content: content.trim(),
      category: category.trim() || undefined,
      tags: tags.length ? tags : undefined,
      source: source.trim() || undefined,
    }
    const result = await onSubmit(payload)
    if (result) {
      reset()
      onOpenChange(false)
    }
    // 失败：保留表单，由上层展示统一 error 条
  }

  const selectClass = cn(
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="flex items-center gap-2">
            <FileEdit className="h-4 w-4" />
            手动录入知识
          </DialogTitle>
          <DialogDescription>
            直接填写正文与元数据；保存后会自动切片进入向量库，供全局智能体检索。
          </DialogDescription>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
          {/* 标题 */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              标题 <span className="text-destructive">*</span>
            </span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：React useEffect 依赖数组最佳实践"
              maxLength={200}
              disabled={submitting}
            />
          </label>

          {/* 分类 + 来源 一行 */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                分类（扁平字符串，B1）
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
                placeholder="例如：github.com/xxx 或《面试圣经》第 3 章"
                maxLength={200}
                disabled={submitting}
              />
            </label>
          </div>

          {/* 标签 */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              标签（扁平字符串，回车添加，B1）
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
                    aria-label={`移除 ${t}`}
                    disabled={submitting}
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
                list="manual-tag-options"
                placeholder={tags.length ? '' : '回车添加标签…'}
                className="flex-1 min-w-[80px] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                disabled={submitting}
              />
              <datalist id="manual-tag-options">
                {tagSuggestions
                  .filter((o) => !tags.includes(o))
                  .map((o) => (
                    <option key={o} value={o} />
                  ))}
              </datalist>
            </div>
          </div>

          {/* 正文 */}
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>
                正文 <span className="text-destructive">*</span>
                {warnLen && (
                  <span className="ml-2 text-amber-600 dark:text-amber-400">
                    建议内容 ≥ 30 字，否则语义检索质量偏低
                  </span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {contentLen}
              </span>
            </span>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              placeholder={[
                '# React useEffect 依赖数组最佳实践',
                '',
                '1. 依赖数组里不要省略被用到的响应式变量，否则会形成闭包陷阱。',
                '2. 如果只想在挂载时跑一次，使用空数组 []，但要确认确实不需要任何响应式依赖。',
                '3. 函数依赖需要稳定引用时，把函数用 useCallback 包起来。',
                '',
                '…（继续写，换行 / 空行 / 标题会被后端切片作为独立索引单元）',
              ].join('\n')}
              className="resize-y min-h-[160px]"
              disabled={submitting}
            />
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <FileEdit className="mr-1.5 h-4 w-4" />
              )}
              {submitting ? '保存中…' : '保存入库'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default ManualEntryDialog
