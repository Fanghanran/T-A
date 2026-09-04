import * as React from 'react'
import { AlignJustify, Database, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChunkScoreBadge } from '@/components/chat/ChunkPreviewPanel'

/** 简易 Tabs（与 DocumentEditDialog 保持同风格，避免再引依赖） */
export function SimpleTabs({ tabs, value, onChange }) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
      role="tablist"
      aria-label="文档预览视图"
    >
      {tabs.map((t) => {
        const tabId = `document-preview-tab-${t.value}`
        return (
          <button
            type="button"
            key={t.value}
            id={tabId}
            role="tab"
            aria-selected={value === t.value}
            aria-controls={`document-preview-panel-${t.value}`}
            tabIndex={value === t.value ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={cnTabs(value === t.value)}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function cnTabs(active) {
  return [
    'rounded px-3 py-1 text-xs font-medium transition-colors',
    active
      ? 'bg-background shadow-sm text-foreground'
      : 'text-muted-foreground hover:text-foreground hover:bg-background/40',
  ].join(' ')
}

/**
 * ChunkListPanel —— 文档预览的「切片视图」Tab 面板
 * （空态 / 未对齐提示 / 切片卡片列表 / 简易分页）
 *
 * @param {Object} props
 * @param {boolean} props.chunksLoading
 * @param {boolean} props.sameDoc        切片数据是否已与当前文档对齐
 * @param {Object} props.chunks          { items, total, page, pageSize, avgScore?, scoreMode? }
 * @param {string} props.docId           当前文档 id（翻页回调用）
 * @param {(docId:string, params:{page:number})=>void} [props.onLoadChunks]
 */
export function ChunkListPanel({ chunksLoading, sameDoc, chunks, docId, onLoadChunks }) {
  const chunkItems = chunks?.items ?? []
  const chunkTotal = Number(chunks?.total ?? chunkItems.length)
  const chunkPage = Number(chunks?.page ?? 1)
  const chunkPageSize = Number(chunks?.pageSize ?? 20)
  const chunkTotalPages = Math.max(1, Math.ceil(chunkTotal / chunkPageSize))

  return (
    <div className="flex flex-col gap-3">
      {chunksLoading && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          切片加载中…
        </div>
      )}
      {!chunksLoading && !sameDoc && (
        <p className="text-sm text-muted-foreground">
          切片数据尚未与当前文档对齐，点击切页后会自动加载。
        </p>
      )}
      {!chunksLoading && sameDoc && chunkItems.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-8">
          当前文档无切片数据。
        </p>
      )}
      {sameDoc &&
        chunkItems.map((c, i) => <ChunkCard key={c.id ?? i} chunk={c} index={i} />)}

      {/* 切片分页器（简单版：上一页/下一页） */}
      {sameDoc && chunkTotalPages > 1 && (
        <div className="mt-4 flex items-center justify-between rounded-md border px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Database className="h-3.5 w-3.5 opacity-70" />
            <span>
              第 {chunkPage} / {chunkTotalPages} 页 · 共 {chunkTotal} 块
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={chunkPage <= 1 || !onLoadChunks}
              onClick={() => onLoadChunks?.(docId, { page: chunkPage - 1 })}
            >
              上一页
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={chunkPage >= chunkTotalPages || !onLoadChunks}
              onClick={() => onLoadChunks?.(docId, { page: chunkPage + 1 })}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ChunkCard({ chunk, index }) {
  const displayTitle = chunk.displayTitle || `§ ${index + 1}`
  const tokens = Number(chunk.tokens ?? 0)
  const text = chunk.text ?? ''
  const topic = typeof chunk.topic === 'string' ? chunk.topic.trim() : ''
  const preCtx =
    typeof chunk.preContext === 'string' ? chunk.preContext.trim() : ''
  const postCtx =
    typeof chunk.postContext === 'string' ? chunk.postContext.trim() : ''
  return (
    <div className="rounded-md border p-3 transition-colors hover:bg-accent/40">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          <AlignJustify className="h-3 w-3" />
          {displayTitle}
        </span>
        {topic && (
          <span className="text-[11px] text-muted-foreground italic">
            主题：{topic}
          </span>
        )}
        {chunk.heading && (
          <span className="text-[11px] text-muted-foreground">
            原文小节：{chunk.heading}
          </span>
        )}
        {chunk.category && (
          <Badge variant="secondary" className="text-[10px]">
            {chunk.category}
          </Badge>
        )}
        {chunk.tags?.slice(0, 3).map((t) => (
          <Badge
            key={t}
            variant="outline"
            className="text-[10px] text-muted-foreground"
          >
            {t}
          </Badge>
        ))}
        {tokens > 0 && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {tokens.toLocaleString()} tokens
          </span>
        )}
        {Number.isFinite(Number(chunk.score)) && (
          <ChunkScoreBadge
            score={chunk.score}
            level={chunk.level}
            issues={chunk.issues}
          />
        )}
      </div>
      {preCtx && (
        <div className="mb-1.5 rounded bg-muted/40 px-2 py-1 text-[11px] leading-relaxed text-muted-foreground border-l-2 border-muted-foreground/30">
          <span className="mr-1 font-medium">上文</span>
          {preCtx}
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-foreground/90 max-h-[240px] overflow-auto pr-1">
        {text || '（空切片）'}
      </pre>
      {postCtx && (
        <div className="mt-1.5 rounded bg-muted/40 px-2 py-1 text-[11px] leading-relaxed text-muted-foreground border-l-2 border-muted-foreground/30">
          <span className="mr-1 font-medium">下文</span>
          {postCtx}
        </div>
      )}
    </div>
  )
}
