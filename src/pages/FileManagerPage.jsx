import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Folder,
  FileText,
  File,
  Download,
  Trash2,
  RefreshCw,
  Loader2,
  Search,
  BookOpen,
  HardDrive,
  Plus,
  Pencil,
  CopyCheck,
  Tags,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { useKnowledgeBase } from '@/hooks/useKnowledgeBase'
import { DocumentUploader } from '@/components/knowledge/DocumentUploader'
import { ManualEntryDialog } from '@/components/knowledge/ManualEntryDialog'
import { DocumentEditDialog } from '@/components/knowledge/DocumentEditDialog'
import { DuplicatesDialog } from '@/components/knowledge/DuplicatesDialog'
import { GovernanceDialog } from '@/components/knowledge/GovernanceDialog'
import { CategoryTagFilter } from '@/components/knowledge/CategoryTagFilter'
import { downloadUrl } from '@/lib/filesApi'
import { cn } from '@/lib/utils'

/**
 * FileManagerPage —— 知识管理（文件管理器风格）
 *
 * 风格：文件管理器（左侧位置栏 + 右侧文件表格 + 行内操作），
 * 功能：全量接入 useKnowledgeBase 编排器（上传对话框 / 新建知识 / 编辑 /
 * 删除 / 查重 / 治理 / 检索条件）—— 与原「文档管理」页功能一致，仅形态不同。
 * 数据经 vectorStore 门面走 v3 三级存储（文件持久层 + 锚点层）。
 */

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function extIcon(ext) {
  const e = String(ext || '').toLowerCase()
  if (['md', 'markdown', 'txt', 'docx'].includes(e)) return FileText
  return File
}

