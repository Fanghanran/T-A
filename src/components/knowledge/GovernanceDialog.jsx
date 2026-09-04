import * as React from 'react'
import {
  ArrowRight,
  FolderInput,
  Loader2,
  Merge,
  AlertCircle,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { renameCategory, mergeTags } from '@/lib/knowledgeApi'
import { cn } from '@/lib/utils'

/**
 * GovernanceDialog —— 分类 / 标签聚合治理
 *
 * 解决"分类和标签越用越乱"的收敛问题，两个操作均为一次性全库批量：
 *  1. 分类重命名：POST /categories/rename { from, to }（to='' 并入「未分类」）
 *     作用于该分类下全部文档及其所有切片的 category 字段。
 *  2. 标签合并：POST /tags/merge { from: string[], to }（来源标签可多选，合并为一个目标标签）
 *     来源标签从所有文档上移除并补上目标标签。
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(v:boolean)=>void} props.onOpenChange
 * @param {Array<{name:string,count:number}>} props.categories 现有分类 facets
 * @param {Array<{name:string,count:number}>} props.tags 现有标签 facets
 * @param {()=>void} [props.onChanged] 治理完成回调（父级刷新 facets / 列表 / 统计）
 */
export function GovernanceDialog({
  open,
  onOpenChange,
  categories = [],
  tags = [],
  onChanged,
}) {
  // —— 分类重命名 ——
  const [catFrom, setCatFrom] = React.useState('')
  const [catTo, setCatTo] = React.useState('')
  // —— 标签合并 ——
  const [tagFrom, setTagFrom] = React.useState(() => new Set())
  const [tagTo, setTagTo] = React.useState('')

  const [busy, setBusy] = React.useState('')
  const [done, setDone] = React.useState('') // 操作成功提示
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (!open) {
      setCatFrom('')
      setCatTo('')
      setTagFrom(new Set())
      setTagTo('')
      setBusy('')
      setDone('')
      setError('')
    }
  }, [open])

  const toggleTagFrom = (name) => {
    setTagFrom((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleRename = async () => {
    if (!catFrom || busy) return
    setBusy('rename')
    setError('')
    setDone('')
    try {
      const r = await renameCategory(catFrom, catTo.trim())
      setDone(
        `分类「${catFrom}」已${catTo.trim() ? `重命名为「${catTo.trim()}」` : '并入「未分类」'}，影响 ${r.renamed} 篇文档`,
      )
      setCatFrom('')
      setCatTo('')
      onChanged?.()
    } catch (e) {
      setError(e?.message || '分类重命名失败')
    } finally {
      setBusy('')
    }
  }

  const handleMerge = async () => {
    if (tagFrom.size === 0 || !tagTo.trim() || busy) return
    const from = [...tagFrom]
    setBusy('merge')
    setError('')
    setDone('')
    try {
      const r = await mergeTags(from, tagTo.trim())
      setDone(
        `已把 ${from.join('、')} 合并为「${tagTo.trim()}」，影响 ${r.merged} 篇文档`,
      )
      setTagFrom(new Set())
      setTagTo('')
      onChanged?.()
    } catch (e) {
      setError(e?.message || '标签合并失败')
    } finally {
      setBusy('')
    }
  }

  const selectClass = cn(
    'h-9 w-full rounded-md border border-input bg-background px-2 text-sm',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>分类 / 标签治理</DialogTitle>
        <DialogDescription>
          一次性全库批量收敛：重命名分类、合并重复标签。操作会同步更新所有受影响文档及其切片。
        </DialogDescription>

        {done && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>{done}</span>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* —— 分类重命名 —— */}
        <section className="rounded-md border p-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <FolderInput className="h-3.5 w-3.5 text-muted-foreground" />
            分类重命名
          </h4>
          <div className="flex items-center gap-2">
            <select
              className={selectClass}
              value={catFrom}
              onChange={(e) => setCatFrom(e.target.value)}
              aria-label="选择原分类"
            >
              <option value="">选择原分类…</option>
              {categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}（{c.count}）
                </option>
              ))}
            </select>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={catTo}
              onChange={(e) => setCatTo(e.target.value)}
              placeholder="新名称（留空并入未分类）"
              maxLength={50}
              aria-label="新分类名"
            />
            <Button
              type="button"
              size="sm"
              className="h-9 shrink-0"
              onClick={handleRename}
              disabled={!catFrom || !!busy}
            >
              {busy === 'rename' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              重命名
            </Button>
          </div>
        </section>

        {/* —— 标签合并 —— */}
        <section className="rounded-md border p-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <Merge className="h-3.5 w-3.5 text-muted-foreground" />
            标签合并（可多选来源）
          </h4>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {tags.length === 0 && (
              <span className="text-[11px] text-muted-foreground">
                暂无标签
              </span>
            )}
            {tags.map((t) => {
              const active = tagFrom.has(t.name)
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTagFrom(t.name)}
                  disabled={!!busy}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  {t.name}（{t.count}）
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {tagFrom.size} 个来源
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={tagTo}
              onChange={(e) => setTagTo(e.target.value)}
              placeholder="合并后的目标标签"
              maxLength={20}
              aria-label="目标标签"
            />
            <Button
              type="button"
              size="sm"
              className="h-9 shrink-0"
              onClick={handleMerge}
              disabled={tagFrom.size === 0 || !tagTo.trim() || !!busy}
            >
              {busy === 'merge' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              合并
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}

export default GovernanceDialog
