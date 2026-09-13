import * as React from 'react'
import { Loader2, Trash2, Download } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { request } from '@/lib/api'

/**
 * FavoritesDialog —— 收藏夹 / 错题本（跨会话的个人复习集，owner 隔离）
 * 列表 / 删除 / 导出 Markdown（复习笔记格式）。
 */
export function FavoritesDialog({ open, onOpenChange }) {
  const [items, setItems] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async () => {
    if (!open) return
    setLoading(true)
    setError('')
    try {
      const r = await request('/api/favorites')
      setItems(r.items ?? [])
    } catch (err) {
      setError(err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [open])

  React.useEffect(() => {
    if (open) load()
  }, [open, load])

  const remove = async (id) => {
    try {
      await request(`/api/favorites/${id}`, { method: 'DELETE' })
      setItems((prev) => (prev ?? []).filter((f) => f.id !== id))
    } catch (err) {
      setError(err?.message || '删除失败')
    }
  }

  const exportMd = () => {
    const lines = (items ?? []).map(
      (f, i) =>
        `## ${i + 1}. ${f.title || '收藏'}\n\n- 收藏时间：${new Date(f.createdAt).toLocaleString()}\n\n${f.content}\n`,
    )
    const md = `# 我的收藏（错题本）\n\n${lines.join('\n---\n\n')}\n`
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `favorites-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogTitle>我的收藏（错题本）</DialogTitle>
        <DialogDescription>跨会话的个人复习集，按收藏时间倒序。</DialogDescription>

        {loading && (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}

        {!loading && (items ?? []).length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            还没有收藏。在对话回答下方点 ⭐ 即可收藏到错题本。
          </div>
        )}

        {!loading && (items ?? []).length > 0 && (
          <div className="space-y-2">
            {(items ?? []).map((f) => (
              <div key={f.id} className="rounded-md border px-3 py-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.title || '收藏'}</p>
                    <p className="line-clamp-3 text-xs text-muted-foreground">{f.content}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {new Date(f.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(f.id)}
                    title="删除"
                    className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter className="mt-2 flex items-center justify-between sm:justify-between">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={exportMd}
            disabled={loading || !(items ?? []).length}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            导出 Markdown
          </Button>
          <span className="text-[11px] text-muted-foreground">{(items ?? []).length} 条</span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default FavoritesDialog
