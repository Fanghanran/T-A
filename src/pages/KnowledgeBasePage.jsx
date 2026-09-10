import * as React from 'react'
import {
  Search,
  AlertCircle,
  FileSearch,
  Loader2,
  Plus,
  CopyCheck,
  Tags,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useKnowledgeBase } from '@/hooks/useKnowledgeBase'
import { CategoryTagFilter } from '@/components/knowledge/CategoryTagFilter'
import { DocumentList } from '@/components/knowledge/DocumentList'
import { DocumentUploader } from '@/components/knowledge/DocumentUploader'
import { DocumentPreview } from '@/components/knowledge/DocumentPreview'
import { ManualEntryDialog } from '@/components/knowledge/ManualEntryDialog'
import { DocumentEditDialog } from '@/components/knowledge/DocumentEditDialog'
import { DuplicatesDialog } from '@/components/knowledge/DuplicatesDialog'
import { GovernanceDialog } from '@/components/knowledge/GovernanceDialog'
import {
  SearchResultsPanel,
  SearchEmptyHint,
} from '@/components/knowledge/SearchResultsPanel'
import { BatchPromptDialog } from '@/components/knowledge/BatchPromptDialog'
import { cn } from '@/lib/utils'

/**
 * KnowledgeBasePage —— 知识库 / 文档管理子视图
 *
 * 视图组合：数据全部来自 useKnowledgeBase 编排器；
 * prompt/confirm 用 BatchPromptDialog 替代；检索结果面板用 SearchResultsPanel。
 *
 * @param {Object} props
 * @param {(busy:boolean)=>void} [props.onLoadingChange] 向 AppShell 上报忙碌状态
 */
