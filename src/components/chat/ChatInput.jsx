import * as React from 'react'
import {
  ArrowUp,
  Square,
  AlertCircle,
  Paperclip,
  X,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TechStackSelector } from '@/components/agents/TechStackSelector'
import { request } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * ChatInput —— 对话输入区
 *
 * 行为：
 * - 面试题检索智能体：展示结构化表单（query 文本框 + TechStackSelector），提交时把 query 作为消息内容，
 *   techStack 由父组件维护并经 useChat 的 body 注入后端。
 * - 文档处理智能体：支持文件拖拽 / 粘贴 → 上传到 /api/doc-processor/upload 提取文本 → 自动填入
 *   "请分析这份文档" 提示，用户回车即带 body.docId 提交（后端按消息意图分流 upload/analyze/preview/...）。
 * - 其他智能体：仅展示纯文本输入框。
 * - 生成中显示「停止」按钮；回车提交（Shift+Enter 换行）。
 *
 * @param {Object} props
 * @param {Object} props.agent                当前智能体
 * @param {boolean} [props.structured]       是否启用结构化表单
 * @param {string[]} props.techStack         选中的技术栈
 * @param {(stack: string[]) => void} props.onTechStackChange 技术栈变更回调
 * @param {string} props.input               当前输入文本
 * @param {(e: Event) => void} props.handleInputChange 输入变更处理
 * @param {(e: Event, options?: Object) => void} props.handleSubmit 提交处理
 * @param {boolean} props.isLoading          是否生成中
 * @param {() => void} [props.onStop]        停止生成
 * @param {Error | undefined} props.error    错误对象
 * @param {boolean} [props.isDocProcessor]   是否文档处理智能体（开启文件上传）
 * @param {string} [props.activeDocId]        当前已上传文档 id（提交时注入 body.docId）
 * @param {(v: string) => void} [props.setInput]      useChat 的 setInput（上传后填入提示语）
 * @param {(docId: string, title: string) => void} [props.onDocUploaded] 上传成功回调
 * @param {{endpoint:string, accept:string, hint:string}} [props.upload] 通用上传配置（如简历分析走 /api/resume/parse）
 * @param {({title:string, text:string}) => void} [props.onResumeParsed] 通用解析成功回调（拿到简历正文）
 * @param {string} [props.resumeText] 已解析的简历正文（提交时注入 body.resumeText）
 */
