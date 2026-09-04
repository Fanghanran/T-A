import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, FileText, Loader2, Hash, Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChunkScoreBadge } from '@/components/chat/ChunkPreviewPanel'
import { SimpleTabs, ChunkListPanel } from './ChunkListPanel'

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    return ''
  }
}

/**
 * DocumentPreview —— 文档内容预览（升级 F9：加切片 Tab + 文档操作按钮）
 *
 * props 新增（相对旧版）：
 * - tab: 'content' | 'chunks'
 * - onTabChange: (t) => void
 * - chunks: { items:[{id,displayTitle,heading?,text,tokens,category,tags}], total, page, pageSize }
 * - chunksLoading?: boolean
 * - chunksDocId?: string          切片绑定的文档 id（若 doc.id !== chunksDocId，提示请切到切片 Tab 后触发加载）
 * - onLoadChunks?: (docId, {page}) => void  切到切片 Tab / 翻页时由父级去拉数据
 * - onEdit?: (doc) => void        点「编辑」按钮（打开 DocumentEditDialog，由父级管理）
 * - onDelete?: (doc) => void      点「删除」按钮（同列表删除）
 *
 * 向后兼容：如果不传 tab/onTabChange/chunks，该组件行为退化为"纯内容预览"（旧版）。
 */
export function DocumentPreview({
  doc,
  loading,
  onClose,
  tab = 'content',
  onTabChange,
  chunks,
  chunksLoading,
  chunksDocId,
  onLoadChunks,
  onEdit,
  onDelete,
}) {
  const showTabs = !!onTabChange && !!chunks
  const chunkTotal = Number(chunks?.total ?? chunks?.items?.length ?? 0)
  const sameDoc = doc && chunksDocId && doc.id === chunksDocId

  // 切到切片 Tab 时若尚未加载对应文档，自动触发父级拉取（默认「正文」tab 不触发，秒开）
  const docId = doc?.id
  React.useEffect(() => {
    if (tab === 'chunks' && docId && onLoadChunks && chunksDocId !== docId) {
      onLoadChunks(docId, { page: 1 })
    }
  }, [tab, docId, chunksDocId, onLoadChunks])

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：图标 + 标题 + 操作按钮 + 关闭 */}
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1 truncate text-sm font-medium">
          {doc?.title ?? '文档预览'}
        </span>
        {doc && (
          <div className="flex items-center gap-1">
            {onEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => onEdit(doc)}
                aria-label="编辑文档"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {onDelete && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(doc)}
                aria-label="删除文档"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                aria-label="关闭预览"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* 文档元信息：分类/标签 + size/日期 */}
      {doc && (
        <div className="flex flex-col gap-1.5 border-b px-4 py-2">
          {(doc.category || doc.tags?.length || doc.source) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {doc.category && (
                <Badge variant="secondary" className="text-[10px]">
                  {doc.category}
                </Badge>
              )}
              {doc.tags?.map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className="text-[10px] text-muted-foreground"
                >
                  {t}
                </Badge>
              ))}
              {doc.source && (
                <span className="text-[11px] text-muted-foreground italic">
                  来源：{doc.source}
                </span>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {doc.size != null && <span>大小 {formatSize(doc.size)}</span>}
            {doc.uploadedAt && (
              <>
                <span>·</span>
                <span>上传于 {formatDate(doc.uploadedAt)}</span>
              </>
            )}
            {doc.chunkCount != null && (
              <>
                <span>·</span>
                <span>{doc.chunkCount} 块切片</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab 条 */}
      {doc && showTabs && (
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <SimpleTabs
            tabs={[
              { value: 'content', label: '正文内容' },
              {
                value: 'chunks',
                label: `切片视图（${sameDoc ? chunkTotal : '—'}）`,
              },
            ]}
            value={tab}
            onChange={onTabChange}
          />
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {tab === 'chunks' && Number.isFinite(Number(chunks?.avgScore)) && (
              <ChunkScoreBadge
                score={Math.round(chunks.avgScore)}
                level={
                  chunks.avgScore >= 80
                    ? 'good'
                    : chunks.avgScore >= 60
                      ? 'fair'
                      : 'poor'
                }
                issues={[
                  `整篇均分 ${chunks.avgScore}（${chunks.scoreMode === 'hybrid' ? '混合评分：启发式 + 语义信号' : '启发式评分'}）`,
                ]}
              />
            )}
            <span className="inline-flex items-center gap-1">
              <Hash className="h-3 w-3 opacity-60" />
              切片有独立 displayTitle（不依赖 markdown heading）
            </span>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div
          className="mx-auto max-w-3xl px-4 py-4"
          {...(showTabs
            ? {
                id: `document-preview-panel-${tab}`,
                role: 'tabpanel',
                'aria-labelledby': `document-preview-tab-${tab}`,
                tabIndex: 0,
              }
            : {})}
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : doc ? (
            tab === 'content' ? (
              <div className="prose-chat">
                {doc.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {doc.content}
                  </ReactMarkdown>
                ) : doc.summary ? (
                  <p>{doc.summary}</p>
                ) : (
                  <p className="text-muted-foreground">
                    该文档无可预览的文本内容。
                  </p>
                )}
              </div>
            ) : (
              // —— 切片 Tab（面板细节见 ChunkListPanel）——
              <ChunkListPanel
                chunksLoading={chunksLoading}
                sameDoc={!!sameDoc}
                chunks={chunks}
                docId={doc.id}
                onLoadChunks={onLoadChunks}
              />
            )
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              选择左侧文档以预览内容
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export default DocumentPreview
