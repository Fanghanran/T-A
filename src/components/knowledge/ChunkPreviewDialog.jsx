import * as React from 'react'
import { Check, X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * ChunkPreviewDialog —— 上传前切片预览弹窗
 *
 * 展示后端 /preview-chunks 返回的 chunk 列表，让用户在点「上传」前确认切片效果。
 * 每个 chunk 一行：序号徽章 + heading + 正文前 200 字（超出省略）+ 上下文（semantic 模式有值）。
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {()=>void} props.onClose
 * @param {Array<{idx:number, heading?:string, text:string, chars:number, preContext?:string, postContext?:string}>} [props.chunks]
 * @param {number} [props.total]
 * @param {'semantic'|'delimiter'} [props.strategy]
 * @param {string} [props.error]         预览失败时展示的错误信息
 */
export function ChunkPreviewDialog({
  open,
  onClose,
  chunks,
  total,
  strategy,
  error,
}) {
  const list = Array.isArray(chunks) ? chunks : []
  const count = Number.isFinite(total) ? total : list.length
  const showContext = strategy !== 'delimiter'

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>切片预览 · 共 {count} 块</DialogTitle>
        <DialogDescription>
          以下为按当前策略切分的切片结果，确认无误后返回点「上传」正式入库。
        </DialogDescription>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : list.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            暂无切片数据
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {list.map((c, i) => (
              <div
                key={c.idx ?? i}
                className="rounded-lg border border-border/70 bg-background p-3 text-xs shadow-xs"
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <Badge
                    variant="secondary"
                    className="gap-1 !px-1.5 !py-0.5 text-[11px]"
                  >
                    <FileText className="h-3 w-3" />第 {(c.idx ?? i) + 1} 块
                  </Badge>
                  <Badge
                    variant="outline"
                    className="!px-1.5 !py-0.5 text-[11px] tabular-nums"
                  >
                    {c.chars ?? (c.text?.length || 0)} 字
                  </Badge>
                  {c.heading && (
                    <span className="truncate text-[12px] font-medium text-foreground/80">
                      {c.heading}
                    </span>
                  )}
                </div>

                <div className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                  {truncate(c.text, 200)}
                </div>

                {showContext && (c.preContext || c.postContext) && (
                  <div className="mt-1.5 flex flex-col gap-1 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground/80">
                    {c.preContext && (
                      <div>
                        <span className="font-medium">上文：</span>
                        {truncate(c.preContext, 120)}
                      </div>
                    )}
                    {c.postContext && (
                      <div>
                        <span className="font-medium">下文：</span>
                        {truncate(c.postContext, 120)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            <X className="mr-1.5 h-4 w-4" />
            关闭
          </Button>
          <Button type="button" onClick={onClose} disabled={!!error}>
            <Check className="mr-1.5 h-4 w-4" />
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function truncate(s, n) {
  const text = typeof s === 'string' ? s : ''
  if (text.length <= n) return text
  return text.slice(0, n) + '…'
}

export default ChunkPreviewDialog
