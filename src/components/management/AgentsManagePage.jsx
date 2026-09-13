import * as React from 'react'
import { Bot, Loader2, Plus, Pencil, Trash2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import {
  fetchAgentSpecs,
  createAgentSpec,
  updateAgentSpec,
  deleteAgentSpec,
} from '@/lib/managementApi'
import { ICON_MAP } from '@/lib/agentRegistry'

/**
 * AgentsManagePage —— 智能体管理（P1：Agent Spec CRUD）
 *
 * 卡片列表（内置徽章 / runtime 徽章 / 启用开关）+ 新建/编辑弹窗 + 删除。
 * 内置智能体：仅名称/描述/图标/别名/启停可改，不可删除。
 * 保存成功后广播 agents:changed → AppShell 重拉注册表，侧栏即时生效。
 */

const RUNTIME_LABEL = { builtin: '内置', chat: '对话', rag: '检索增强' }

/** 广播注册表变更（AppShell 监听重拉；跨标签经 localStorage 版本号） */
function notifyAgentsChanged() {
  try {
    localStorage.setItem('agentsVersion', String(Date.now()))
  } catch {
    /* 隐私模式忽略 */
  }
  window.dispatchEvent(new CustomEvent('agents:changed'))
}

/** 编辑/新建弹窗（内联轻量实现） */
function AgentEditDialog({ spec, onClose, onDone }) {
  const isEdit = Boolean(spec?.id)
  const builtIn = Boolean(spec?.builtIn)
  const [form, setForm] = React.useState({
    id: spec?.id ?? '',
    name: spec?.name ?? '',
    description: spec?.description ?? '',
    icon: spec?.icon ?? 'bot',
    aliases: (spec?.aliases ?? []).join(', '),
    runtime: spec?.runtime === 'rag' ? 'rag' : 'chat',
    systemPrompt: spec?.systemPrompt ?? '',
    structuredInput: spec?.structuredInput ?? false,
  })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target?.type === 'checkbox' ? e.target.checked : e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const aliases = form.aliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      if (isEdit) {
        // 内置仅展示层字段；自定义额外允许 runtime/systemPrompt/structuredInput
        const patch = builtIn
          ? { name: form.name, description: form.description, icon: form.icon, aliases }
          : {
              name: form.name, description: form.description, icon: form.icon, aliases,
              runtime: form.runtime, systemPrompt: form.systemPrompt,
              structuredInput: form.structuredInput,
            }
        await updateAgentSpec(spec.id, patch)
      } else {
        await createAgentSpec({
          id: form.id.trim(), name: form.name, description: form.description,
          icon: form.icon, aliases, runtime: form.runtime,
          systemPrompt: form.systemPrompt, structuredInput: form.structuredInput,
        })
      }
      notifyAgentsChanged()
      onDone(`${isEdit ? '已更新' : '已创建'} ${form.name || form.id}`)
    } catch (err) {
      setError(err?.message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="max-h-[86vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-card p-5 shadow-soft-md">
        <p className="text-sm font-semibold">
          {isEdit ? `编辑智能体 · ${spec.id}` : '新建智能体'}
          {builtIn && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] text-muted-foreground">
              内置 · 仅展示层可改
            </span>
          )}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {!isEdit && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">ID（创建后不可改）</label>
              <Input value={form.id} onChange={set('id')} placeholder="如 code-reviewer" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" required disabled={busy} />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">显示名称</label>
            <Input value={form.name} onChange={set('name')} placeholder="如 代码评审" maxLength={50} required disabled={busy} />
          </div>
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted-foreground">描述</label>
          <Input value={form.description} onChange={set('description')} placeholder="显示在侧栏与页头" maxLength={200} disabled={busy} />
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted-foreground">别名（逗号分隔，用于意图路由）</label>
          <Input value={form.aliases} onChange={set('aliases')} placeholder="如 review, 评审" disabled={busy} />
        </div>

        <div className="mt-3">
          <label className="mb-1 block text-xs text-muted-foreground">图标</label>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(ICON_MAP).map(([key, Comp]) => (
              <button
                key={key}
                type="button"
                onClick={() => setForm((f) => ({ ...f, icon: key }))}
                title={key}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground transition-colors',
                  form.icon === key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Comp className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>

        {!builtIn && (
          <>
            <div className="mt-3">
              <label className="mb-1 block text-xs text-muted-foreground">执行通道</label>
              <div className="flex gap-2">
                {[
                  { key: 'chat', label: '对话', desc: '直接按人设回答' },
                  { key: 'rag', label: '检索增强', desc: '先查知识库再回答' },
                ].map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, runtime: r.key }))}
                    className={cn(
                      'flex-1 rounded-md border p-2 text-left transition-colors',
                      form.runtime === r.key
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-accent/50',
                    )}
                  >
                    <p className="text-xs font-medium">{r.label}</p>
                    <p className="text-[10px] text-muted-foreground">{r.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>System Prompt（人设）</span>
                <span className={cn(form.systemPrompt.length > 4000 && 'text-destructive')}>
                  {form.systemPrompt.length}/4000
                </span>
              </label>
              <textarea
                value={form.systemPrompt}
                onChange={set('systemPrompt')}
                rows={5}
                maxLength={4000}
                placeholder={form.runtime === 'rag' ? '可选：追加在知识库助手规则之后的人设描述' : '完整人设，如「你是一位资深代码评审专家…」'}
                className="w-full rounded-md border bg-background p-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring/40"
                disabled={busy}
              />
            </div>

            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={form.structuredInput}
                onChange={set('structuredInput')}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
              启用结构化输入（技术栈多选，面试域专用样式）
            </label>
          </>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || !form.name.trim()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {isEdit ? '保存' : '创建'}
          </Button>
        </div>
      </form>
    </div>
  )
}

export function AgentsManagePage({ onLoadingChange }) {
  const { user: me } = useAuth()
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [notice, setNotice] = React.useState('')
  const [editing, setEditing] = React.useState(null) // spec 或 { } 表示新建
  const [deleting, setDeleting] = React.useState(null)
  const [busyId, setBusyId] = React.useState(null)

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchAgentSpecs()
      setItems(r.items ?? [])
    } catch (err) {
      setNotice(err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    reload()
  }, [reload])

  const toggleEnabled = async (spec) => {
    setBusyId(spec.id)
    setNotice('')
    try {
      await updateAgentSpec(spec.id, { enabled: !spec.enabled })
      notifyAgentsChanged()
      await reload()
      setNotice(`已${spec.enabled ? '停用' : '启用'} ${spec.name}`)
    } catch (err) {
      setNotice(err?.message || '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    setBusyId(deleting.id)
    setNotice('')
    try {
      const r = await deleteAgentSpec(deleting.id)
      notifyAgentsChanged()
      await reload()
      setNotice(r.mode === 'disabled' ? `${deleting.name} 已停用（保留历史会话，可重新启用）` : `已删除 ${deleting.name}`)
      setDeleting(null)
    } catch (err) {
      setNotice(err?.message || '删除失败')
      setDeleting(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">智能体管理</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Agent Spec 配置化：新建智能体无需写代码；改动保存后侧栏与路由实时生效
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          新建智能体
        </Button>
      </div>

      {notice && (
        <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{notice}</p>
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((spec) => {
            const Icon = ICON_MAP[spec.icon] ?? Bot
            const busy = busyId === spec.id
            return (
              <div
                key={spec.id}
                className={cn(
                  'rounded-xl border bg-card p-4 transition-opacity',
                  !spec.enabled && 'opacity-55',
                  busy && 'animate-pulse',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{spec.name}</p>
                      {spec.builtIn && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                          <Lock className="h-2.5 w-2.5" />
                          内置
                        </span>
                      )}
                      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
                        {RUNTIME_LABEL[spec.runtime] ?? spec.runtime}
                      </span>
                      {!spec.enabled && (
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">已停用</span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {spec.description || '—'}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                      {spec.id}
                      {spec.aliases?.length ? ` · 别名: ${spec.aliases.join(' / ')}` : ''}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between border-t pt-2.5">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={spec.enabled}
                      onChange={() => toggleEnabled(spec)}
                      disabled={busy}
                      className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                    />
                    {spec.enabled ? '启用中' : '已停用'}
                  </label>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(spec)}>
                      <Pencil className="mr-1 h-3 w-3" />
                      编辑
                    </Button>
                    {!spec.builtIn && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => setDeleting(spec)}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        删除
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <AgentEditDialog
          spec={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null)
            setNotice(msg)
            reload()
          }}
        />
      )}

      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && setDeleting(null)}>
          <div className="w-full max-w-sm rounded-xl border bg-card p-5 shadow-soft-md">
            <p className="text-sm font-semibold">删除智能体「{deleting.name}」？</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              将停止路由并从侧栏移除（历史会话保留，可重新启用恢复）。该操作不可彻底删除数据。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={busyId === deleting.id}>
                {busyId === deleting.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                确认删除
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 当前身份提示（与成员管理一致的登录态上下文） */}
      {me?.userId && (
        <p className="mt-6 text-right font-mono text-[10px] text-muted-foreground/60">
          operator: {me.userId}
        </p>
      )}
    </div>
  )
}

export default AgentsManagePage
