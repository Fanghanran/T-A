import * as React from 'react'
import { Loader2, RefreshCw, UserRound, Ban, LockOpen, KeyRound, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/PageHeader'
import { SectionTitle } from '@/components/management/SectionTitle'
import { useAuth } from '@/hooks/useAuth'
import {
  fetchAuthUsers,
  fetchAuthRoles,
  createAuthUser,
  deleteAuthUser,
  setAuthUserRole,
  setAuthUserStatus,
  unlockAuthUser,
  resetAuthUserPassword,
} from '@/lib/managementApi'
import { cn } from '@/lib/utils'

/**
 * UsersManagePage —— 成员管理页（系统管理子菜单，mgmt.users 权限专属）
 *
 * 用户账号 CRUD + 角色分配（角色列表来自角色管理）+ 禁用/解锁/重置密码。
 * 保护规则（后端强制）：不能修改/删除/禁用自己；不能动最后一个 active 管理员；
 * 删除仅移除账号本身（业务数据保留）。全部操作写操作审计（auth.* 动作族）。
 */

function StatusDot({ status }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={cn('h-1.5 w-1.5 rounded-full', status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
        aria-hidden
      />
      {status === 'active' ? '启用' : '禁用'}
    </span>
  )
}

/** 新建成员对话框 */
function CreateUserDialog({ roles, onClose, onDone }) {
  const [userId, setUserId] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [role, setRole] = React.useState('member')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await createAuthUser({ userId: userId.trim(), password, label: label.trim(), role })
      onDone(`已创建成员 ${userId.trim()}`)
    } catch (err) {
      setError(err?.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-5 shadow-soft">
        <p className="text-sm font-semibold">新建成员</p>
        <div className="mt-3 flex flex-col gap-2.5">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">用户 ID</label>
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="字母数字下划线连字符" autoFocus required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">初始密码（6~16 位）</label>
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" maxLength={16} minLength={6} required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">备注（可选）</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="姓名 / 用途" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">角色</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              {roles.map((r) => (
                <option key={r.roleId} value={r.roleId}>
                  {r.name}（{r.roleId}）
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || !userId.trim() || password.length < 6}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            创建
          </Button>
        </div>
      </form>
    </div>
  )
}

/** 重置密码对话框（内联轻量实现：输入新密码 → 提交） */
function ResetPasswordDialog({ user, onClose, onDone }) {
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await resetAuthUserPassword(user.userId, password)
      onDone(`已重置 ${user.userId} 的密码`)
    } catch (err) {
      setError(err?.message || '重置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-5 shadow-soft">
        <p className="text-sm font-semibold">
          重置密码 · <span className="font-mono">{user.userId}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">不验证旧密码；重置后同时清除登录锁定，该用户需重新登录。</p>
        <Input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="新密码（6~16 位）"
          autoComplete="new-password"
          className="mt-3"
          maxLength={16}
          minLength={6}
          autoFocus
          required
        />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy || password.length < 6}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            确认重置
          </Button>
        </div>
      </form>
    </div>
  )
}

