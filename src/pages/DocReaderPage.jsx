import * as React from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  BookOpen,
  List,
  ChevronUp,
  ChevronDown,
  Loader2,
  AlertCircle,
  Download,
  ArrowLeft,
  Hash,
  Info,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { getManifest, getContent, downloadUrl } from '@/lib/filesApi'
import { cn } from '@/lib/utils'

/**
 * DocReaderPage —— 切片阅读器（设计书 D10）
 *
 * 核心机制：切片的 span **连续无缝覆盖全文**，所以不需要在渲染后的 HTML 里反查位置 ——
 * 直接把 content 按切片边界切段、每段独立 Markdown 渲染即可：
 *   ① 偏移在渲染前天然对齐  ② 切片边界可视  ③ 高亮当前片 = 高亮一个组件
 *
 * 数据全部来自 v3 三级存储：元数据/锚点在锚点层，正文在持久层（按 span 取）。
 * 路由挂在 /knowledge/read/:docId 下，复用「文档管理」视图态，无需改动导航结构。
 */

const POS_KEY = (docId) => `reader:pos:${docId}`

export function DocReaderPage() {
  const { docId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // 知识网络节点点击会带 ?chunk=<chunkId 或 idx>（D9：从图上直接落到文件切片）
  const chunkParam = searchParams.get('chunk')

  const [manifest, setManifest] = React.useState(null)
  const [content, setContent] = React.useState('')
  const [activeIdx, setActiveIdx] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  const [showDetail, setShowDetail] = React.useState(true)

  // 加载：manifest（切片目录）+ content（正文）各一次，客户端全权渲染
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [mf, ct] = await Promise.all([getManifest(docId), getContent(docId)])
        if (cancelled) return
        setManifest(mf)
        setContent(ct.text ?? '')
        const saved = Number(localStorage.getItem(POS_KEY(docId)))
        setActiveIdx(Number.isFinite(saved) && saved > 0 ? saved : 0)
      } catch (err) {
        if (!cancelled) setError(err?.message ?? '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId])

  // 按 span 锚点把正文切成与目录一一对应的段落（切片边界即渲染边界）
  const blocks = React.useMemo(() => {
    if (!manifest?.chunks) return []
    return manifest.chunks.map((c) => ({
      ...c,
      text: content.slice(c.span.start, c.span.end),
    }))
  }, [manifest, content])

  const scrollTo = React.useCallback(
    (idx, smooth = true) => {
      const n = Math.max(0, Math.min(blocks.length - 1, idx))
      setActiveIdx(n)
      localStorage.setItem(POS_KEY(docId), String(n))
      document.getElementById(`chunk-${n}`)?.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        block: 'start',
      })
    },
    [blocks.length, docId],
  )

  // 从知识网络跳入时按 ?chunk= 定位（D9）
  // 兼容两种形态：纯数字视为 idx，否则按 chunkId 查找
  React.useEffect(() => {
    if (!blocks.length || !chunkParam) return
    const asNum = Number(chunkParam)
    const target =
      Number.isInteger(asNum) && String(asNum) === String(chunkParam)
        ? asNum
        : blocks.findIndex((b) => b.chunkId === chunkParam)
    if (target >= 0 && target < blocks.length) {
      // 等这一段渲染进 DOM 再滚动
      requestAnimationFrame(() => scrollTo(target, false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks.length, chunkParam])

  // 键盘：j/k 或 ↑/↓ 上下片
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        scrollTo(activeIdx + 1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        scrollTo(activeIdx - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIdx, scrollTo])

  const current = blocks[activeIdx]

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载切片目录与正文…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/knowledge')}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          返回文档管理
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={BookOpen}
        title={manifest?.title ?? '切片阅读'}
        description={
          <>
            共 {blocks.length} 个切片 · 按锚点分段渲染 · 点击左侧目录或按 ↑/↓ 定位切片
          </>
        }
      >
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5"
            onClick={() => scrollTo(activeIdx - 1)}
            disabled={activeIdx <= 0}
          >
            <ChevronUp className="h-3.5 w-3.5" />
            上一片
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5"
            onClick={() => scrollTo(activeIdx + 1)}
            disabled={activeIdx >= blocks.length - 1}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            下一片
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5"
            onClick={() => setShowDetail((v) => !v)}
            title="切换详情面板"
          >
            <Info className="h-3.5 w-3.5" />
          </Button>
          <a href={downloadUrl(docId)} download>
            <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5">
              <Download className="h-3.5 w-3.5" />
              原件
            </Button>
          </a>
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {/* 左：切片目录 */}
        <aside className="scrollbar-thin w-60 shrink-0 overflow-y-auto border-r">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground">
            <List className="h-3.5 w-3.5" />
            切片目录
          </div>
          <div className="pb-4">
            {blocks.map((b) => (
              <button
                key={b.idx}
                type="button"
                onClick={() => scrollTo(b.idx)}
                className={cn(
                  'flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left text-xs transition-colors',
                  b.idx === activeIdx
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-transparent hover:bg-accent/50',
                )}
              >
                <span className="mt-px shrink-0 font-mono text-[10px] text-muted-foreground">
                  {String(b.idx + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block">
                    {b.heading || b.text.slice(0, 40) || '(空切片)'}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                    {b.charCount} 字
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* 中：正文（按切片分段渲染） */}
        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-3xl px-6 py-5">
            {blocks.map((b) => (
              <section
                key={b.idx}
                id={`chunk-${b.idx}`}
                onClick={() => setActiveIdx(b.idx)}
                className={cn(
                  'scroll-mt-4 rounded-md border-l-2 px-4 py-3 transition-colors',
                  b.idx === activeIdx
                    ? 'border-primary bg-accent/40'
                    : 'border-transparent hover:border-muted-foreground/20',
                )}
              >
                <div className="mb-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                  <Hash className="h-3 w-3" />
                  <span>
                    切片 {b.idx + 1} / {blocks.length}
                  </span>
                  <span className="text-muted-foreground/60">
                    span[{b.span.start}, {b.span.end})
                  </span>
                </div>
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown>{b.text}</ReactMarkdown>
                </div>
              </section>
            ))}
          </article>
        </main>

        {/* 右：当前切片详情 */}
        {showDetail && current && (
          <aside className="scrollbar-thin w-72 shrink-0 overflow-y-auto border-l px-4 py-3">
            <div className="mb-3 text-xs font-medium text-muted-foreground">当前切片</div>
            <div className="space-y-3 text-xs">
              <div>
                <div className="text-muted-foreground">编号</div>
                <div className="font-mono">
                  {current.idx + 1} / {blocks.length}
                </div>
              </div>
              {current.heading && (
                <div>
                  <div className="text-muted-foreground">标题</div>
                  <div>{current.heading}</div>
                </div>
              )}
              {current.topic && (
                <div>
                  <div className="text-muted-foreground">主题</div>
                  <div>{current.topic}</div>
                </div>
              )}
              <div>
                <div className="text-muted-foreground">锚点</div>
                <div className="font-mono text-[11px]">
                  span[{current.span.start}, {current.span.end}) · {current.charCount} 字
                </div>
              </div>
              <div>
                <div className="mb-1 text-muted-foreground">向量</div>
                {current.vector ? (
                  <div className="space-y-1">
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {current.vector.model ?? 'vector'}
                    </Badge>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {current.vector.id}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      问题锚点：{current.vector.hasQuestion ? '有' : '无'}
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">未建立</div>
                )}
              </div>
              {current.questions?.length > 0 && (
                <div>
                  <div className="mb-1 text-muted-foreground">
                    问题锚点（{current.questions.length}）
                  </div>
                  <ul className="space-y-1">
                    {current.questions.map((q, i) => (
                      <li key={i} className="rounded bg-muted/50 px-2 py-1 text-[11px]">
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

export default DocReaderPage
