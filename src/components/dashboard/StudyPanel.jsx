import * as React from 'react'
import { GraduationCap, Loader2, Flame, Star, MessageSquare, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { request } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * StudyPanel —— 学习进度与薄弱项（功能 3，数据源 /api/study/stats）
 *
 * 仪表盘卡片：统计概览（会话/提问/收藏/平均分）+ 近 14 天提问活跃条 +
 * 薄弱项（低分回答的 issue 标签 Top6 + 最近低分问题 Top5）+ 按智能体分布。
 */
export function StudyPanel() {
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await request('/api/study/stats'))
    } catch (err) {
      setError(err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const Chip = ({ icon: Ic, label, value, hint }) => (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5">
      <Ic className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold tabular-nums">
          {value ?? '-'}
          {hint && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{hint}</span>}
        </p>
      </div>
    </div>
  )

  // 近 14 天活跃：按日期对齐补零画条
  const activityBars = (() => {
    const days = []
    const byDay = new Map((data?.activity ?? []).map((a) => [a.day, a.count]))
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      days.push({ day: d, count: byDay.get(d) ?? 0 })
    }
    const max = Math.max(1, ...days.map((d) => d.count))
    return { days, max }
  })()

  return (
    <Card className="mb-6">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GraduationCap className="h-4 w-4 text-primary" />
          学习概览
        </CardTitle>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          刷新
        </Button>
      </CardHeader>
      <CardContent>
        {loading && !data && (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载学习统计…
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {data && (
          <div className="grid gap-4 md:grid-cols-2">
            {/* 左：统计 + 活跃 */}
            <div>
              <div className="grid grid-cols-2 gap-2">
                <Chip icon={MessageSquare} label="提问总数" value={data.messages} hint={`${data.sessions} 个会话`} />
                <Chip icon={Flame} label="回答平均分" value={data.avgScore} hint={data.evaluatedCount ? `已评 ${data.evaluatedCount} 次` : '暂无评分'} />
                <Chip icon={Star} label="错题本收藏" value={data.favorites} />
                <Chip icon={GraduationCap} label="学习开始于" value={data.startedAt ? new Date(data.startedAt).toLocaleDateString('zh-CN') : '-'} />
              </div>
              <div className="mt-3 rounded-lg border bg-card p-3">
                <p className="mb-2 text-[11px] text-muted-foreground">近 14 天提问活跃</p>
                <div className="flex h-16 items-end gap-1">
                  {activityBars.days.map((d) => (
                    <div
                      key={d.day}
                      title={`${d.day}：${d.count} 次提问`}
                      className={cn(
                        'flex-1 rounded-sm',
                        d.count > 0 ? 'bg-primary/70' : 'bg-muted',
                      )}
                      style={{ height: `${d.count > 0 ? Math.max(12, (d.count / activityBars.max) * 100) : 4}%` }}
                    />
                  ))}
                </div>
              </div>
              {(data.byAgent ?? []).length > 0 && (
                <div className="mt-3 rounded-lg border bg-card p-3">
                  <p className="mb-1.5 text-[11px] text-muted-foreground">按智能体分布</p>
                  <div className="space-y-1">
                    {data.byAgent.slice(0, 5).map((a) => (
                      <div key={a.agentName} className="flex items-center justify-between text-xs">
                        <span className="truncate text-muted-foreground">{a.agentName}</span>
                        <span className="tabular-nums">{a.messages} 条消息 · {a.sessions} 会话</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 右：薄弱项 */}
            <div className="rounded-lg border bg-card p-3">
              <p className="mb-2 text-[11px] text-muted-foreground">薄弱项（低分回答归纳）</p>
              {data.topIssues.length === 0 && data.lowQuestions.length === 0 && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  暂无薄弱记录 —— 继续提问，系统会自动评估每次回答的质量。
                </p>
              )}
              {data.topIssues.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {data.topIssues.map((t) => (
                    <span key={t.label} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                      {t.label} ×{t.count}
                    </span>
                  ))}
                </div>
              )}
              {data.lowQuestions.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground">最近低分问题</p>
                  {data.lowQuestions.map((q, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                        {q.score}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.question}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default StudyPanel