export function ChatInput({
  agent,
  structured,
  techStack,
  onTechStackChange,
  input,
  handleInputChange,
  handleSubmit,
  isLoading,
  onStop,
  error,
  isDocProcessor,
  activeDocId,
  setInput,
  onDocUploaded,
  upload,
  onResumeParsed,
  resumeText,
}) {
  const textareaRef = React.useRef(null)
  const formRef = React.useRef(null)
  // 手动选择文件：隐藏 input，由左侧回形针按钮触发（支持多选）
  const fileInputRef = React.useRef(null)

  // 通用「文件上传能力」：doc-processor 或 resume-analysis 等配置了 upload 的智能体
  const canUpload = !!(isDocProcessor || upload)
  const uploadEndpoint = isDocProcessor
    ? '/api/doc-processor/upload'
    : upload?.endpoint || ''
  const uploadAccept = isDocProcessor
    ? '.md,.markdown,.txt,.html,.htm,.csv,.tsv,.json,.yaml,.yml,.log,.pdf,.docx'
    : upload?.accept || '.pdf,.docx,.md,.markdown,.txt'

  const pickFile = () => {
    if (!canUpload || uploadingCount > 0) return
    fileInputRef.current?.click()
  }

  const onPickChange = (e) => {
    const files = Array.from(e.target.files || [])
    for (const f of files) uploadFile(f)
    // 重置 value，否则同一文件连续选择第二次不触发 change
    e.target.value = ''
  }

  // 文件上传状态（仅 doc-processor 用）：支持多文件并发上传，逐个显示状态
  const [pendingFiles, setPendingFiles] = React.useState([]) // [{ key, name, size, docId?, title?, status: 'uploading'|'done'|'error', error? }]
  const [dragOver, setDragOver] = React.useState(false)
  const uploadingCount = pendingFiles.filter(
    (f) => f.status === 'uploading',
  ).length

  const uploadFile = React.useCallback(
    async (file) => {
      if (!file) return
      const key = `${file.name}-${file.size}-${Date.now()}`
      setPendingFiles((list) => [
        ...list,
        { key, name: file.name, size: file.size, status: 'uploading' },
      ])
      try {
        const fd = new FormData()
        fd.append('file', file)
        // 统一走 request()：带 x-request-id 追踪 + AppError 错误归一化（FormData 直接透传，浏览器自动设 multipart 边界）
        const data = await request(uploadEndpoint, { method: 'POST', body: fd })
        if (isDocProcessor) {
          setPendingFiles((list) =>
            list.map((f) =>
              f.key === key
                ? { ...f, docId: data.docId, title: data.title, status: 'done' }
                : f,
            ),
          )
          onDocUploaded?.(data.docId, data.title)
          if (typeof setInput === 'function') setInput(`请分析这份文档《${data.title}》`)
        } else {
          // 通用解析（简历等）：拿到正文 text，交由父级注入后续 chat body
          setPendingFiles((list) =>
            list.map((f) =>
              f.key === key ? { ...f, title: data.title, status: 'done' } : f,
            ),
          )
          onResumeParsed?.({ title: data.title, text: data.text, format: data.format })
          if (typeof setInput === 'function') setInput(upload?.hint || `请分析《${data.title}》`)
        }
        requestAnimationFrame(() => textareaRef.current?.focus())
      } catch (err) {
        setPendingFiles((list) =>
          list.map((f) =>
            f.key === key
              ? { ...f, status: 'error', error: err.message || '上传失败' }
              : f,
          ),
        )
      }
    },
    [uploadEndpoint, isDocProcessor, onDocUploaded, onResumeParsed, setInput, upload],
  )

  // 表单提交：交给 useChat 的 handleSubmit（它会读取受控 input 并发起流式请求）
  const onSubmit = (e) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return
    // 文档处理：注入 body.docId；简历分析：注入 body.resumeText（解析得到的正文）
    if (isDocProcessor) {
      const body = activeDocId ? { docId: activeDocId } : {}
      handleSubmit(e, { body })
    } else if (upload && resumeText) {
      handleSubmit(e, { body: { resumeText } })
    } else {
      handleSubmit(e)
    }
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }

  const onKeyDown = (e) => {
    // 回车提交：用原生 requestSubmit 触发真正的 SubmitEvent，
    // 保证 useChat 的 handleSubmit 始终收到合法表单事件
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      formRef.current?.requestSubmit()
    }
  }

  // 文件拖拽（支持一次拖入多个）
  const onDrop = (e) => {
    setDragOver(false)
    if (!canUpload) return
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length) {
      e.preventDefault()
      for (const f of files) uploadFile(f)
    }
  }

  // 粘贴：检测剪贴板里的文件（可多个）
  const onPaste = (e) => {
    if (!canUpload) return
    const files = Array.from(e.clipboardData?.files || [])
    if (files.length) {
      e.preventDefault()
      for (const f of files) uploadFile(f)
    }
  }

  // 自适应高度的 textarea
  const autosize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const clearPendingFile = (key) => {
    if (key === undefined) setPendingFiles([])
    else setPendingFiles((list) => list.filter((f) => f.key !== key))
  }

  return (
    <div className="shrink-0 border-t bg-background/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-3 md:px-6">
        {/* 内联错误提示 */}
        {error && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive animate-fade-in">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {error.message || '请求失败，请稍后重试。'}
            </span>
          </div>
        )}

        {/* 结构化字段：技术栈选择 */}
        {structured && (
          <div className="mb-2">
            <TechStackSelector
              selected={techStack}
              onChange={onTechStackChange}
            />
          </div>
        )}

        {/* 文件上传状态列表（支持多文件） */}
        {canUpload && pendingFiles.length > 0 && (
          <div className="mb-2 space-y-1 animate-fade-in">
            {pendingFiles.map((f) => (
              <div
                key={f.key}
                className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs"
              >
                {f.status === 'uploading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : f.status === 'done' ? (
                  <Paperclip className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                )}
                <span className="flex-1 truncate">
                  {f.name}
                  <span className="ml-1.5 text-muted-foreground">
                    · {(f.size / 1024).toFixed(1)}KB
                  </span>
                  {f.status === 'done' && (
                    <span className="ml-1.5 text-emerald-600">· 已就绪</span>
                  )}
                  {f.status === 'error' && (
                    <span className="ml-1.5 text-destructive">· {f.error}</span>
                  )}
                </span>
                {f.status === 'done' && f.docId && (
                  <Badge
                    variant="secondary"
                    className="!px-1.5 !py-0.5 text-[10px]"
                  >
                    {f.docId}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => clearPendingFile(f.key)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="移除文件"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <form
          ref={formRef}
          onSubmit={onSubmit}
          onDragOver={(e) => {
            if (canUpload) {
              e.preventDefault()
              setDragOver(true)
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            'relative',
            canUpload &&
              dragOver &&
              'ring-2 ring-ring ring-offset-2 rounded-2xl',
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              handleInputChange(e)
              autosize()
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={
              isDocProcessor
                ? '拖拽 / 粘贴 / 点击左侧按钮选择文件，或输入文本（如"预览"、"入库"、"导出"）…'
                : upload
                  ? '上传简历（PDF/DOCX/MD/TXT）或直接粘贴文本；把岗位 JD 一并发给我可做匹配打分…'
                  : structured
                    ? '输入面试问题关键词，如「React 性能优化」…'
                    : `向 ${agent?.name ?? '智能体'} 发送消息…`
            }
            className={cn(
              'w-full resize-none rounded-2xl border border-input bg-background px-4 py-3 pr-12 text-sm',
              canUpload && 'pl-12',
              'max-h-[200px] scrollbar-thin',
              'placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
          />
          {/* 文件上传：左侧选择文件按钮 */}
          {canUpload && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple={isDocProcessor}
                accept={uploadAccept}
                className="hidden"
                onChange={onPickChange}
              />
              <div className="absolute bottom-2 left-2">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={pickFile}
                  disabled={uploadingCount > 0}
                  aria-label="选择文件上传"
                  title="选择文件上传"
                  className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                >
                  {uploadingCount > 0 ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </>
          )}
          <div className="absolute bottom-2 right-2">
            {isLoading ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                onClick={onStop}
                aria-label="停止生成"
                className="h-8 w-8 rounded-full"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim()}
                aria-label="发送"
                className="h-8 w-8 rounded-full"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>

        {/* 技术栈已选摘要（移动端折叠态可见） */}
        {structured && techStack.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 sm:hidden">
            {techStack.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        )}

        <p className="mt-2 hidden text-center text-[11px] text-muted-foreground sm:block">
          {canUpload
            ? '回车发送 · Shift + 回车换行 · 拖拽 / 粘贴 / 按钮选择文件上传'
            : '回车发送 · Shift + 回车换行'}
        </p>
      </div>
    </div>
  )
}

export default ChatInput
