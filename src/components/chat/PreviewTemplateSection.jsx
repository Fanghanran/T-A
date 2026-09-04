import * as React from 'react'
import { Loader2, BookmarkPlus, X, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  listTemplates,
  saveTemplate,
  deleteTemplate,
} from '@/lib/docProcessorApi'
import { cn } from '@/lib/utils'

/**
 * PreviewTemplateSection —— 预览对话框底部的处理模板区
 * 模板列表（点击套用 / 批量套用到全部 / 悬停删除）+ 保存当前参数为新模板。
 * 模板保存 strategy + maxChars（可选）；套用后按模板参数重新切片。
 *
 * @param {Object} props
 * @param {string} props.docId
 * @param {boolean} props.open       对话框开启时才加载模板列表
 * @param {boolean} props.adjusting
 * @param {number} [props.docCount]  文档总数；>1 时展示「批量套用」入口
 * @param {(tpl:object)=>void} props.onApply
 * @param {(tpl:object)=>void} [props.onApplyAll]
 */
export function PreviewTemplateSection({
  docId,
  open,
  adjusting,
  docCount = 1,
  onApply,
  onApplyAll,
}) {
  const [templates, setTemplates] = React.useState([])
  const [showForm, setShowForm] = React.useState(false)
  const [name, setName] = React.useState('')
  const [strategy, setStrategy] = React.useState('semantic')
  const [maxChars, setMaxChars] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState('')

  const refresh = React.useCallback(async () => {
    try {
      setTemplates(await listTemplates())
      setErr('')
    } catch (e) {
      setErr(e.message || '模板加载失败')
    }
  }, [])

  React.useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setErr('')
    try {
      const mc = parseInt(maxChars, 10)
      await saveTemplate({
        name: trimmed,
        strategy,
        ...(Number.isFinite(mc) && mc >= 100 && mc <= 5000
          ? { maxChars: mc }
          : {}),
      })
      setName('')
      setMaxChars('')
      setShowForm(false)
      await refresh()
    } catch (e) {
      setErr(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (e, tpl) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await deleteTemplate(tpl.id)
      await refresh()
    } catch (er) {
      setErr(er.message || '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-border bg-muted/30 px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          处理模板：
        </span>
        {templates.length === 0 && !showForm && (
          <span className="text-[11px] text-muted-foreground/70">
            暂无，可把常用切片参数存为模板
          </span>
        )}
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            disabled={adjusting || busy}
            className={cn(
              'group inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] transition hover:border-primary/40 hover:bg-accent',
              (adjusting || busy) && 'cursor-not-allowed opacity-60',
            )}
            title={`套用模板：${tpl.strategy}${tpl.maxChars ? ` · maxChars=${tpl.maxChars}` : ''}（按此参数重新切片）`}
            onClick={() => onApply(tpl)}
          >
            {tpl.name}
            <span className="text-muted-foreground/60">
              · {tpl.strategy === 'delimiter' ? '分隔符' : '语义'}
              {tpl.maxChars ? ` ${tpl.maxChars}` : ''}
            </span>
            {docCount > 1 && (
              <Layers
                className="h-3 w-3 text-muted-foreground/40 opacity-0 transition group-hover:opacity-100 hover:text-primary"
                title={`把该模板统一套用到全部 ${docCount} 份文档（统一策略处理）`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!adjusting && !busy) onApplyAll?.(tpl)
                }}
              />
            )}
            <X
              className="h-3 w-3 text-muted-foreground/40 opacity-0 transition group-hover:opacity-100 hover:text-destructive"
              onClick={(e) => handleDelete(e, tpl)}
            />
          </button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 gap-1 px-2 text-[11px]"
          disabled={busy || adjusting}
          onClick={() => setShowForm((v) => !v)}
        >
          <BookmarkPlus className="h-3 w-3" />
          存为模板
        </Button>
      </div>

      {showForm && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="模板名称（同名覆盖）"
            className="h-7 w-44 text-xs"
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          />
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="semantic">语义切片</option>
            <option value="delimiter">分隔符切片</option>
          </select>
          <Input
            value={maxChars}
            onChange={(e) => setMaxChars(e.target.value.replace(/\D/g, ''))}
            placeholder="maxChars（可选）"
            className="h-7 w-36 text-xs"
            inputMode="numeric"
          />
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={busy || !name.trim()}
            onClick={handleSave}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            保存
          </Button>
        </div>
      )}

      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
    </div>
  )
}

export default PreviewTemplateSection
