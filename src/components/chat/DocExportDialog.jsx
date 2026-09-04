import * as React from 'react'
import {
  FileDown,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  FileCode2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { exportDoc } from '@/lib/docProcessorApi'

/**
 * DocExportDialog —— 文档处理智能体的导出界面。
 *
 * 「导出」按钮打开：调 REST /api/doc-processor/export 拿到整理后的 Markdown
 * （含预览阶段做的合并/拆分调整），界面内预览全文，并提供：
 *  - 下载 .md 文件：Blob + <a download>（文件名由后端按文档标题派生，如「xxx_整理.md」）
 *  - 复制全文：写剪贴板
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {(v:boolean)=>void} props.onOpenChange
 * @param {string} props.docId  当前文档 id
 * @param {string} props.title  文档标题
 */
export function DocExportDialog({ open, onOpenChange, docId, title }) {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [markdown, setMarkdown] = React.useState('')
  const [filename, setFilename] = React.useState('')
  const [chunkCount, setChunkCount] = React.useState(0)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setCopied(false)
    exportDoc(docId)
      .then((r) => {
        if (cancelled) return
        setMarkdown(r.markdown || '')
        setFilename(r.filename || '文档_整理.md')
        setChunkCount(r.chunkCount || 0)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || '导出失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, docId])

  /** 生成 .md 文件并触发浏览器下载 */
  const download = () => {
    if (!markdown) return
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const copy = async () => {
    if (!markdown) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败：浏览器未授权剪贴板访问，可直接下载文件')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {/* 头部：标题 + 统计 + 操作按钮 */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5 pr-12">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileCode2 className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">
                导出 Markdown{title ? ` · ${title}` : ''}
              </span>
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              由当前切片（含调整结果）拼接生成；入库前后均可导出。
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {chunkCount > 0 && (
              <Badge
                variant="secondary"
                className="!px-2 !py-0.5 text-[11px] tabular-nums"
              >
                {chunkCount} 块 · {markdown.length.toLocaleString()} 字
              </Badge>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={copy}
              disabled={loading || !markdown}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? '已复制' : '复制全文'}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={download}
              disabled={loading || !markdown}
              title={filename}
            >
              <FileDown className="h-3.5 w-3.5" />
              下载 .md
            </Button>
          </div>
        </div>

        {/* 主体：Markdown 全文预览（独立滚动） */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在生成 Markdown…
            </div>
          ) : error ? (
            <div className="m-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {markdown || '（无内容）'}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default DocExportDialog
