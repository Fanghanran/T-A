import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_TAG_OPTIONS } from '@/lib/constants'
import { cn } from '@/lib/utils'

/**
 * UploadMetaFields —— 上传对话框的元数据区：分类 / 标签 / ⑤ 检索增强问题开关。
 * 纯受控组件：值与回调来自 useUploadForm。
 *
 * @param {Object} props
 * @param {string} props.category
 * @param {(v:string)=>void} props.onCategoryChange
 * @param {string[]} props.tags
 * @param {(v:string[]|((prev:string[])=>string[]))=>void} props.onTagsChange 支持函数式更新（移除标签）
 * @param {string} props.tagInput
 * @param {(v:string)=>void} props.onTagInputChange
 * @param {(v:string)=>void} props.onAddTag 回车添加（去重逻辑在 hook 的 addTag）
 * @param {boolean} props.withQuestions
 * @param {(v:boolean)=>void} props.onWithQuestionsChange
 * @param {boolean} [props.disabled] 批量上传进行中禁用输入
 */
export function UploadMetaFields({
  category,
  onCategoryChange,
  tags,
  onTagsChange,
  tagInput,
  onTagInputChange,
  onAddTag,
  withQuestions,
  onWithQuestionsChange,
  disabled = false,
}) {
  const selectClass = cn(
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  )

  return (
    <>
      {/* 分类 */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">分类</span>
        <select
          value={category}
          onChange={(e) => onCategoryChange(e.target.value)}
          className={selectClass}
          disabled={disabled}
        >
          <option value="">不选择</option>
          {KNOWLEDGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {/* 标签 */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">标签</span>
        <div
          className={cn(
            'flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm',
            'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
          )}
        >
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pr-1 text-xs">
              {t}
              <button
                type="button"
                onClick={() => onTagsChange((prev) => prev.filter((x) => x !== t))}
                className="rounded-full p-0.5 hover:bg-foreground/10"
                aria-label={`移除 ${t}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <input
            value={tagInput}
            onChange={(e) => onTagInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onAddTag(tagInput)
              }
            }}
            list="kb-tag-options"
            placeholder={tags.length ? '' : '回车添加标签…'}
            className="flex-1 min-w-[80px] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
            disabled={disabled}
          />
          <datalist id="kb-tag-options">
            {KNOWLEDGE_TAG_OPTIONS.filter((o) => !tags.includes(o)).map(
              (o) => (
                <option key={o} value={o} />
              ),
            )}
          </datalist>
        </div>
      </div>

      {/* ⑤ 检索增强问题开关 */}
      <label className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5"
          checked={withQuestions}
          onChange={(e) => onWithQuestionsChange(e.target.checked)}
          disabled={disabled}
        />
        <span className="flex flex-col">
          <span className="text-xs font-medium">生成检索增强问题</span>
          <span className="text-[11px] text-muted-foreground">
            为每块生成 3
            个「用户可能会问的问题」提升召回（面试题库建议开启）；关闭可省一次
            LLM 调用、加快入库。
          </span>
        </span>
      </label>
    </>
  )
}

export default UploadMetaFields
