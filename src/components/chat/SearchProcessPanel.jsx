import * as React from 'react'
import {
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * SearchProcessPanel —— 「👁 显示/隐藏运行过程」面板
 *
 * 支持多条 search_results 注解同时传入（例如面试题检索场景下：
 * annotations = [{engine:'structured-question-bank',...}, {engine:'knowledge-semantic',...}]），
 * 面板会按 engine 分块渲染各自的"已搜索 X 耗时"徽章、命中卡片列表或"未命中"提示。
 *
 * 每条命中用独立的 Recall slice N 卡片展示：
 *  - structured-question-bank：分类/难度/公司/Score 徽章 + 题目原文 + 答案预览（可展开）
 *  - knowledge-semantic：文件名/章节/Score 徽章 + 片段正文
 *
 * @param {Object} props
 * @param {Array}  props.annotations         useChat message.annotations 或 runtimeAnnotations
 */
export function SearchProcessPanel({ annotations }) {
  const searchAnns = React.useMemo(
    () =>
      (annotations || []).filter(
        (a) => a && typeof a === 'object' && a.type === 'search_results',
      ),
    [annotations],
  )

  const [open, setOpen] = React.useState(false) // 整个面板最外层默认收缩

  if (!searchAnns.length) return null

  // 汇总耗时（默认折叠标题右上角用"结构化题库 0.0s / 知识库 2.5s"太长；改为"X 个检索"）
  const totalSearchMs = searchAnns.reduce((s, a) => s + (a.searchMs || 0), 0)

  return (
    <div className="mb-3 w-full overflow-hidden rounded-xl border border-border bg-card/60 shadow-sm">
      {/* 折叠头部 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-accent/40"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          {open ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          <span className="font-medium text-foreground/80">
            {open ? '隐藏运行过程' : '显示运行过程'}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {searchAnns.map((a, i) => {
            const engine = a.engine || 'unknown'
            const label =
              engine === 'structured-question-bank'
                ? '结构化题库'
                : engine === 'knowledge-semantic'
                  ? '知识库'
                  : engine
            return (
              <Badge
                key={`${engine}-${i}`}
                variant="secondary"
                className="gap-1 !px-2 !py-0.5 text-[11px]"
              >
                <FileText className="h-3 w-3" />
                已搜索{label}
                <span className="text-muted-foreground">
                  {((a.searchMs || 0) / 1000).toFixed(1)}s
                </span>
              </Badge>
            )
          })}
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/60 bg-muted/30">
          {searchAnns.map((a, i) => (
            <EngineBlock
              key={`${a.engine ?? 'e'}-${i}`}
              ann={a}
              isLast={i === searchAnns.length - 1}
            />
          ))}

          {/* 整面板汇总 footer */}
          <div className="flex items-center justify-between border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              运行完毕{' '}
              <span className="font-semibold text-foreground/70">
                {(totalSearchMs / 1000).toFixed(1)}s
              </span>{' '}
              （合计检索 {searchAnns.length} 项）
            </span>
            <span>
              共命中{' '}
              <span className="font-semibold">
                {searchAnns.reduce(
                  (s, a) => s + ((a.total ?? a.results?.length) || 0),
                  0,
                )}
              </span>{' '}
              条
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function EngineBlock({ ann, isLast }) {
  const { engine = 'unknown', searchMs = 0, total = 0, results = [] } = ann

  const isQBank = engine === 'structured-question-bank'
  const engineLabel = isQBank
    ? '结构化题库'
    : engine === 'knowledge-semantic'
      ? '知识库'
      : engine
  const [engineOpen, setEngineOpen] = React.useState(false) // 引擎块也默认收缩（外层展开后才看到，点击 Chevron 再展开切片）

  return (
    <div className={cn(!isLast && 'border-b border-border/40')}>
      {/* engine 小标题 + 独立折叠按钮（整个引擎块可收缩） */}
      <button
        type="button"
        onClick={() => setEngineOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 pt-2.5 pb-1 text-left text-[11px] text-muted-foreground transition hover:bg-accent/30"
      >
        <div className="flex items-center gap-1.5">
          {engineOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary/70" />
          <span className="font-medium">检索引擎：{engineLabel}</span>
        </div>
        <span className="flex items-center gap-2">
          {(searchMs / 1000).toFixed(1)}s · 命中{' '}
          <span className="font-semibold text-foreground/80">
            {total ?? results.length}
          </span>{' '}
          条
        </span>
      </button>

      {engineOpen && results.length > 0 && (
        <div className="space-y-2 px-3 py-2.5">
          {results.map((r) => (
            <SliceCard
              key={r.id ?? r.rank ?? `${engine}-${r.title}`}
              engine={engine}
              r={r}
            />
          ))}
        </div>
      )}

      {engineOpen && results.length === 0 && (
        <div className="px-3 pb-2.5 pt-2 text-xs text-muted-foreground">
          {engineLabel === '结构化题库'
            ? '未命中任何结构化题库内容，试试换关键词或到"知识库"上传更详细的面经文档。'
            : engineLabel === '知识库'
              ? '知识库内暂时未命中相关片段，上传文档后可召回更多面经。'
              : '未命中任何内容，建议更换关键词。'}
        </div>
      )}
    </div>
  )
}

/* ---------- 内部：每条 Recall slice 卡片 ---------- */

function SliceCard({ engine, r }) {
  if (engine === 'structured-question-bank') return <QuestionSlice r={r} />
  return <FallbackSlice r={r} />
}

function difficultyBadge(difficulty) {
  switch (difficulty) {
    case '简单':
      return 'border-emerald-600/20 bg-emerald-500/10 text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300'
    case '困难':
      return 'border-rose-600/20 bg-rose-500/10 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300'
    case '中等':
    default:
      return 'border-amber-600/20 bg-amber-500/10 text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300'
  }
}

function scoreColor(score) {
  if (score >= 0.7)
    return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
  if (score >= 0.4) return 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
  return 'bg-muted text-muted-foreground'
}

function QuestionSlice({ r }) {
  const [open, setOpen] = React.useState(false) // 默认折叠：收缩状态只显示 header（Recall N + badges + 题目标题），绝对不展示答案预览片段文本

  return (
    <div className="rounded-lg border border-border/70 bg-background p-3 text-xs shadow-xs">
      {/* 可折叠 header：点击整行切换 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span className="font-semibold">Recall slice {r.rank}</span>
          </div>

          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge
              variant="secondary"
              className="!px-1.5 !py-0.5 text-[11px] font-medium"
            >
              {r.category || '未分类'}
            </Badge>

            <Badge
              className={cn(
                '!px-1.5 !py-0.5 text-[11px] border',
                difficultyBadge(r.difficulty),
              )}
            >
              {r.difficulty || '中等'}
            </Badge>

            {(r.company || []).slice(0, 3).map((c) => (
              <Badge
                key={c}
                variant="outline"
                className="!px-1.5 !py-0.5 text-[11px]"
              >
                {c}
              </Badge>
            ))}

            <div className="ml-auto flex items-center gap-1">
              {r.source && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                  {r.source}
                </span>
              )}
              <Badge
                className={cn(
                  '!px-1.5 !py-0.5 text-[11px] tabular-nums',
                  scoreColor(r.score),
                )}
              >
                Score: {(r.score * 100).toFixed(2)}
              </Badge>
            </div>
          </div>

          <div className="text-[13px] font-medium leading-snug text-foreground/90">
            {r.title}
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

      {/* 展开后才显示答案详情；收缩态完全不显示任何切片内容/预览 */}
      {open && (
        <div className="mt-2 border-t border-border/50 pt-2 text-[12px] leading-relaxed text-muted-foreground">
          <div className="whitespace-pre-wrap">
            {r.answer || '（无参考答案）'}
          </div>
          {r.analysis && (
            <div className="mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
              <span className="font-medium">要点提示：</span>
              {r.analysis}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* 知识库语义检索 Recall 卡片：默认收缩，收缩态只显示 header（Recall N + 文件名/章节/Score 徽章），完全不展示 snippet 预览文本 */
function FallbackSlice({ r }) {
  const [open, setOpen] = React.useState(false) // 默认收缩，点击才展开看完整片段
  const full = (r.snippet || r.answer || r.text || '').trim()

  return (
    <div className="rounded-lg border border-border/70 bg-background p-3 text-xs shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span className="font-semibold">Recall slice {r.rank ?? '?'}</span>
          </div>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="!px-1.5 !py-0.5 text-[11px]">
              {r.title || r.docTitle || '文档'}
            </Badge>
            {r.heading && (
              <Badge variant="outline" className="!px-1.5 !py-0.5 text-[11px]">
                {r.heading}
              </Badge>
            )}
            <div className="ml-auto">
              <Badge
                className={cn(
                  '!px-1.5 !py-0.5 text-[11px] tabular-nums',
                  scoreColor(r.score ?? 0),
                )}
              >
                Score: {((r.score ?? 0) * 100).toFixed(2)}
              </Badge>
            </div>
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

      {/* 收缩态绝对不显示任何片段文本；只有 open 时才把分隔线 + 完整 snippet 放出来 */}
      {open && (
        <div className="mt-2 border-t border-border/50 pt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
          {full || '（无片段内容）'}
        </div>
      )}
    </div>
  )
}

export default SearchProcessPanel
