import * as React from 'react'
import { FileSearch, ChevronDown, ChevronRight, Target, Lightbulb, HelpCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ChunkScoreBadge } from './ChunkPreviewPanel'
import { cn } from '@/lib/utils'

function level(score) {
  const n = Number(score)
  if (!Number.isFinite(n)) return 'fair'
  return n >= 80 ? 'good' : n >= 60 ? 'fair' : 'poor'
}

function issues(levelTag) {
  return { 高: 'destructive', 中: 'amber', 低: 'muted' }[levelTag] || 'muted'
}

/**
 * ResumeReportPanel —— 简历分析报告卡片（type: 'resume_report'）
 * 消费 annotation.report：overall / summary / sections / jdMatch / interviewQuestions / suggestions
 */
export function ResumeReportPanel({ annotations }) {
  const reports = (annotations || []).filter((a) => a?.type === 'resume_report')
  const [openQ, setOpenQ] = React.useState(false)
  if (reports.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {reports.map((a, ai) => {
        const r = a.report || {}
        const sections = Array.isArray(r.sections) ? r.sections : []
        const suggestions = Array.isArray(r.suggestions) ? r.suggestions : []
        const questions = Array.isArray(r.interviewQuestions) ? r.interviewQuestions : []
        const hasJd = r.jdMatch && typeof r.jdMatch === 'object'
        return (
          <Card key={ai} className="overflow-hidden">
            <CardContent className="p-0">
              {/* 头部：标题 + 总评分 */}
              <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                <FileSearch className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">简历分析报告</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">总评</span>
                  <ChunkScoreBadge score={r.overall} level={level(r.overall)} issues={['综合评估']} />
                </div>
              </div>

              <div className="flex flex-col gap-3 p-4">
                {r.summary && (
                  <p className="text-sm leading-relaxed text-foreground/90">{r.summary}</p>
                )}

                {/* JD 匹配 */}
                {hasJd && (
                  <div className="rounded-lg border border-border/60 bg-secondary/30 p-3">
                    <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
                      <Target className="h-3.5 w-3.5 text-primary" />
                      岗位 JD 匹配
                      <span className="ml-auto"><ChunkScoreBadge score={r.jdMatch.score} level={level(r.jdMatch.score)} issues={['匹配度']} /></span>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-[11px] text-muted-foreground">命中项</p>
                        <ul className="flex flex-col gap-1">
                          {(r.jdMatch.matched || []).map((m, i) => (
                            <li key={i} className="flex gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                              <span>✓</span>
                              <span className="text-foreground/80">{m}</span>
                            </li>
                          ))}
                          {!(r.jdMatch.matched || []).length && <li className="text-xs text-muted-foreground">—</li>}
                        </ul>
                      </div>
                      <div>
                        <p className="mb-1 text-[11px] text-muted-foreground">差距项</p>
                        <ul className="flex flex-col gap-1">
                          {(r.jdMatch.gaps || []).map((g, i) => (
                            <li key={i} className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                              <span>•</span>
                              <span className="text-foreground/80">{g}</span>
                            </li>
                          ))}
                          {!(r.jdMatch.gaps || []).length && <li className="text-xs text-muted-foreground">—</li>}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* 分节 */}
                {sections.map((s, i) => (
                  <div key={i}>
                    <p className="mb-1.5 text-[13px] font-medium">{s.title}</p>
                    <ul className="flex flex-col gap-1 pl-1">
                      {(s.items || []).map((it, j) => (
                        <li key={j} className="flex gap-2 text-[13px] text-muted-foreground">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                          <span>{it}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {/* 基于简历的面试题（可折叠） */}
                {questions.length > 0 && (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-[13px]"
                      onClick={() => setOpenQ((v) => !v)}
                    >
                      {openQ ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      <HelpCircle className="h-3.5 w-3.5 text-primary" />
                      面试官可能追问（{questions.length}）
                    </Button>
                    {openQ && (
                      <ul className="mt-1 flex flex-col gap-1.5">
                        {questions.map((q, i) => (
                          <li key={i} className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
                            <span className="font-medium text-foreground/90">{q.q}</span>
                            {q.why && <span className="mt-0.5 block text-muted-foreground">考察：{q.why}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* 改进建议 */}
                {suggestions.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
                      <Lightbulb className="h-3.5 w-3.5 text-amber-500" /> 改进建议
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {suggestions.map((s, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <Badge variant={issues(s.level) === 'destructive' ? 'destructive' : 'outline'} className="shrink-0 px-1.5 py-0 text-[10px]">
                            {s.level || '中'}
                          </Badge>
                          <div>
                            <span className="text-foreground/90">{s.issue}</span>
                            {s.fix && <span className="ml-1 text-muted-foreground">→ {s.fix}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
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

export default ResumeReportPanel
