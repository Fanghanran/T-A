import * as React from 'react'
import {
  Copy,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  AlertCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { scanDuplicates, deleteDuplicateChunks } from '@/lib/knowledgeApi'
import { cn } from '@/lib/utils'

/**
 * DuplicatesDialog —— 库内查重（存量切片两两相似度扫描 + 重复对清理）
 *
 * 与入库时去重互补：入库只拦「新块 vs 已有块」，本弹窗回答「库里哪些块是重复的」。
 * 判定口径与入库去重共用阈值（跨文档 cos≥0.985 / 同文档 cos≥0.96）。
 *
 * 交互：
 *  - 「开始扫描」→ POST /duplicates/scan（默认最多 800 块，超出按最新截断）
 *  - 每对默认勾选「删除 b 保留 a」（a 为块号靠前的一方），可手动改勾 a
 *  - 「删除选中的 N 块」→ POST /duplicates/delete，成功后自动重扫
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(v:boolean)=>void} props.onOpenChange
 * @param {()=>void} [props.onCleaned] 清理完成回调（父级刷新列表/统计）
 */
export function DuplicatesDialog({ open, onOpenChange, onCleaned }) {
  const [scanning, setScanning] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [error, setError] = React.useState('')
  // 待删除的 chunkId 集合
  const [marked, setMarked] = React.useState(() => new Set())
  // 删除前二次确认（替代 window.confirm）
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    setScanning(true)
    setError('')
    try {
      const r = await scanDuplicates()
      setResult(r)
      // 默认勾选每对的 b（保留 a）
      setMarked(new Set(r.pairs.map((p) => p.b.chunkId).filter(Boolean)))
    } catch (e) {
      setError(e?.message || '扫描失败，请稍后重试')
    } finally {
      setScanning(false)
    }
  }, [])

  React.useEffect(() => {
    if (open && !result && !scanning) load()
    if (!open) {
      setResult(null)
      setMarked(new Set())
      setError('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleMark = (chunkId) => {
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(chunkId)) next.delete(chunkId)
      else next.add(chunkId)
      return next
    })
  }

  /** 工具栏「删除选中」→ 先弹确认 */
  const handleDelete = () => {
    if (marked.size === 0 || deleting) return
    setConfirmOpen(true)
  }

  /** 确认后执行真实删除 */
  const handleConfirmDelete = async () => {
    setConfirmOpen(false)
    if (marked.size === 0 || deleting) return
    setDeleting(true)
    setError('')
    try {
      await deleteDuplicateChunks([...marked])
      onCleaned?.()
      await load()
    } catch (e) {
      setError(e?.message || '删除失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  const pairs = result?.pairs ?? []

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>库内查重</DialogTitle>
          <DialogDescription>
            扫描库内存量切片的两两相似度，发现并清理历史重复块（入库去重只拦新块，存量重复需在此清理）。
          </DialogDescription>

          {/* 工具行：扫描按钮 + 统计 */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={load}
              disabled={scanning || deleting}
            >
              {scanning ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {scanning ? '扫描中…' : result ? '重新扫描' : '开始扫描'}
            </Button>
            {result && (
              <>
                <Badge variant="secondary" className="text-[10px]">
                  扫描 {result.scanned}/{result.total} 块 · {result.ms}ms
                </Badge>
                <Badge
                  variant={result.pairTotal > 0 ? 'destructive' : 'outline'}
                  className="text-[10px]"
                >
                  {result.pairTotal} 对重复
                </Badge>
                {result.truncated && (
                  <span
                    className="text-[11px] text-muted-foreground"
                    title="按最新入库截断，可后端调大 maxChunks"
                  >
                    已截断（仅扫最新 {result.scanned} 块）
                  </span>
                )}
              </>
            )}
            {marked.size > 0 && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="ml-auto"
                onClick={handleDelete}
                disabled={scanning || deleting}
              >
                {deleting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                删除选中的 {marked.size} 块
              </Button>
            )}
          </div>
  
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
  
          {/* 结果区 */}
          <ScrollArea className="max-h-[50vh] min-h-[120px] rounded-md border p-2 scrollbar-thin">
            {pairs.length === 0 ? (
              <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-1.5 text-sm text-muted-foreground">
                {scanning ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    正在两两比对向量…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-6 w-6 text-emerald-500" />
                    {result
                      ? '未发现重复切片，知识库很干净。'
                      : '点击「开始扫描」检查库内重复切片。'}
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {pairs.map((p, i) => (
                  <DuplicatePair
                    key={`${p.a?.chunkId}-${p.b?.chunkId}-${i}`}
                    pair={p}
                    marked={marked}
                    onToggle={toggleMark}
                    disabled={deleting}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
  
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={deleting}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        destructive
        title="删除重复切片"
        description={`确定删除选中的 ${marked.size} 块重复切片吗？\n（向量索引同步移除，不可撤销）`}
        confirmLabel="确认删除"
        onConfirm={handleConfirmDelete}
        submitting={deleting}
      />
    </>
  )
}

/** 单个重复对：相似度徽标 + a/b 两侧卡片（各带勾选框，勾中的将被删除） */
function DuplicatePair({ pair, marked, onToggle, disabled }) {
  const scopeLabel = pair.scope === 'within' ? '同一文档' : '跨文档'
  return (
    <div className="rounded-md border p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        <Badge
          variant="destructive"
          className="px-1.5 py-0 text-[10px] tabular-nums"
        >
          相似 {(pair.sim * 100).toFixed(1)}%
        </Badge>
        <Badge
          variant="outline"
          className="px-1.5 py-0 text-[10px] text-muted-foreground"
        >
          {scopeLabel}
        </Badge>
        <span className="ml-auto text-[10px] text-muted-foreground">
          勾选要删除的一侧，保留另一侧
        </span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <SideCard
          side={pair.a}
          checked={marked.has(pair.a?.chunkId)}
          onToggle={onToggle}
          disabled={disabled}
        />
        <SideCard
          side={pair.b}
          checked={marked.has(pair.b?.chunkId)}
          onToggle={onToggle}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

/** 重复对中的一侧块摘要（chunkId / 块号 / heading / 片段预览 + 删除勾选） */
function SideCard({ side, checked, onToggle, disabled }) {
  if (!side) return null
  const title = side.heading?.trim() || `块 #${(side.idx ?? 0) + 1}`
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded border p-2 transition-colors',
        checked
          ? 'border-destructive/50 bg-destructive/5'
          : 'border-input hover:bg-accent/40',
        disabled && 'pointer-events-none opacity-60',
      )}
      title={`chunkId: ${side.chunkId}`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 accent-[hsl(var(--destructive))]"
        checked={!!checked}
        onChange={() => onToggle(side.chunkId)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{title}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            #{(side.idx ?? 0) + 1}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
          {side.snippet || '（无内容预览）'}
        </p>
      </div>
    </label>
  )
}

export default DuplicatesDialog