export function UsersManagePage() {
  const { user: me } = useAuth()
  const [items, setItems] = React.useState([])
  const [admins, setAdmins] = React.useState(0)
  const [roles, setRoles] = React.useState([])
  const [roleName, setRoleName] = React.useState({}) // roleId -> 显示名
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busyId, setBusyId] = React.useState('')
  const [resetTarget, setResetTarget] = React.useState(null)
  const [creating, setCreating] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [r, rr] = await Promise.all([fetchAuthUsers(), fetchAuthRoles()])
      setItems(r?.items ?? [])
      setAdmins(r?.admins ?? 0)
      const list = rr?.items ?? []
      setRoles(list)
      setRoleName(Object.fromEntries(list.map((x) => [x.roleId, x.name])))
    } catch (err) {
      setError(err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  /** 行内操作统一入口：busy 态 + 错误/成功提示 + 刷新列表 */
  const act = async (user, fn, okMsg) => {
    setBusyId(user.userId)
    setError('')
    setNotice('')
    try {
      const r = await fn()
      setNotice(typeof okMsg === 'function' ? okMsg(r) : okMsg)
      await load()
    } catch (err) {
      setError(err?.message || '操作失败')
    } finally {
      setBusyId('')
    }
  }

  const isLastAdmin = (u) => u.role === 'admin' && u.status === 'active' && admins <= 1
  const isSelf = (u) => me?.userId === u.userId

  return (
    <div className="flex h-full flex-col">
      <PageHeader icon={UserRound} title="成员管理" description="账号增删改查 · 角色分配 · 禁用与解锁 · 密码重置">
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {loading ? '刷新中…' : '刷新'}
          </Button>
          <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
            <UserPlus className="h-3.5 w-3.5" />
            新建成员
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

          <section>
            <SectionTitle icon={<UserRound className="h-3.5 w-3.5" />} title={`成员账号（${items.length}） · 管理员 ${admins}`} />
            <Card className="py-0">
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-medium">成员</th>
                      <th className="px-3 py-2 font-medium">角色</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="hidden px-3 py-2 font-medium md:table-cell">最近登录</th>
                      <th className="px-3 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((u) => {
                      const busy = busyId === u.userId
                      const canChangeRole = !isSelf(u) && !isLastAdmin(u)
                      return (
                        <tr key={u.userId} className={cn('border-b last:border-0', busy && 'opacity-50')}>
                          <td className="px-4 py-2.5">
                            <p className="font-mono text-[13px] font-medium">{u.userId}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {[u.label, u.authType].filter(Boolean).join(' · ')}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <select
                              value={u.role}
                              disabled={busy || !canChangeRole}
                              title={isSelf(u) ? '不能修改自己的角色' : isLastAdmin(u) ? '不能降级唯一的管理员' : '切换角色'}
                              onChange={(e) => {
                                const nextRole = e.target.value
                                act(
                                  u,
                                  () => setAuthUserRole(u.userId, nextRole),
                                  () => `已将 ${u.userId} 角色调整为 ${roleName[nextRole] ?? nextRole}`,
                                )
                              }}
                              className={cn(
                                'h-7 rounded-md border bg-background px-1.5 text-xs',
                                !canChangeRole && 'cursor-not-allowed opacity-60',
                              )}
                            >
                              {roles.map((r) => (
                                <option key={r.roleId} value={r.roleId}>
                                  {r.name}（{r.roleId}）
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2.5">
                            <StatusDot status={u.status} />
                          </td>
                          <td className="hidden px-3 py-2.5 text-xs text-muted-foreground md:table-cell">
                            {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '从未登录'}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={busy || (isSelf(u) && u.status === 'active') || (u.status === 'active' && isLastAdmin(u))}
                                title={
                                  isSelf(u)
                                    ? '不能禁用自己'
                                    : u.status === 'active' && isLastAdmin(u)
                                      ? '不能禁用唯一的管理员'
                                      : u.status === 'active'
                                        ? '禁用该账号（登录被拒 403）'
                                        : '重新启用该账号'
                                }
                                onClick={() =>
                                  act(
                                    u,
                                    () => setAuthUserStatus(u.userId, u.status === 'active' ? 'disabled' : 'active'),
                                    () => (u.status === 'active' ? `已禁用 ${u.userId}` : `已启用 ${u.userId}`),
                                  )
                                }
                              >
                                <Ban className="mr-1 h-3 w-3" />
                                {u.status === 'active' ? '禁用' : '启用'}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={busy}
                                title="清除登录失败锁定"
                                onClick={() => act(u, () => unlockAuthUser(u.userId), `已解锁 ${u.userId}`)}
                              >
                                <LockOpen className="mr-1 h-3 w-3" />
                                解锁
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={busy}
                                title="为该账号设置新密码"
                                onClick={() => setResetTarget(u)}
                              >
                                <KeyRound className="mr-1 h-3 w-3" />
                                重置密码
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                disabled={busy || isSelf(u) || isLastAdmin(u)}
                                title={isSelf(u) ? '不能删除自己' : isLastAdmin(u) ? '不能删除唯一的管理员' : '删除该账号（业务数据保留）'}
                                onClick={() => {
                                  if (window.confirm(`确认删除成员「${u.userId}」？该操作不可撤销（业务数据保留）。`)) {
                                    act(u, () => deleteAuthUser(u.userId), `已删除 ${u.userId}`)
                                  }
                                }}
                              >
                                <Trash2 className="mr-1 h-3 w-3" />
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {!loading && items.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                          暂无账号（AUTH_MODE=disabled 或尚未有人注册）
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            <p className="mt-2 text-[11px] text-muted-foreground">
              角色变更立即生效，但成员需<b>重新登录</b>以换取新令牌；角色权限集在「角色管理」中维护；全部操作写入操作审计。
            </p>
          </section>
        </div>
      </div>

      {resetTarget && (
        <ResetPasswordDialog
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={(msg) => {
            setResetTarget(null)
            setNotice(msg)
            load()
          }}
        />
      )}
      {creating && (
        <CreateUserDialog
          roles={roles}
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

export default UsersManagePage
