import * as React from 'react'
import {
  Plus,
  Trash2,
  MessageSquare,
  Pencil,
  ClipboardList,
  Check,
  X,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { cn } from '@/lib/utils'

/**
 * SessionSidebar —— 聊天页内侧的会话列表（每个智能体一份自己的会话）
 *
 * 设计：
 *  - 顶部「+ 新建对话」按钮
 *  - 会话项（按 updatedAt 倒序，后端已排序）：
 *      · 左 = 消息图标 + 标题（省略号截断，过长 title 悬停 tooltip）
 *      · 右 = 悬停显示「重命名 / 删除」图标
 *      · 点击整行切换当前会话
 *  - 新建会话后自动选中它；删除当前选中项时自动切到相邻项
 *  - 空态（一个会话都没有）时给一个友好提示
 *
 * @param {Object} props
 * @param {Array}  props.sessions
 * @param {string} props.currentSessionId
 * @param {boolean} [props.loading]
 * @param {(id:string)=>void} props.onSelect
 * @param {()=>Promise<any>} props.onCreate
 * @param {(id:string)=>Promise<any>} props.onDelete
 * @param {(id:string,title:string)=>Promise<any>} props.onRename
 * @param {(id:string)=>void} [props.onReport] 打开会话复盘报告
 */
export function SessionSidebar({
  sessions = [],
  currentSessionId = '',
  loading = false,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onReport,
}) {
  const [creating, setCreating] = React.useState(false)
  const [editingId, setEditingId] = React.useState('')
  // 待删除会话（删除前二次确认，替代 window.confirm）
  const [confirmDeleteId, setConfirmDeleteId] = React.useState('')
  const [editingValue, setEditingValue] = React.useState('')
  const renameInputRef = React.useRef(null)

  React.useEffect(() => {
    if (editingId && renameInputRef.current) renameInputRef.current.focus()
  }, [editingId])

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    try {
      await onCreate?.()
    } finally {
      setCreating(false)
    }
  }

  const beginRename = (e, sess) => {
    e.stopPropagation()
    setEditingId(sess.id)
    setEditingValue(sess.title ?? '')
  }
  const commitRename = async () => {
    if (!editingId) return
    const title = editingValue.trim().slice(0, 100)
    if (title) {
      try {
        await onRename?.(editingId, title)
      } catch {
        /* ignore: hook 已 log */
      }
    }
    setEditingId('')
    setEditingValue('')
  }
  const cancelRename = (e) => {
    e?.stopPropagation?.()
    setEditingId('')
    setEditingValue('')
  }

  /** 删除入口：记录待删会话并弹确认（替代 window.confirm） */
  const handleDelete = (e, id) => {
    e.stopPropagation()
    if (!id) return
    setConfirmDeleteId(id)
  }

  /** 确认后执行真实删除 */
  const handleConfirmDelete = async () => {
    const id = confirmDeleteId
    setConfirmDeleteId('')
    if (!id) return
    await onDelete?.(id)
  }

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card/40">
      {/* 顶部：新建对话 */}
      <div className="border-b p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={handleCreate}
          disabled={creating}
        >
          {creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          <span className="truncate text-xs">新建对话</span>
        </Button>
      </div>

      {/* 会话列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            加载中…
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-2 py-10 text-center">
            <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              暂无会话
              <br />
              点击上方「新建对话」开始
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((sess) => {
              const active = sess.id === currentSessionId
              const editing = sess.id === editingId
              const title = sess.title?.trim() || '新对话'
              return (
                <li key={sess.id}>
                  <div
                    role="button"
                    tabIndex={editing ? -1 : 0}
                    onClick={() => !editing && onSelect?.(sess.id)}
                    onKeyDown={(e) => {
                      if (editing) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelect?.(sess.id)
                      }
                    }}
                    title={title}
                    className={cn(
                      'group relative flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors cursor-pointer',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground',
                    )}
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />

                    {editing ? (
                      <div
                        className="flex min-w-0 flex-1 items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          ref={renameInputRef}
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitRename()
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelRename()
                            }
                          }}
                          className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                          maxLength={100}
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            commitRename()
                          }}
                          className="shrink-0 rounded p-0.5 text-emerald-600 hover:bg-emerald-500/10"
                          title="确定"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10"
                          title="取消"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate">{title}</span>
                        <div
                          className={cn(
                            'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity',
                            'group-hover:opacity-100',
                            active && 'opacity-100',
                          )}
                        >
                          <button
                            type="button"
                            onClick={(e) => beginRename(e, sess)}
                            className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                            title="重命名"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onReport?.(sess.id)
                            }}
                            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            title="复盘报告"
                          >
                            <ClipboardList className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDelete(e, sess.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title="删除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* 底部提示 */}
      <div className="border-t p-3 text-[10px] leading-relaxed text-muted-foreground">
        会话按最近更新排序，切换智能体时各自独立。
      </div>

      {/* 删除会话二次确认 */}
      <ConfirmDialog
        open={!!confirmDeleteId}
        onOpenChange={(v) => !v && setConfirmDeleteId('')}
        destructive
        title="删除会话"
        description="确定要删除该会话吗？历史消息将无法恢复。"
        confirmLabel="确认删除"
        onConfirm={handleConfirmDelete}
      />
    </aside>
  )
}

export default SessionSidebar
