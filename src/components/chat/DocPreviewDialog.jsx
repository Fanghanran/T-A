import * as React from 'react'
import { Scissors, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { previewDoc, adjustDoc, applyTemplate, applyTemplateBatch } from '@/lib/docProcessorApi'
import { ChunkScoreBadge } from '@/components/chat/ChunkPreviewPanel'
import { PreviewChunkCard } from './PreviewChunkCard'
import { PreviewTemplateSection } from './PreviewTemplateSection'
import { cn } from '@/lib/utils'

/**
 * DocPreviewDialog —— 文档处理智能体的独立切片预览界面。
 *
 * 「预览切片」按钮打开的大尺寸对话框：加载当前切片（含已做过的调整），
 * 每块卡片可展开看全文，并提供结构化调整按钮：
 *  - 合并到上一块 / 拆分此块：直调 REST /api/doc-processor/adjust，
 *    结果实时刷新（与聊天里的自然语言调整共享同一份服务端缓存）
 *  - 「重新加载」：从服务端重新拉取当前切片（同步聊天侧做的调整）
 *
 * 子组件：单块卡片见 PreviewChunkCard；底部模板区见 PreviewTemplateSection。
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(v:boolean)=>void} props.onOpenChange
 * @param {string} props.docId   当前文档 id
 * @param {string} props.title   文档标题（对话框标题展示）
 * @param {(instruction:string, result:{ totalChunks:number, totalChars:number })=>void} [props.onAdjusted]
 *   调整成功后的回报回调（ChatPage 用它 append 一条 opReport 消息，让对话里出现 LLM 简要总结 + 卡片）
 */
export function DocPreviewDialog({
  open,
  onOpenChange,
  docId,
  title,
  docs,
  onAdjusted,
}) {
  const [loading, setLoading] = React.useState(false)
  const [adjusting, setAdjusting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [chunks, setChunks] = React.useState([])
  const [totalChars, setTotalChars] = React.useState(0)
  const [avgScore, setAvgScore] = React.useState(undefined)

  const load = React.useCallback(async () => {
    if (!docId) return
    setLoading(true)
    setError('')
    try {
      const r = await previewDoc(docId)
      setChunks(r.chunks || [])
      setTotalChars(r.totalChars || 0)
      setAvgScore(r.avgScore)
    } catch (e) {
      setError(e.message || '加载切片失败')
      setChunks([])
    } finally {
      setLoading(false)
    }
  }, [docId])

  // 打开时加载
  React.useEffect(() => {
    if (open) load()
  }, [open, load])

  /** 应用调整指令并刷新列表 */
  const applyAdjust = async (instruction) => {
    if (!docId || adjusting) return
    setAdjusting(true)
    setError('')
    try {
      const r = await adjustDoc(docId, instruction)
      setChunks(r.chunks || [])
      setTotalChars(r.totalChars || 0)
      setAvgScore(r.avgScore)
      // 回报给对话：ChatPage append 一条 opReport 消息 → LLM 简要总结 + 切片卡片
      onAdjusted?.(instruction, {
        totalChunks: r.totalChunks,
        totalChars: r.totalChars,
      })
    } catch (e) {
      setError(e.message || '调整失败')
    } finally {
      setAdjusting(false)
    }
  }

  /** 套用模板：按模板参数重新切片（服务端缓存同步更新） */
  const handleApplyTemplate = async (tpl) => {
    if (!docId || adjusting) return
    setAdjusting(true)
    setError('')
    try {
      const r = await applyTemplate(docId, tpl.id)
      setChunks(r.chunks || [])
      setTotalChars(r.totalChars || 0)
      setAvgScore(r.avgScore)
      onAdjusted?.(`套用模板「${tpl.name}」`, {
        totalChunks: r.totalChunks,
        totalChars: r.totalChars,
      })
    } catch (e) {
      setError(e.message || '套用模板失败')
    } finally {
      setAdjusting(false)
    }
  }

  /** 批量套用模板（统一策略处理）：同一模板套用到全部文档，完成后刷新当前文档预览 */
  const handleApplyTemplateBatch = async (tpl) => {
    if (!docId || adjusting) return
    const allIds = (docs || []).map((d) => d.docId).filter(Boolean)
    if (allIds.length < 2) return
    setAdjusting(true)
    setError('')
    try {
      const r = await applyTemplateBatch(allIds, tpl.id)
      // 刷新当前文档的预览（缓存已被批量替换）
      const cur = (r.results || []).find((x) => x.docId === docId)
      const pv = await previewDoc(docId)
      setChunks(pv.chunks || [])
      setTotalChars(pv.totalChars || 0)
      setAvgScore(pv.avgScore)
      onAdjusted?.(`把模板「${tpl.name}」批量套用到全部 ${r.okCount} 份文档`, {
        totalChunks: cur?.totalChunks ?? pv.totalChunks,
        totalChars: cur?.totalChars ?? pv.totalChars,
      })
      if (r.failCount > 0) setError(`${r.failCount} 份文档套用失败`)
    } catch (e) {
      setError(e.message || '批量套用模板失败')
    } finally {
      setAdjusting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {/* 头部：标题 + 统计 + 刷新 */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5 pr-12">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Scissors className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">
                切片预览{title ? ` · ${title}` : ''}
              </span>
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              可用每块下方的按钮调整；调整结果与对话内指令互通，确认后回到操作栏点「入库」。
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {chunks.length > 0 && (
              <>
                <Badge
                  variant="secondary"
                  className="gap-1 !px-2 !py-0.5 text-[11px]"
                >
                  <Scissors className="h-3 w-3" />
                  {chunks.length} 块
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
                    level={
                      avgScore >= 80 ? 'good' : avgScore >= 60 ? 'fair' : 'poor'
                    }
                    issues={['整体均分']}
                  />
                )}
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={load}
              disabled={loading || adjusting}
              title="重新加载（同步对话侧调整）"
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
              />
            </Button>
          </div>
        </div>

        {/* 主体：切片列表（独立滚动） */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在切片…
            </div>
          ) : error ? (
            <div className="m-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : chunks.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              暂无切片数据
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {chunks.map((c, i) => (
                <PreviewChunkCard
                  key={`${c.idx}-${i}`}
                  chunk={c}
                  rank={i + 1}
                  prevRank={i > 0 ? i : undefined}
                  adjusting={adjusting}
                  onAdjust={applyAdjust}
                />
              ))}
            </div>
          )}
        </div>

        {/* 底部：处理模板（保存常用切片参数组合，一键套用 / 批量统一策略） */}
        <PreviewTemplateSection
          docId={docId}
          open={open}
          adjusting={adjusting}
          docCount={(docs || []).length}
          onApply={handleApplyTemplate}
          onApplyAll={handleApplyTemplateBatch}
        />
      </DialogContent>
    </Dialog>
  )
}

export default DocPreviewDialog
