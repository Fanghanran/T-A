import {
  Award,
  CheckCircle2,
  TriangleAlert,
  ClipboardCheck,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { ChunkScoreBadge } from './ChunkPreviewPanel'
import { cn } from '@/lib/utils'

function level(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return 'fair'
  return n >= 80 ? 'good' : n >= 60 ? 'fair' : 'poor'
}

/**
 * InterviewScorecardPanel —— 模拟面试评分卡（type: 'interview_scorecard'）
 * 消费 annotation.scores：overall / dimensions[{name,score,comment}] / highlights[] / improvements[] / verdict
 */
export function InterviewScorecardPanel({ annotations }) {
  const cards = (annotations || []).filter(
    (a) => a?.type === 'interview_scorecard',
  )
  if (cards.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {cards.map((a, ai) => {
        const s = a.scores || {}
        const dims = Array.isArray(s.dimensions) ? s.dimensions : []
        const highlights = Array.isArray(s.highlights) ? s.highlights : []
        const improvements = Array.isArray(s.improvements) ? s.improvements : []
        return (
          <Card key={ai} className="overflow-hidden">
            <CardContent className="p-0">
              <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                <ClipboardCheck className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">模拟面试评分报告</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    综合
                  </span>
                  <ChunkScoreBadge
                    score={s.overall}
                    level={level(s.overall)}
                    issues={['综合评分']}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-3 p-4">
                {/* 维度评分 */}
                {dims.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {dims.map((d, i) => {
                      const val = Number(d.score ?? 0)
                      return (
                        <div key={i} className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 text-[13px]">
                            <span className="font-medium">{d.name}</span>
                            <span className="ml-auto tabular-nums text-muted-foreground">
                              {d.score}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all',
                                level(d.score) === 'good'
                                  ? 'bg-emerald-500'
                                  : level(d.score) === 'fair'
                                    ? 'bg-amber-500'
                                    : 'bg-rose-500',
                              )}
                              style={{
                                width: `${Math.min(100, Math.max(0, val))}%`,
                              }}
                            />
                          </div>
                          {d.comment && (
                            <p className="text-xs text-muted-foreground">
                              {d.comment}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* 亮点 / 改进 */}
                {(highlights.length > 0 || improvements.length > 0) && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {highlights.length > 0 && (
                      <div>
                        <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" /> 表现亮点
                        </p>
                        <ul className="flex flex-col gap-1">
                          {highlights.map((h, i) => (
                            <li key={i} className="text-xs text-foreground/80">
                              · {h}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {improvements.length > 0 && (
                      <div>
                        <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-amber-700 dark:text-amber-400">
                          <TriangleAlert className="h-3.5 w-3.5" /> 改进建议
                        </p>
                        <ul className="flex flex-col gap-1">
                          {improvements.map((im, i) => (
                            <li key={i} className="text-xs text-foreground/80">
                              · {im}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* 结论 */}
                {s.verdict && (
                  <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 p-3 text-[13px]">
                    <Award className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="text-foreground/90">{s.verdict}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

export default InterviewScorecardPanel
