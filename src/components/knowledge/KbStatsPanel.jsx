import * as React from 'react'
import {
  Files,
  Layers,
  Library,
  MessageSquare,
  HelpCircle,
  Activity,
  TriangleAlert,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** 从 "openai-compatible:qwen2.5-coder:14b" 里取出模型名 */
function modelName(str) {
  if (!str) return '未配置'
  if (/^stub|unconfigured/i.test(str)) return '未配置'
  const parts = String(str).split(':')
  return parts.length > 1 ? parts.slice(1).join(':') : str
}

/**
 * KbStatsPanel —— 知识库总览 + 系统健康
 *
 * 数据来源：/api/health（由 useDocumentStats 提供 stats）。
 * 三块：系统健康状态条（连接 + 一致性告警）· KPI 卡片 · 分类分布条形图。
 *
 * @param {Object} props
 * @param {boolean} [props.loading]
 * @param {Object} props.stats
 */
export function KbStatsPanel({ stats, loading }) {
  const docsN = Number(stats?.documents ?? 0)
  const chkN = Number(stats?.chunks ?? 0)
  const cats = Array.isArray(stats?.byCategory) ? stats.byCategory : []
  const maxCatDocs = cats.reduce((m, c) => Math.max(m, Number(c.count ?? 0)), 0)
  const maxCatChunks = cats.reduce(
    (m, c) => Math.max(m, Number(c.chunks ?? 0)),
    0,
  )
  const sessionsN = Number(stats?.sessions?.totalSessions ?? 0)
  const messagesN = Number(stats?.sessions?.totalMessages ?? 0)
  const questionsN = Number(stats?.questions ?? 0)
  const orphansN = Number(stats?.orphanDocuments ?? 0)

  return (
    <div className="flex flex-col gap-4">
      {/* ===== 系统健康状态条 ===== */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center gap-1.5 text-sm font-medium">
            <Activity className="h-4 w-4 text-muted-foreground" />
            系统状态
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill
              ok={!loading && !/unconfigured/i.test(stats?.llm || '')}
              label="LLM"
              value={loading ? '检测中…' : modelName(stats?.llm)}
            />
            <StatusPill
              ok={!loading && !/unconfigured/i.test(stats?.embedding || '')}
              label="Embedding"
              value={loading ? '检测中…' : modelName(stats?.embedding)}
            />
            {/* 数据一致性：孤儿文档告警（status=indexed 但 0 切片） */}
            {orphansN > 0 ? (
              <StatusPill
                ok={false}
                tone="warn"
                label="数据一致性"
                value={`${orphansN} 篇缺切片`}
              />
            ) : (
              <StatusPill
                ok
                label="数据一致性"
                value="正常"
              />
            )}
          </div>
          {orphansN > 0 && !loading && (
            <p className="mt-2.5 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              检测到 {orphansN} 篇文档标记为已入库但没有切片（多为存储重启后未落盘丢失）。可在「文档管理」打开该文档编辑后保存，或调用 reconcile 接口用存量正文重新切片修复。
            </p>
          )}
        </CardContent>
      </Card>

      {/* ===== KPI 卡片 ===== */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={<Files className="h-4 w-4 text-primary" />}
          label="文档总数"
          value={loading ? '—' : docsN.toLocaleString('zh-CN')}
          hint="已入库可检索文档"
        />
        <StatCard
          icon={<Layers className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />}
          label="切片总数"
          value={loading ? '—' : chkN.toLocaleString('zh-CN')}
          hint={docsN > 0 ? `每文档 ≈ ${Math.round(chkN / docsN)} 块` : '向量索引单元'}
        />
        <StatCard
          icon={<Library className="h-4 w-4 text-violet-600 dark:text-violet-500" />}
          label="分类数"
          value={loading ? '—' : cats.length}
          hint="含「未分类」兜底"
        />
        <StatCard
          icon={<MessageSquare className="h-4 w-4 text-sky-600 dark:text-sky-500" />}
          label="会话数"
          value={loading ? '—' : sessionsN.toLocaleString('zh-CN')}
          hint={messagesN > 0 ? `${messagesN.toLocaleString('zh-CN')} 条消息` : '对话上下文'}
        />
        <StatCard
          icon={<HelpCircle className="h-4 w-4 text-amber-600 dark:text-amber-500" />}
          label="题库条目"
          value={loading ? '—' : questionsN.toLocaleString('zh-CN')}
          hint="结构化面试题"
        />
      </div>

      {/* ===== 分类分布条形图 ===== */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              分类分布
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/80" />
                文档
              </span>
              <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/70" />
                切片
              </span>
            </div>
            {loading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {!loading && cats.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                暂无分类数据，上传或手动录入第一篇知识即可看到分布。
              </p>
            ) : (
              cats.map((c) => {
                const docCount = Number(c.count ?? 0)
                const chkCount = Number(c.chunks ?? 0)
                const docPct = maxCatDocs ? (docCount / maxCatDocs) * 100 : 0
                const chkPct = maxCatChunks
                  ? (chkCount / maxCatChunks) * 100
                  : 0
                return (
                  <div
                    key={c.name}
                    className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/40"
                  >
                    <div className="w-28 shrink-0 truncate text-sm font-medium">
                      {c.name}
                    </div>
                    <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-muted/60">
                      <div
                        className="absolute inset-x-0 top-1/2 h-1/2 rounded-full bg-emerald-500/45"
                        style={{ width: `${Math.min(100, chkPct)}%` }}
                      />
                      <div
                        className="absolute inset-x-0 top-0 h-1/2 rounded-full bg-primary/70"
                        style={{ width: `${Math.min(100, docPct)}%` }}
                      />
                    </div>
                    <div className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      <span className="text-foreground/90">{docCount}</span>
                      {' 篇 · '}
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {chkCount}
                      </span>
                      {' 块'}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** 状态胶囊：绿=正常 / 琥珀=告警 / 灰=未知 */
function StatusPill({ ok, label, value, tone = 'bad' }) {
  const state = ok ? 'ok' : tone
  const styles = {
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    bad: 'border-border/60 bg-secondary/50 text-muted-foreground',
  }[state]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        styles,
      )}
    >
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : state === 'warn' ? (
        <TriangleAlert className="h-3.5 w-3.5" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
      )}
      <span className="opacity-70">{label}</span>
      <span className="max-w-[16rem] truncate">{value}</span>
    </span>
  )
}

function StatCard({ icon, label, value, hint }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div
          className={cn(
            'text-2xl font-semibold tabular-nums tracking-tight',
            value === '—' && 'text-muted-foreground',
          )}
        >
          {value}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  )
}

export default KbStatsPanel
