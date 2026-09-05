import {
  FileText,
  Eye,
  Database,
  Download,
  Loader2,
  CheckCircle2,
  Layers,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * DocActionBar —— 文档处理智能体的底部操作栏。
 *
 * 文件上传解析成功后出现在消息列表与输入框之间，把「预览 / 入库 / 导出」从
 * 自然语言指令升级为显式按钮：
 *  - 预览：打开独立预览界面（DocPreviewDialog）
 *  - 入库：直接调 REST 入库（按钮点击即用户明确确认），完成后标记「已入库」并禁用
 *  - 导出：打开导出界面（DocExportDialog），可下载 .md 文件
 *  - 全部入库：多文档场景批量入库（commit-batch），单个失败不中断整批
 *
 * 多文档支持：上传多份文件后显示文档切换 chips，点击切换当前操作对象
 * （预览/入库/导出均作用于选中文档）。
 *
 * @param {Object} props
 * @param {Array<{docId:string, title:string, committed:boolean}>} props.docs 已上传文档列表
 * @param {string}   props.activeDocId                        当前选中文档 id
 * @param {boolean}  props.committed                          当前文档是否已入库（禁用入库按钮）
 * @param {boolean}  props.busy                               入库请求进行中
 * @param {boolean}  [props.busyAll]                          批量入库进行中
 * @param {(docId:string)=>void} [props.onSelectDoc]          切换当前文档
 * @param {() => void} props.onPreview                      打开预览界面
 * @param {() => void} props.onCommit                       执行入库（当前文档）
 * @param {() => void} [props.onCommitAll]                  批量入库（全部未入库文档）
 * @param {() => void} props.onExport                       打开导出界面
 * @param {string}   [props.commitError]                    入库错误信息（如 409 已入库）
 */
export function DocActionBar({
  docs,
  activeDocId,
  committed,
  busy,
  busyAll = false,
  onSelectDoc,
  onPreview,
  onCommit,
  onCommitAll,
  onExport,
  commitError,
}) {
  const activeDoc = (docs || []).find((d) => d.docId === activeDocId)
  if (!activeDoc) return null

  const uncommittedCount = (docs || []).filter((d) => !d.committed).length

  return (
    <div className="border-t bg-background/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-2.5 md:px-6">
        {/* 多文档切换 chips（≥2 份文档时显示） */}
        {docs.length > 1 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              文档
            </span>
            {docs.map((d) => (
              <button
                key={d.docId}
                type="button"
                onClick={() => onSelectDoc?.(d.docId)}
                className={cn(
                  'inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition',
                  d.docId === activeDocId
                    ? 'border-primary/40 bg-accent font-medium text-accent-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent/50',
                )}
                title={d.title}
              >
                <span className="truncate">{d.title}</span>
                {d.committed && (
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" />
                )}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
          {/* 文档标识 */}
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span
            className="max-w-[280px] truncate text-xs font-medium text-foreground/80"
            title={activeDoc.title}
          >
            {activeDoc.title}
          </span>
          {committed ? (
            <Badge className="gap-1 border border-emerald-600/20 bg-emerald-500/10 !px-2 !py-0.5 text-[11px] text-emerald-600 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              已入库
            </Badge>
          ) : (
            <Badge variant="secondary" className="!px-2 !py-0.5 text-[11px]">
              待处理
            </Badge>
          )}
          {docs.length > 1 && (
            <Badge variant="outline" className="!px-2 !py-0.5 text-[11px]">
              共 {docs.length} 份
            </Badge>
          )}

          {/* 操作按钮 */}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={onPreview}
            >
              <Eye className="h-3.5 w-3.5" />
              预览切片
            </Button>
            <Button
              type="button"
              variant={committed ? 'secondary' : 'default'}
              size="sm"
              className={cn(
                'h-7 gap-1.5 px-2.5 text-xs',
                committed && 'cursor-default opacity-80',
              )}
              disabled={busy || committed}
              onClick={onCommit}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Database className="h-3.5 w-3.5" />
              )}
              {busy ? '入库中…' : committed ? '已入库' : '入库'}
            </Button>
            {docs.length > 1 && uncommittedCount > 1 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={busy || busyAll}
                title={`批量入库全部 ${uncommittedCount} 份未入库文档（自动去重，已入库的跳过）`}
                onClick={onCommitAll}
              >
                {busyAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
                {busyAll ? '批量入库中…' : `全部入库(${uncommittedCount})`}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={onExport}
            >
              <Download className="h-3.5 w-3.5" />
              导出
            </Button>
          </div>
        </div>

        {/* 入库错误提示（如重复入库 409） */}
        {commitError && (
          <p className="mt-1.5 px-1 text-[11px] text-destructive">
            {commitError}
          </p>
        )}
      </div>
    </div>
  )
}

export default DocActionBar
