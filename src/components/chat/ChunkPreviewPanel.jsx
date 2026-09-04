import * as React from 'react'
import {
  Scissors,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Merge,
  Flag,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * ChunkScoreBadge —— 切片质量评分徽标（ChunkPreviewPanel 与 DocPreviewDialog 共用）。
 *
 * level: good(≥80 绿) / fair(60-79 黄) / poor(<60 红)；hover 显示扣分原因。
 */
export function ChunkScoreBadge({ score, level, issues }) {
  if (!Number.isFinite(Number(score))) return null
  const cls =
    level === 'good'
      ? 'border-emerald-600/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
      : level === 'fair'
        ? 'border-amber-600/20 bg-amber-500/10 text-amber-600 dark:text-amber-300'
        : 'border-rose-600/20 bg-rose-500/10 text-rose-600 dark:text-rose-300'
  const tip =
    Array.isArray(issues) && issues.length ? issues.join('；') : '无质量问题'
  return (
    <Badge
      variant="outline"
      className={cn('!px-1.5 !py-0.5 text-[11px] tabular-nums', cls)}
      title={`质量评分 ${score}/100：${tip}`}
    >
      {score}
    </Badge>
  )
}

/**
 * ChunkPreviewPanel —— 文档处理智能体的切片预览面板。
 *
 * 与 SearchProcessPanel 对称：消费后端 `engine: 'doc-processor'` 的 search_results 注解，
 * 把切片结果以"块 N · 字数 | heading + 内容预览"卡片形式展示。
 *
 * 卡片默认折叠（仅显示 header：块号 + heading + 字数徽章），点击展开看完整片段。
 * 每块携带质量评分（score/level/issues）时显示彩色评分徽标，展开可见扣分原因。
 *
 * 操作按钮（可选）：
 *  传入 onAdjust 时，每块下方渲染「合并到上一块」「标记问题块」两个按钮。
 *  按钮不直接改数据，只把**自然语言调整指令**交给 onAdjust（由调用方决定怎么发，
 *  例如作为一条用户消息发给 /api/chat，后端 doc-processor 分支用
 *  parseAdjustmentInstruction 解析后走 adjust）。这样避免本面板与 useChat 的流式状态竞争。
 *  不传 onAdjust 时（如 StreamingMessage 中的纯展示场景）不渲染任何按钮，行为与之前一致。
 *
 * @param {Object} props
 * @param {Array}  props.annotations  useChat message.annotations 或 runtimeAnnotations（已过滤为 doc-processor 引擎）
 * @param {(instruction:string)=>void} [props.onAdjust]  切片调整指令回调；不传则面板为纯只读展示
 */
export function ChunkPreviewPanel({ annotations, onAdjust }) {
  const docAnns = React.useMemo(
    () =>
      (annotations || []).filter(
        (a) =>
          a &&
          typeof a === 'object' &&
          a.type === 'search_results' &&
          a.engine === 'doc-processor',
      ),
    [annotations],
  )

  const [open, setOpen] = React.useState(false)

  if (!docAnns.length) return null

  const totalChunks = docAnns.reduce(
    (s, a) => s + (a.total ?? a.results?.length ?? 0),
    0,
  )
  const totalChars = docAnns.reduce(
    (s, a) => s + (a.results || []).reduce((ss, r) => ss + (r.chars ?? 0), 0),
    0,
  )
  // 整体均分：取最新一批注解携带的 avgScore（老注解无此字段则不显示）
  const avgScore =
    docAnns.length > 0 ? docAnns[docAnns.length - 1].avgScore : undefined

  return (
    <div className="mb-3 w-full overflow-hidden rounded-xl border border-border bg-card/60 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-accent/40"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          {open ? (
            <Scissors className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <span className="font-medium text-foreground/80">
            {open ? '隐藏切片预览' : '显示切片预览'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="gap-1 !px-2 !py-0.5 text-[11px]"
          >
            <Scissors className="h-3 w-3" />
            切片 {totalChunks} 块
          </Badge>
          <Badge
            variant="outline"
            className="!px-2 !py-0.5 text-[11px] tabular-nums"
          >
            {totalChars.toLocaleString()} 字
          </Badge>
          {Number.isFinite(Number(avgScore)) && (
            <ChunkScoreBadge
              score={avgScore}
              level={avgScore >= 80 ? 'good' : avgScore >= 60 ? 'fair' : 'poor'}
              issues={['整体均分']}
            />
          )}
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/60 bg-muted/30">
          {docAnns.map((a, i) => {
            const results = a.results || []
            return (
              <div
                key={`doc-chunk-${i}`}
                className={cn(
                  i < docAnns.length - 1 && 'border-b border-border/40',
                )}
              >
                {results.map((r, ri) => (
                  <ChunkCard
                    key={r.id ?? r.rank ?? `${i}-${r.title}`}
                    r={r}
                    prevRank={ri > 0 ? results[ri - 1]?.rank : undefined}
                    onAdjust={onAdjust}
                  />
                ))}
              </div>
            )
          })}

          <div className="flex items-center justify-between border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              {onAdjust
                ? '可用下方按钮调整，也可直接说"合并第2、3块" / "拆分第5块" / "入库"。'
                : '确认无误后说"入库"，或说"合并第2、3块" / "拆分第5块"调整。'}
            </span>
            <span>共 {totalChunks} 块</span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 单个切片卡片
 * @param {Object} props
 * @param {Object} props.r                      切片数据（rank / heading / chars / text / 上下文）
 * @param {number} [props.prevRank]             同一批结果中上一块的块号（1-based）；无则不可合并
 * @param {(instruction:string)=>void} [props.onAdjust] 调整指令回调；不传则不渲染操作按钮
 */
function ChunkCard({ r, prevRank, onAdjust }) {
  const [open, setOpen] = React.useState(false)
  const [flagged, setFlagged] = React.useState(false)
  const full = (r.text || r.snippet || '').trim()
  const preview =
    full.length > 150
      ? full.slice(0, 150).replace(/\n+/g, ' ').trim() + '…'
      : full.replace(/\n+/g, ' ').trim()

  const canAdjust = typeof onAdjust === 'function'
  const rank = r.rank ?? 0
  const canMerge =
    canAdjust && Number.isFinite(Number(prevRank)) && Number(prevRank) > 0

  // 指令文案与后端 parseAdjustmentInstruction 支持的自然语言格式保持一致
  const handleMerge = () => {
    if (!canMerge) return
    onAdjust(`合并第 ${Number(prevRank)}、${rank} 块`)
  }

  const handleFlag = () => {
    setFlagged((v) => !v)
    onAdjust(`第 ${rank} 块有问题，请重新处理该块`)
  }

  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              第 {r.rank} 块
            </span>
            {r.heading && (
              <Badge variant="outline" className="!px-1.5 !py-0.5 text-[11px]">
                {r.heading}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1">
              <ChunkScoreBadge
                score={r.score}
                level={r.level}
                issues={r.issues}
              />
              <Badge
                variant="secondary"
                className="!px-1.5 !py-0.5 text-[11px] tabular-nums"
              >
                {(r.chars ?? 0).toLocaleString()} 字
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

      {canAdjust && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={!canMerge}
            title={
              canMerge
                ? `把第 ${rank} 块合并到第 ${prevRank} 块`
                : '第一块没有上一块可合并'
            }
            onClick={handleMerge}
          >
            <Merge className="h-3 w-3" />
            合并到上一块
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 gap-1 px-2 text-[11px]',
              flagged && 'text-destructive hover:text-destructive',
            )}
            onClick={handleFlag}
          >
            <Flag className="h-3 w-3" />
            {flagged ? '已标记问题' : '标记问题块'}
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-2 border-t border-border/50 pt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
          {full || '（无片段内容）'}
          {Array.isArray(r.issues) && r.issues.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-600/20 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <span className="font-medium">质量提示：</span>
              {r.issues.join('；')}
            </div>
          )}
          {(r.preContext || r.postContext) && (
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground/80">
              {r.preContext && (
                <div>
                  <span className="font-medium">上文：</span>
                  {r.preContext}
                </div>
              )}
              {r.postContext && (
                <div>
                  <span className="font-medium">下文：</span>
                  {r.postContext}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ChunkPreviewPanel
