import { TriangleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * ConfirmDialog —— 通用确认弹窗（替代 window.confirm）
 *
 * 可样式化、支持焦点陷阱、Enter 确认 / Escape 取消、屏幕阅读器友好。
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(open:boolean)=>void} props.onOpenChange
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {string} [props.confirmLabel] 默认「确认」
 * @param {boolean} [props.destructive] 危险操作（红色确认键 + 警示图标）
 * @param {()=>void} props.onConfirm
 * @param {boolean} [props.submitting] 请求进行中禁用按钮
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  destructive = false,
  onConfirm,
  submitting = false,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="space-y-1.5">
          <DialogTitle className="flex items-center gap-2 text-base">
            {destructive && (
              <TriangleAlert className="h-4 w-4 text-destructive" />
            )}
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="text-xs whitespace-pre-line">
              {description}
            </DialogDescription>
          )}
        </div>
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
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={submitting}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ConfirmDialog