export function FileManagerPage({ onLoadingChange }) {
  const navigate = useNavigate()
  const kb = useKnowledgeBase()
  const [category, setCategory] = React.useState('')
  const [keyword, setKeyword] = React.useState('')
  const [manualOpen, setManualOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [editingDoc, setEditingDoc] = React.useState(null)
  const [dupOpen, setDupOpen] = React.useState(false)
  const [govOpen, setGovOpen] = React.useState(false)

  React.useEffect(() => {
    onLoadingChange?.(kb.busy)
  }, [kb.busy, onLoadingChange])

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

  // 两步删除确认：不依赖 window.confirm（内嵌浏览器/部分环境会静默吞掉弹窗）
  const [pendingDeleteId, setPendingDeleteId] = React.useState(null)
  const pendingTimer = React.useRef(null)

  const handleDelete = async (doc) => {
    const id = doc.docId || doc.id
    if (!id) return
    // 第一次点击：进入待确认态（4 秒内再点一次才真正删除）
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id)
      clearTimeout(pendingTimer.current)
      pendingTimer.current = setTimeout(() => setPendingDeleteId(null), 4000)
      return
    }
    clearTimeout(pendingTimer.current)
    setPendingDeleteId(null)
    await kb.remove(id)
  }

  // 列表数据：kb.documents（v3 锚点层，含切片数）——补充 ext 字段用于图标
  const files = React.useMemo(
    () =>
      (kb.documents ?? []).map((d) => ({
        ...d,
        ext: (d.title?.match(/\.([a-z0-9]+)$/i) || [])[1] ?? '',
      })),
    [kb.documents],
  )

  const categories = React.useMemo(() => {
    const map = new Map()
    for (const f of files) {
      const key = f.category || '未分类'
      map.set(key, (map.get(key) || 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [files])

  const shown = React.useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return files.filter((f) => {
      if (category && (f.category || '未分类') !== category) return false
      if (kw && !f.title.toLowerCase().includes(kw)) return false
      return true
    })
  }, [files, category, keyword])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Folder}
        title="知识管理"
        description={
          kb.stats
            ? `${kb.stats.documents ?? 0} 个文件 · ${kb.stats.chunks ?? 0} 个切片`
            : '正在统计…'
        }
      >
        <div className="flex items-center gap-1.5">
          <DocumentUploader
            uploading={kb.uploading}
            onUploaded={() => {
              kb.refresh()
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5"
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
            className="h-8 gap-1.5"
            onClick={() => setGovOpen(true)}
            title="分类重命名 / 标签合并（全库批量）"
          >
            <Tags className="h-4 w-4" />
            <span className="hidden xl:inline">治理</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5"
            disabled={kb.loading}
            onClick={() => kb.refresh()}
          >
            {kb.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            刷新
          </Button>
        </div>
      </PageHeader>

      {kb.error && (
        <div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          {kb.error.message || '请求失败，请稍后重试。'}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左：位置栏（检索条件 + 分类目录） */}
        <aside className="scrollbar-thin w-52 shrink-0 overflow-y-auto border-r">
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
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" />
            位置
          </div>
          <button
            type="button"
            onClick={() => setCategory('')}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
              category === '' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
          >
            <Folder className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">全部文件</span>
            <span className="text-[10px] text-muted-foreground">{files.length}</span>
          </button>
          {categories.map(([name, count]) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategory(name)}
              className={cn(
                'flex w-full items-center gap-2 py-1.5 pl-6 pr-3 text-left text-xs transition-colors',
                category === name ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <Folder className="h-3 w-3" />
              <span className="flex-1 truncate">{name}</span>
              <span className="text-[10px] text-muted-foreground">{count}</span>
            </button>
          ))}
        </aside>

        {/* 右：文件列表 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按文件名筛选…"
              className="h-7 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0"
            />
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {shown.length} / {files.length}
            </span>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {kb.loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在加载文件列表…
              </div>
            ) : shown.length === 0 ? (
              <div className="py-10 text-center text-xs text-muted-foreground">
                没有文件，点击右上角「上传文件」开始
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background/95 text-[10px] text-muted-foreground backdrop-blur">
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left font-medium">名称</th>
                    <th className="w-16 px-2 py-2 text-left font-medium">类型</th>
                    <th className="w-20 px-2 py-2 text-right font-medium">大小</th>
                    <th className="w-16 px-2 py-2 text-right font-medium">切片</th>
                    <th className="w-40 px-2 py-2 text-left font-medium">状态</th>
                    <th className="w-28 px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((f) => {
                    const Icon = extIcon(f.ext)
                    return (
                      <tr key={f.docId || f.id} className="border-b hover:bg-accent/40">
                        <td className="max-w-0 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => navigate(`/knowledge/read/${f.docId || f.id}`)}
                            className="flex w-full items-center gap-2 text-left hover:underline"
                            title={f.title}
                          >
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{f.title}</span>
                          </button>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {f.ext ? f.ext.toUpperCase() : '—'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[11px] text-muted-foreground">
                          {formatSize(f.size)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[11px] text-muted-foreground">
                          {f.chunkCount ?? 0}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            <Badge
                              variant={f.status === 'indexed' ? 'secondary' : 'outline'}
                              className="text-[10px]"
                            >
                              {f.status === 'indexed' ? '已入库' : f.status}
                            </Badge>
                            {f.fileExists === false && (
                              <Badge
                                variant="destructive"
                                className="text-[10px]"
                                title="锚点层有记录但磁盘文件缺失"
                              >
                                文件缺失
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="切片阅读"
                              onClick={() => navigate(`/knowledge/read/${f.docId || f.id}`)}
                            >
                              <BookOpen className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="编辑"
                              onClick={() => openEdit(f)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <a href={downloadUrl(f.docId || f.id)} download title="下载原件">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                tabIndex={-1}
                              >
                                <Download className="h-3.5 w-3.5" />
                              </Button>
                            </a>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={
                                pendingDeleteId === (f.docId || f.id)
                                  ? 'h-6 w-6 bg-destructive text-destructive-foreground hover:bg-destructive/90'
                                  : 'h-6 w-6 hover:text-destructive'
                              }
                              title={
                                pendingDeleteId === (f.docId || f.id)
                                  ? '再点一次确认删除'
                                  : '删除'
                              }
                              disabled={kb.removingId === (f.docId || f.id)}
                              onClick={() => handleDelete(f)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </main>
      </div>

      {/* 功能对话框（与原「文档管理」页同一套组件） */}
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
    </div>
  )
}

export default FileManagerPage
