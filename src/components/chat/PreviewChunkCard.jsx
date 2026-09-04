import * as React from 'react'
import {
  ChevronDown,
  ChevronUp,
  Merge,
  SplitSquareHorizontal,
  Loader2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChunkScoreBadge } from '@/components/chat/ChunkPreviewPanel'

/**
 * PreviewChunkCard —— 预览界面内的单块卡片（独立于聊天里的 ChunkCard：调整走 REST 而非聊天消息）。
 * @param {Object} props
 * @param {{ idx:number, heading:string, text:string, chars:number, preContext?:string, postContext?:string }} props.chunk
 * @param {number}  props.rank       块号（1-based）
 * @param {number}  [props.prevRank] 上一块块号；无则不可合并（第一块）
 * @param {boolean} props.adjusting  调整请求进行中（禁用按钮）
 * @param {(instruction:string)=>void} props.onAdjust
 */
export function PreviewChunkCard({ chunk, rank, prevRank, adjusting, onAdjust }) {
  const [open, setOpen] = React.useState(false)
  const full = (chunk.text || '').trim()
  const preview =
    full.length > 160
      ? full.slice(0, 160).replace(/\n+/g, ' ').trim() + '…'
      : full.replace(/\n+/g, ' ').trim()
  const canMerge = Number.isFinite(Number(prevRank)) && Number(prevRank) > 0

  return (
    <div className="px-5 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              第 {rank} 块
            </span>
            {chunk.heading && (
              <Badge variant="outline" className="!px-1.5 !py-0.5 text-[11px]">
                {chunk.heading}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1">
              <ChunkScoreBadge
                score={chunk.score}
                level={chunk.level}
                issues={chunk.issues}
              />
              <Badge
                variant="secondary"
                className="!px-1.5 !py-0.5 text-[11px] tabular-nums"
              >
                {(chunk.chars || 0).toLocaleString()} 字
              </Badge>
            </div>
          </div>
          <div className="text-[12px] leading-relaxed text-muted-foreground line-clamp-2">
            {preview || '（无内容预览）'}
          </div>
        </div>
        <div className="pt-0.5 text-muted-foreground">
          {open ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>

      {/* 调整按钮（REST 直调，结果实时刷新） */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={!canMerge || adjusting}
          title={
            canMerge
              ? `把第 ${rank} 块合并到第 ${prevRank} 块`
              : '第一块没有上一块可合并'
          }
          onClick={() => onAdjust(`合并第 ${prevRank}、${rank} 块`)}
        >
          <Merge className="h-3 w-3" />
          合并到上一块
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          disabled={adjusting}
          title={`把第 ${rank} 块从中点拆成两块`}
          onClick={() => onAdjust(`拆分第 ${rank} 块`)}
        >
          <SplitSquareHorizontal className="h-3 w-3" />
          拆分此块
        </Button>
        {adjusting && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>

      {open && (
        <div className="mt-2 border-t border-border/50 pt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
          {full || '（无片段内容）'}
          {Array.isArray(chunk.issues) && chunk.issues.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-600/20 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <span className="font-medium">质量提示：</span>
              {chunk.issues.join('；')}
            </div>
          )}
          {(chunk.preContext || chunk.postContext) && (
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground/80">
              {chunk.preContext && (
                <div>
                  <span className="font-medium">上文：</span>
                  {chunk.preContext}
                </div>
              )}
              {chunk.postContext && (
                <div>
                  <span className="font-medium">下文：</span>
                  {chunk.postContext}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default PreviewChunkCard
