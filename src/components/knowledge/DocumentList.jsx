import * as React from 'react'
import { Inbox, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from './Checkbox'
import { PageButtons } from './PageButtons'
import { DocumentRow } from './DocumentRow'
import { BatchToolbar } from './BatchToolbar'
import { SORT_OPTIONS } from '@/lib/documentListUtils'
import { cn } from '@/lib/utils'

/**
 * DocumentList（升级增强版 F4 / F6）
 *
 * 新增 props：
 * - sort / setSort
 * - total / page / setPage / pageSize
 * - selectedIds / onToggleSelectId / onToggleSelectAll / onClearSelection
 * - editingId / onEdit（单篇编辑按钮，走父级 DocumentEditDialog）
 * - batchLoading
 * - onBatchDelete / onBatchSetCategory / onBatchAddTags / onBatchRemoveTag
 * - onBatchPrompt(mode:'addTags'|'removeTag'|'setCategory')  —— 让父级弹 prompt 输入
 *
 * 向后兼容：不传 checkbox 相关 props → 展示为纯只读 / 单选列表（近似旧版）。
 */
export function DocumentList({
  documents,
  loading,
  selectedId,
  onSelect,
  onDelete,
  removingId,

  // —— 排序 / 分页 ——
  sort,
  setSort,
  total,
  page,
  setPage,
  pageSize,

  // —— 批量选择 ——
  selectedIds,
  onToggleSelectId,
  onToggleSelectAll,
  onClearSelection,
  editingId,
  onEdit,
  batchLoading,

  // —— 批量操作回调 ——
  onBatchDelete,
  onBatchPrompt,
}) {
  const hasBatch = Array.isArray(selectedIds)

  // 可见行是否全部选中（决定 header 复选框状态）
  const visibleIds = React.useMemo(
    () => documents.map((d) => d.id),
    [documents],
  )
  const allVisibleSelected =
    hasBatch &&
    visibleIds.length > 0 &&
    visibleIds.every((id) => selectedIds.includes(id))
  const someVisibleSelected =
    hasBatch && visibleIds.some((id) => selectedIds.includes(id))

  const totalPages = Math.max(
    1,
    Math.ceil(Number(total ?? 0) / Number(pageSize ?? 20)),
  )
  const selN = hasBatch ? selectedIds.length : 0

  const selectClass = cn(
    'h-8 rounded-md border border-input bg-background px-2 text-xs',
    'transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部工具栏：排序 + 计数 */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowUpDown className="h-3.5 w-3.5" />
          排序
        </div>
        <select
          className={cn(selectClass, 'min-w-[150px]')}
          value={sort ?? 'createdDesc'}
          disabled={!setSort || loading}
          onChange={(e) => setSort?.(e.target.value)}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {total != null ? `${total.toLocaleString()} 篇` : null}
          {selN > 0 ? (
            <span className="ml-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
              已选 {selN}
            </span>
          ) : null}
        </div>
      </div>

      {/* 批量工具栏 */}
      <BatchToolbar
        selN={selN}
        batchLoading={batchLoading}
        onClearSelection={onClearSelection}
        onBatchPrompt={onBatchPrompt}
        onBatchDelete={onBatchDelete}
      />

      <ScrollArea className="flex-1 min-h-0 scrollbar-thin">
        <div className="flex flex-col gap-1.5 p-2">
          {loading && documents.length === 0 && (
            <>
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="h-16 animate-pulse rounded-md bg-muted/60"
                />
              ))}
            </>
          )}

          {!loading && documents.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-dashed bg-muted/30">
                <Inbox className="h-5 w-5 text-muted-foreground/70" />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm text-foreground/80">暂无文档</p>
                <p className="text-xs text-muted-foreground">
                  点击上方「上传」或「新建知识」录入第一篇
                </p>
              </div>
            </div>
          )}

          {/* 表头（仅批量模式下显示，给"全选"一个视觉锚点，也避免复选框突兀） */}
          {hasBatch && documents.length > 0 && (
            <div className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected && !allVisibleSelected}
                disabled={loading || batchLoading}
                onCheckedChange={() => onToggleSelectAll?.()}
                title={allVisibleSelected ? '取消全选当前页' : '全选当前页'}
              />
              <span className="ml-1">标题 / 分类 / 时间</span>
              <span className="ml-auto">操作</span>
            </div>
          )}

          {documents.map((doc) => {
            const active = doc.id === selectedId
            const removing = doc.id === removingId || editingId === doc.id
            const selected = hasBatch && selectedIds.includes(doc.id)
            return (
              <DocumentRow
                key={doc.id}
                doc={doc}
                active={active}
                removing={removing}
                selected={selected}
                hasBatch={hasBatch}
                onSelect={onSelect}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggleSelectId={onToggleSelectId}
                batchLoading={batchLoading}
              />
            )
          })}
        </div>
      </ScrollArea>

      {/* 分页器（当 total>pageSize 时出现） */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="tabular-nums">
              第 {page} / {totalPages} 页 · 共 {total} 篇
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={page <= 1 || !setPage || loading}
              onClick={() => setPage?.(Math.max(1, page - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              上一页
            </Button>
            {/* 快速页码按钮（最多 7 个点） */}
            <PageButtons
              page={page}
              totalPages={totalPages}
              onGo={setPage}
              disabled={loading}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={page >= totalPages || !setPage || loading}
              onClick={() => setPage?.(Math.min(totalPages, page + 1))}
            >
              下一页
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentList
