import * as React from 'react'
import { TriangleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * BatchPromptDialog —— 批量操作输入 / 确认弹窗
 *
 * 替代原 window.prompt() / window.confirm()：可样式化、支持焦点陷阱、
 * 屏幕阅读器友好（DialogTitle 关联 + Enter 提交 + Escape 取消）。
 *
 * 支持模式：
 *   setCategory — 输入新分类名（留空 = 清空分类）
 *   addTags     — 输入追加标签（逗号 / 顿号 / 空白分隔）
 *   removeTag   — 输入要移除的标签（单次 1 个）
 *   delete      — 纯确认（删除 N 篇文档）
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(open:boolean)=>void} props.onOpenChange
 * @param {'setCategory'|'addTags'|'removeTag'|'delete'} props.mode
 * @param {number} props.count 选中文档数（delete 模式文案用）
 * @param {(value:string)=>void} props.onConfirm 确认回调（delete 模式收到 ''）
 * @param {boolean} [props.submitting]
 */
export function BatchPromptDialog({
  open,
  onOpenChange,
  mode,
  count = 0,
  onConfirm,
  submitting,
}) {
  const [value, setValue] = React.useState('')

  // 每次打开重置输入，避免上次的残留值
  React.useEffect(() => {
    if (open) setValue('')
  }, [open, mode])

  const cfg = CONFIG[mode] ?? CONFIG.setCategory
  const isDelete = mode === 'delete'

  const handleConfirm = () => {
    if (isDelete) {
      onConfirm('')
    } else {
      const trimmed = value.trim()
      if (mode === 'setCategory') {
        // 分类允许留空（= 清空分类）
        onConfirm(trimmed)
      } else if (mode === 'addTags') {
        const list = trimmed.split(/[,，、\s]+/).filter(Boolean)
        if (list.length) onConfirm(list.join(','))
      } else {
        if (trimmed) onConfirm(trimmed)
      }
    }
  }

  const submitDisabled =
    submitting || (isDelete ? false : mode === 'removeTag' && !value.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="space-y-1.5">
          <DialogTitle className="flex items-center gap-2 text-base">
            {isDelete && <TriangleAlert className="h-4 w-4 text-destructive" />}
            {cfg.title}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isDelete
              ? `确定删除已选中的 ${count} 篇文档吗？包括它们的所有切片与向量索引，不可撤销。`
              : cfg.hint}
          </DialogDescription>
        </div>

        {!isDelete && (
          <Input
            autoFocus
            value={value}
            placeholder={cfg.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConfirm()
            }}
            aria-label={cfg.title}
          />
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant={isDelete ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={submitDisabled}
          >
            {isDelete ? '确认删除' : '应用'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CONFIG = {
  setCategory: {
    title: '批量改分类',
    hint: '将同时写入每个选中文档及对应所有切片的 category。留空 = 清空分类。',
    placeholder: '例如：前端',
  },
  addTags: {
    title: '批量加标签',
    hint: '多个用英文逗号或中文顿号分隔，每个选中文档最多保留 10 个标签，重复会自动跳过。',
    placeholder: '例如：面试题, 性能优化',
  },
  removeTag: {
    title: '批量去标签',
    hint: '单次移除 1 个标签。',
    placeholder: '例如：待审核',
  },
  delete: { title: '批量删除确认', hint: '', placeholder: '' },
}