export function KnowledgeBasePage({ onLoadingChange }) {
  const kb = useKnowledgeBase()
  const [searchQuery, setSearchQuery] = React.useState('')
  const [manualOpen, setManualOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [editingDoc, setEditingDoc] = React.useState(null)
  const [dupOpen, setDupOpen] = React.useState(false)
  const [govOpen, setGovOpen] = React.useState(false)
  // 批量弹窗：{ open, mode }  mode ∈ setCategory | addTags | removeTag | delete
  const [batchDialog, setBatchDialog] = React.useState({
    open: false,
    mode: 'setCategory',
  })

  // 预览：内容 / 切片 切换（选了新 doc 就默认切回"正文"Tab）
  const [previewTab, setPreviewTab] = React.useState('content')
  React.useEffect(() => {
    setPreviewTab('content')
  }, [kb.selectedDoc?.id])

  React.useEffect(() => {
    onLoadingChange?.(kb.busy)
  }, [kb.busy, onLoadingChange])

  const runSearch = (e) => {
    e?.preventDefault?.()
    kb.runSearch(searchQuery)
  }

  const hasSearch = kb.searchResults.length > 0
  const showPreview = !!kb.selectedDoc || kb.previewLoading

  const openEdit = (doc) => {
    if (!doc) return
    setEditingDoc(doc)
    setEditOpen(true)
  }
  const handleEditSubmit = async (changes, mode) => {
    if (!editingDoc?.id) return null
    if (mode === 'meta') return kb.updateMeta(editingDoc.id, changes)
    return kb.updateContent(editingDoc.id, changes.content)
  }

  // —— 批量操作（经 BatchPromptDialog，不再用 window.prompt/confirm）——
  const openBatchPrompt = (mode) => {
    if (!kb.selectedIds.length) return
    setBatchDialog({ open: true, mode })
  }
  const handleBatchConfirm = async (value) => {
    const { mode } = batchDialog
    setBatchDialog((s) => ({ ...s, open: false }))
    if (mode === 'setCategory') {
      await kb.batchSetCategory(value)
    } else if (mode === 'addTags') {
      const list = value.split(',').filter(Boolean)
      if (list.length) await kb.batchAddTags(list)
    } else if (mode === 'removeTag') {
      if (value) await kb.batchRemoveTag(value)
    } else if (mode === 'delete') {
      await kb.batchDelete()
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具栏：三组动作（检索 / 录入 / 库维护），窄屏自动换行 */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background/60 px-4 py-2.5 backdrop-blur-sm md:px-6">
        {/* 主组：语义检索 */}
        <form onSubmit={runSearch} className="relative min-w-[200px] flex-1 basis-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="语义检索：自然语言描述问题，返回相关知识片段…"
            className="pl-9"
            aria-label="语义检索"
          />
        </form>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={runSearch}
          disabled={kb.searching || !searchQuery.trim()}
        >
          {kb.searching ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <FileSearch className="mr-1.5 h-4 w-4" />
          )}
          检索
        </Button>

        {/* 录入组：上传（主按钮，组件内置）+ 手动新建 */}
        <div className="flex items-center gap-1.5 md:ml-2">
          <DocumentUploader
            uploading={kb.uploading}
            onUploaded={() => {
              kb.refresh()
              kb.loadFacets()
              kb.loadStats()
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setManualOpen(true)}
            disabled={kb.creating}
          >
            {kb.creating ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-4 w-4" />
            )}
            新建知识
          </Button>
        </div>

        {/* 库维护组：低频工具，紧凑 ghost（窄屏仅图标，title 提示） */}
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <span className="mr-1 hidden h-5 w-px bg-border md:block" aria-hidden />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() => setDupOpen(true)}
            title="扫描库内存量切片的重复对并清理"
          >
            <CopyCheck className="h-4 w-4" />
            <span className="hidden xl:inline">查重</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() => setGovOpen(true)}
            title="分类重命名 / 标签合并（全库批量）"
          >
            <Tags className="h-4 w-4" />
            <span className="hidden xl:inline">治理</span>
          </Button>
        </div>
      </div>

      {/* 内联错误条 */}
      {kb.error && (
        <div
          className="mx-4 mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive md:mx-6"
          role="alert"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {kb.error.message || '请求失败，请稍后重试。'}
          </span>
        </div>
      )}

      {/* 主体两栏：左 = 过滤 + 文档列表；右 = 检索结果 or 详情预览
          响应式：桌面双栏；移动端右栏有内容时升级为全屏 overlay（不与列表叠排） */}
      <div className="grid min-h-0 flex-1 md:grid-cols-[22rem_1fr]">
        <aside className="flex min-h-0 flex-col border-r">
          <div className="border-b p-3">
            <CategoryTagFilter
              filters={kb.filters}
              categories={kb.categories}
              tags={kb.tags}
              setFilter={kb.setFilter}
              resetFilters={kb.resetFilters}
              onRefresh={() => kb.refresh()}
            />
          </div>
          <DocumentList
            documents={kb.documents}
            loading={kb.loading}
            selectedId={kb.selectedDoc?.id}
            onSelect={kb.selectDoc}
            onDelete={kb.remove}
            removingId={kb.removingId}
            sort={kb.sort}
            setSort={kb.setSort}
            total={kb.total}
            page={kb.page}
            setPage={kb.setPage}
            pageSize={kb.pageSize}
            selectedIds={kb.selectedIds}
            onToggleSelectId={kb.toggleSelectId}
            onToggleSelectAll={kb.toggleSelectAllVisible}
            onClearSelection={kb.clearSelection}
            onEdit={openEdit}
            batchLoading={kb.batchLoading}
            onBatchDelete={() => openBatchPrompt('delete')}
            onBatchPrompt={openBatchPrompt}
          />
        </aside>

        <section
          className={cn(
            'flex min-h-0 flex-col bg-background md:bg-transparent',
            hasSearch || showPreview
              ? 'fixed inset-0 z-50 md:static md:inset-auto md:z-auto'
              : 'hidden md:flex',
          )}
        >
          {hasSearch ? (
            <SearchResultsPanel
              results={kb.searchResults}
              onSelectDoc={kb.selectDoc}
              onClearSearch={kb.clearSearch}
            />
          ) : showPreview ? (
            <DocumentPreview
              doc={kb.selectedDoc}
              loading={kb.previewLoading}
              onClose={() => kb.setSelectedDoc(null)}
              tab={previewTab}
              onTabChange={setPreviewTab}
              chunks={kb.selectedChunks}
              chunksLoading={kb.chunksLoading}
              chunksDocId={kb.chunksDocId}
              onLoadChunks={(docId, params) => kb.loadChunks(docId, params)}
              onEdit={openEdit}
              onDelete={(doc) => kb.remove(doc.id)}
            />
          ) : (
            <SearchEmptyHint />
          )}
        </section>
      </div>

      <ManualEntryDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        existingCategories={kb.categories.map((c) => c.name)}
        existingTags={kb.tags.map((t) => t.name)}
        onSubmit={kb.createManual}
        submitting={kb.creating}
      />
      <DocumentEditDialog
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v)
          if (!v) setEditingDoc(null)
        }}
        initialDoc={editingDoc}
        existingCategories={kb.categories.map((c) => c.name)}
        existingTags={kb.tags.map((t) => t.name)}
        onSubmit={handleEditSubmit}
        submitting={kb.updating}
      />
      <DuplicatesDialog
        open={dupOpen}
        onOpenChange={setDupOpen}
        onCleaned={() => {
          kb.refresh()
          kb.loadStats()
          if (kb.chunksDocId) kb.loadChunks(kb.chunksDocId, { page: 1 })
        }}
      />
      <GovernanceDialog
        open={govOpen}
        onOpenChange={setGovOpen}
        categories={kb.categories}
        tags={kb.tags}
        onChanged={() => {
          kb.refresh()
          kb.loadFacets()
          kb.loadStats()
        }}
      />
      <BatchPromptDialog
        open={batchDialog.open}
        onOpenChange={(open) => setBatchDialog((s) => ({ ...s, open }))}
        mode={batchDialog.mode}
        count={kb.selectedIds.length}
        onConfirm={handleBatchConfirm}
        submitting={kb.batchLoading}
      />
    </div>
  )
}

export default KnowledgeBasePage
