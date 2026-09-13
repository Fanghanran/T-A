import * as React from 'react'
import { Loader2, RefreshCw, ShieldCheck, Plus, Trash2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/PageHeader'
import { SectionTitle } from '@/components/management/SectionTitle'
import { fetchAuthRoles, createAuthRole, updateAuthRole, deleteAuthRole } from '@/lib/managementApi'
import { cn } from '@/lib/utils'

/**
 * RolesManagePage —— 角色管理页（RBAC 权限矩阵，mgmt.roles 权限专属）
 *
 * 角色卡片列表：每张卡展示角色信息 + 权限点勾选矩阵（按分组分区）。
 *   - admin：内置全权，完全锁定（不展示矩阵）
 *   - member：内置，可调整权限集（不可改名）
 *   - 自定义角色：可改名/描述/权限集，可删除（被启用账号引用时后端拒绝）
 * 保存即生效：受影响用户刷新页面即拿到新界面可见性；后端端点同步按权限放行。
 */

function PermMatrix({ perms, checked, onToggle, disabled }) {
  const groups = []
  for (const p of perms) {
    let g = groups.find((x) => x.group === p.group)
    if (!g) {
      g = { group: p.group, items: [] }
      groups.push(g)
    }
    g.items.push(p)
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups.map((g) => (
        <div key={g.group} className="rounded-lg border bg-background/50 p-2.5">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.group}</p>
          <div className="flex flex-col gap-1">
            {g.items.map((p) => {
              const on = checked.includes(p.key)
              return (
                <label
                  key={p.key}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-accent/40',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]"
                    checked={on}
                    disabled={disabled}
                    onChange={() => onToggle(p.key)}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] leading-tight">{p.label}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{p.desc}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 新建角色对话框 */
function CreateRoleDialog({ onClose, onDone }) {
  const [roleId, setRoleId] = React.useState('')
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [checked, setChecked] = React.useState([])
  const [catalog, setCatalog] = React.useState([])

  React.useEffect(() => {
    fetchAuthRoles()
      .then((r) => setCatalog(r?.catalog ?? []))
      .catch(() => {})
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await createAuthRole({ roleId: roleId.trim(), name: name.trim(), perms: checked })
      onDone(`已创建角色 ${roleId.trim()}`)
    } catch (err) {
      setError(err?.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border bg-card p-5 shadow-soft">
        <p className="text-sm font-semibold">新建角色</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">角色 ID（英文标识）</label>
            <Input value={roleId} onChange={(e) => setRoleId(e.target.value)} placeholder="如 reviewer" required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">显示名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 评审员" required />
          </div>
        </div>
        <div className="mt-3">
          <p className="mb-1.5 text-xs text-muted-foreground">初始权限</p>
          <PermMatrix
            perms={catalog}
            checked={checked}
            disabled={busy}
            onToggle={(k) => setChecked((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))}
          />
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || !roleId.trim() || !name.trim()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            创建
          </Button>
        </div>
      </form>
    </div>
  )
}

export function RolesManagePage() {
  const [roles, setRoles] = React.useState([])
  const [catalog, setCatalog] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busyId, setBusyId] = React.useState('')
  const [drafts, setDrafts] = React.useState({}) // roleId -> 编辑中的 perms
  const [creating, setCreating] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchAuthRoles()
      setRoles(r?.items ?? [])
      setCatalog(r?.catalog ?? [])
      setDrafts({})
    } catch (err) {
      setError(err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const draftOf = (r) => drafts[r.roleId] ?? r.perms ?? []
  const togglePerm = (roleId, key) =>
    setDrafts((prev) => {
      const base = prev[roleId] ?? roles.find((x) => x.roleId === roleId)?.perms ?? []
      return { ...prev, [roleId]: base.includes(key) ? base.filter((x) => x !== key) : [...base, key] }
    })
  const dirty = (r) => {
    const d = drafts[r.roleId]
    return Array.isArray(d) && d.join('|') !== (r.perms ?? []).join('|')
  }

  const savePerms = async (r) => {
    setBusyId(r.roleId)
    setError('')
    setNotice('')
    try {
      await updateAuthRole(r.roleId, { perms: drafts[r.roleId] })
      setNotice(`角色 ${r.roleId} 的权限已更新（受影响用户刷新页面后生效）`)
      await load()
    } catch (err) {
      setError(err?.message || '保存失败')
    } finally {
      setBusyId('')
    }
  }

  const removeRole = async (r) => {
    if (!window.confirm(`确认删除角色「${r.name}」？`)) return
    setBusyId(r.roleId)
    setError('')
    setNotice('')
    try {
      await deleteAuthRole(r.roleId)
      setNotice(`已删除角色 ${r.roleId}`)
      await load()
    } catch (err) {
      setError(err?.message || '删除失败')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader icon={ShieldCheck} title="角色管理" description="角色与权限矩阵 · 控制界面与菜单可见性">
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {loading ? '刷新中…' : '刷新'}
          </Button>
          <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            新建角色
          </Button>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl animate-page-in px-4 py-6 md:px-6">
          {error && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
              {notice}
            </div>
          )}

          <SectionTitle icon={<ShieldCheck className="h-3.5 w-3.5" />} title={`角色（${roles.length}）`} />

          <div className="flex flex-col gap-4">
            {roles.map((r) => {
              const isAdmin = r.roleId === 'admin'
              const busy = busyId === r.roleId
              const checked = draftOf(r)
              return (
                <Card key={r.roleId} className={cn('py-0', busy && 'opacity-60')}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-sm font-semibold">
                          {r.name}
                          <span className="font-mono text-[11px] font-normal text-muted-foreground">{r.roleId}</span>
                          {r.builtIn && (
                            <span className="inline-flex items-center gap-0.5 rounded-full border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              <Lock className="h-2.5 w-2.5" />
                              内置
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {r.description || '—'} · 引用成员 {r.userCount}
                        </p>
                      </div>
                      {isAdmin ? (
                        <span className="rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                          全部权限
                        </span>
                      ) : (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            disabled={busy || !dirty(r)}
                            onClick={() => savePerms(r)}
                          >
                            保存权限
                          </Button>
                          {!r.builtIn && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              disabled={busy}
                              onClick={() => removeRole(r)}
                            >
                              <Trash2 className="mr-1 h-3 w-3" />
                              删除
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                    {!isAdmin && (
                      <div className="mt-3">
                        <PermMatrix
                          perms={catalog}
                          checked={checked}
                          disabled={busy}
                          onToggle={(k) => togglePerm(r.roleId, k)}
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            权限同时控制前端菜单/页面可见性与对应管理端点；保存后受影响用户刷新页面即生效（后端立即按新权限判定）。
          </p>
        </div>
      </div>

      {creating && (
        <CreateRoleDialog
          onClose={() => setCreating(false)}
          onDone={(msg) => {
            setCreating(false)
            setNotice(msg)
            load()
          }}
        />
      )}
    </div>
  )
}

export default RolesManagePage
