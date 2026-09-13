import * as React from 'react'
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { generateSessionReport, getSessionReport } from '@/lib/sessionApi'

/**
 * SessionReportDialog —— 会话复盘报告（LLM 聚合会话消息与逐题评分）
 *
 * 打开时先读已存报告；无则展示「生成」按钮（生成是一次 LLM 调用，约数秒）。
 * 报告为结构化 JSON：overall / topics / strengths / weaknesses / suggestions / perTurn。
 */
export function SessionReportDialog({ sessionId, open, onOpenChange }) {
  const [loading, setLoading] = React.useState(false)
  const [generating, setGenerating] = React.useState(false)
  const [report, setReport] = React.useState(null)
  const [createdAt, setCreatedAt] = React.useState('')
  const [error, setError] = React.useState('')
  const [notFound, setNotFound] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!sessionId || !open) return
    setLoading(true)
    setError('')
    setNotFound(false)
    setReport(null)
    try {
      const r = await getSessionReport(sessionId)
      setReport(r.report ?? null)
      setCreatedAt(r.createdAt ?? '')
    } catch (err) {
      if (err?.status === 404) setNotFound(true)
      else setError(err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [sessionId, open])

  React.useEffect(() => {
    if (open) load()
  }, [open, load])

  const generate = async () => {
    setError('')
    setGenerating(true)
    try {
      const r = await generateSessionReport(sessionId)
      setReport(r.report ?? null)
      setCreatedAt(r.createdAt ?? new Date().toISOString())
      setNotFound(false)
    } catch (err) {
      setError(err?.message || '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  const List = ({ title, items, tone = '' }) =>
    items?.length ? (
      <div className="mb-3">
        <p className="mb-1 text-xs font-semibold text-muted-foreground">{title}</p>
        <ul className={`list-disc space-y-1 pl-4 text-sm ${tone}`}>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </div>
    ) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogTitle>会话复盘报告</DialogTitle>
        <DialogDescription>
          基于【会话消息 + 逐题质量评分】的 LLM 聚合复盘，仅供备考参考。
        </DialogDescription>

        {loading && (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}

        {!loading && notFound && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            该会话还没有复盘报告。
          </div>
        )}

        {!loading && report && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 p-3 leading-relaxed">{report.overall}</div>
            {report.topics?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {report.topics.map((t, i) => (
                  <Badge key={i} variant="secondary" className="text-[11px]">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
            <List title="做得好的" items={report.strengths} />
            <List title="薄弱点" items={report.weaknesses} tone="text-amber-600 dark:text-amber-400" />
            <List title="改进建议" items={report.suggestions} />
            {report.perTurn?.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">逐题点评</p>
                <div className="space-y-1.5">
                  {report.perTurn.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-md border px-2 py-1.5">
                      <Badge
                        variant="outline"
                        className={`shrink-0 px-1.5 py-0 text-[10px] ${
                          p.grade === '好'
                            ? 'border-emerald-500/40 text-emerald-600'
                            : p.grade === '差'
                              ? 'border-destructive/40 text-destructive'
                              : ''
                        }`}
                      >
                        {p.grade}
                      </Badge>
                      <span className="flex-1 text-xs">{p.question}</span>
                      <span className="text-xs text-muted-foreground">{p.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="mt-2 flex items-center justify-between sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            {createdAt ? `生成于 ${new Date(createdAt).toLocaleString()}` : ''}
          </span>
          <div className="flex gap-2">
            {notFound && !loading && (
              <Button type="button" size="sm" onClick={generate} disabled={generating}>
                {generating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                生成复盘
              </Button>
            )}
            {!notFound && report && (
              <Button type="button" size="sm" variant="outline" onClick={generate} disabled={generating}>
                {generating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                重新生成
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SessionReportDialog
