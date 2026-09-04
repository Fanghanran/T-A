import * as React from 'react'
import {
  Workflow,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Wrench,
  CheckCircle2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * AgentWorkflowPanel —— 文档处理智能体的 ReAct 工作流卡片。
 *
 * 与 SearchProcessPanel / ChunkPreviewPanel 对称：消费后端 `type: 'agent_workflow'`
 * 注解（docAgent 每执行一步工具发一条 delta），把"调了什么工具、参数、思考、观察"
 * 以时间线卡片展示，让用户在会话中可见智能体的工作过程。
 *
 * 交互（与既有面板一致的折叠约定）：
 *  - 最外层面板默认折叠（标题行：⚙ 工作流 · N 步 · 总耗时徽章）
 *  - 每个步骤卡片独立展开/折叠：折叠态只显示标题行（Step N · 工具中文名 · 参数摘要 · 耗时），
 *    展开态才显示思考（thought）与观察（observation）
 *
 * @param {Object} props
 * @param {Array}  props.annotations  useChat message.annotations（含 agent_workflow 条目）
 */
export function AgentWorkflowPanel({ annotations }) {
  const wfAnns = React.useMemo(
    () =>
      (annotations || []).filter(
        (a) => a && typeof a === 'object' && a.type === 'agent_workflow',
      ),
    [annotations],
  )

  const [open, setOpen] = React.useState(false) // 最外层默认折叠

  if (!wfAnns.length) return null

  // 按 seq 排序的步骤时间线（每条注解即一步）
  const steps = [...wfAnns].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  const totalMs = steps.reduce((s, a) => s + (a.ms || 0), 0)
  const toolCount = steps.filter((s) => s.tool && s.tool !== 'FINISH').length

  return (
    <div className="mb-3 w-full overflow-hidden rounded-xl border border-border bg-card/60 shadow-sm">
      {/* 折叠头部 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-accent/40"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          {open ? (
            <Workflow className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <span className="font-medium text-foreground/80">
            {open ? '隐藏工作流' : '工作流（ReAct）'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="gap-1 !px-2 !py-0.5 text-[11px]"
          >
            <Wrench className="h-3 w-3" />
            {toolCount} 次工具调用
          </Badge>
          <Badge
            variant="outline"
            className="!px-2 !py-0.5 text-[11px] tabular-nums"
          >
            {(totalMs / 1000).toFixed(1)}s
          </Badge>
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/60 bg-muted/30">
          <div className="space-y-2 px-3 py-2.5">
            {steps.map((s, i) => (
              <WorkflowStepCard
                key={`${s.seq ?? i}-${s.tool}`}
                s={s}
                isLast={i === steps.length - 1}
              />
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
            <span>ReAct 循环：思考 → 调用工具 → 观察结果 → 继续决策</span>
            <span>共 {steps.length} 步</span>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- 内部：单个工具调用步骤卡片 ---------- */

function WorkflowStepCard({ s, isLast }) {
  const [open, setOpen] = React.useState(false) // 步骤卡片默认折叠，只显示标题行

  const isFinish = s.tool === 'FINISH'
  const argsStr = Object.keys(s.args || {}).length
    ? Object.entries(s.args)
        .map(
          ([k, v]) =>
            `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
        )
        .join(' ')
    : ''

  return (
    <div className="relative rounded-lg border border-border/70 bg-background p-3 text-xs shadow-xs">
      {/* 左侧时间线节点 */}
      <span
        className={cn(
          'absolute -left-[13px] top-4 h-2 w-2 rounded-full',
          isFinish ? 'bg-emerald-500/80' : 'bg-primary/70',
        )}
      />
      {!isLast && (
        <span className="absolute -left-[10px] top-6 h-[calc(100%-8px)] w-[2px] bg-border/70" />
      )}

      {/* 可折叠 header：Step N · 工具名 · 参数摘要 · 耗时 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Step {s.seq ?? '?'}
            </span>
            <Badge
              variant="secondary"
              className={cn(
                'gap-1 !px-1.5 !py-0.5 text-[11px] font-medium',
                isFinish &&
                  'border border-emerald-600/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
              )}
            >
              {isFinish ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <Wrench className="h-3 w-3" />
              )}
              {s.label || s.tool || '未知工具'}
            </Badge>
            {argsStr && !isFinish && (
              <span
                className="truncate text-[11px] text-muted-foreground"
                title={argsStr}
              >
                {argsStr}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isFinish && (s.ms || 0) > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {((s.ms || 0) / 1000).toFixed(1)}s
            </span>
          )}
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* 展开后：思考 + 观察结果 */}
      {open && (
        <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2 text-[12px] leading-relaxed">
          {s.thought && (
            <div className="text-muted-foreground">
              <span className="font-medium text-foreground/70">思考：</span>
              {s.thought}
            </div>
          )}
          {s.observation && (
            <div className="rounded-md bg-muted/50 px-2 py-1.5 whitespace-pre-wrap break-words text-muted-foreground">
              <span className="font-medium text-foreground/70">观察：</span>
              {s.observation}
            </div>
          )}
          {!s.thought && !s.observation && (
            <div className="text-muted-foreground">（无详情）</div>
          )}
        </div>
      )}
    </div>
  )
}

export default AgentWorkflowPanel
