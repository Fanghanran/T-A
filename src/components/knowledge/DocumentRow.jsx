import { FileText, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from './Checkbox'
import { ChunkScoreBadge } from '@/components/chat/ChunkPreviewPanel'
import { cn } from '@/lib/utils'
import { formatSize, formatDate } from '@/lib/documentListUtils'

/** 单行文档条目 */
export function DocumentRow({
  doc,
  active,
  removing,
  selected,
  hasBatch,
  onSelect,
  onEdit,
  onDelete,
  onToggleSelectId,
  batchLoading,
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(doc.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.(doc.id)
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-primary/40 bg-primary/[0.06] shadow-soft'
          : selected
            ? 'border-emerald-400/60 bg-emerald-50/40 dark:bg-emerald-950/20'
            : 'border-transparent hover:border-border/70 hover:bg-accent/40',
        removing && 'opacity-50 pointer-events-none',
      )}
    >
      {/* 激活刻度线（与侧边栏同语言） */}
      {active && (
        <span className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
      )}
      <div className="flex items-start gap-2">
        {hasBatch && (
          <div
            className="mt-0.5 shrink-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={() => onToggleSelectId?.(doc.id)}
              disabled={batchLoading}
            />
          </div>
        )}
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{doc.title}</span>
        {Number.isFinite(Number(doc.avgScore)) && doc.avgScore > 0 && (
          <ChunkScoreBadge
            score={Math.round(doc.avgScore)}
            level={
              doc.avgScore >= 80 ? 'good' : doc.avgScore >= 60 ? 'fair' : 'poor'
            }
            issues={[`切片质量均分（启发式） · 共 ${doc.chunkCount ?? '?'} 块`]}
          />
        )}
        {/* 操作按钮常显（弱化 60% 透明度，hover 行时全显强调）——
            此前 opacity-0 需悬停才出现，用户看不到以为按钮丢失 */}
        <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          {onEdit && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onEdit(doc)
              }}
              aria-label="编辑文档"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(doc.id)
              }}
              aria-label="删除文档"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {(doc.category || doc.tags?.length) && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-1',
            hasBatch ? 'pl-8' : 'pl-6',
          )}
        >
          {doc.category && (
            <Badge variant="secondary" className="text-[10px]">
              {doc.category}
            </Badge>
          )}
          {doc.tags?.slice(0, 3).map((t) => (
            <Badge
              key={t}
              variant="outline"
              className="text-[10px] text-muted-foreground"
            >
              {t}
            </Badge>
          ))}
        </div>
      )}

      {(doc.size || doc.uploadedAt) && (
        <div
          className={cn(
            'flex items-center gap-2 text-[11px] text-muted-foreground',
            hasBatch ? 'pl-8' : 'pl-6',
          )}
        >
          {doc.size != null && <span>{formatSize(doc.size)}</span>}
          {doc.uploadedAt && (
            <>
              <span>·</span>
              <span>{formatDate(doc.uploadedAt)}</span>
            </>
          )}
          {doc.chunkCount != null && (
            <>
              <span>·</span>
              <span>{doc.chunkCount} 块切片</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
