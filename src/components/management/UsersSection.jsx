import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { fetchUsers, issueUser, revokeUser } from '@/lib/managementApi'

/**
 * UsersSection —— 用户管理（M5a / ADR-008 user-token 档）
 *
 * 仅在服务端 AUTH_MODE=user-token 时有意义；disabled 模式下展示说明。
 * 签发返回的明文 token 只显示一次（服务端只存哈希），需立即复制保存。
 */
export function UsersSection() {
  const [state, setState] = React.useState(null) // { mode, users }
  const [userId, setUserId] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [issued, setIssued] = React.useState(null) // { userId, token }
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const reload = React.useCallback(async () => {
    try {
      const r = await fetchUsers()
      setState(r)
    } catch (e) {
      setError(e?.message || '加载失败')
    }
  }, [])

  React.useEffect(() => {
    reload()
  }, [reload])

  const handleIssue = async () => {
    setError('')
    if (!userId.trim()) return
    setBusy(true)
    try {
      const r = await issueUser(userId.trim(), label.trim())
      setIssued(r)
      setUserId('')
      setLabel('')
      await reload()
    } catch (e) {
      setError(e?.message || '签发失败')
    } finally {
      setBusy(false)
    }
  }

  const handleRevoke = async (uid) => {
    setError('')
    setBusy(true)
    try {
      await revokeUser(uid)
      await reload()
    } catch (e) {
      setError(e?.message || '吊销失败')
    } finally {
      setBusy(false)
    }
  }

  const isTokenMode = state?.mode === 'user-token'

  return (
    <div className="space-y-3">
      {!isTokenMode && state && (
        <p className="text-sm text-muted-foreground">
          当前认证模式为 disabled（单一 local 用户）。将服务端 .env 设为
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">AUTH_MODE=user-token</code>
          并重启后，可在此签发用户令牌。
        </p>
      )}
      {isTokenMode && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-40"
              placeholder="用户 ID（字母数字_-）"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <Input
              className="h-8 w-44"
              placeholder="备注（可选）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button size="sm" className="h-8" disabled={busy || !userId.trim()} onClick={handleIssue}>
              签发令牌
            </Button>
          </div>
          {issued && (
            <div className="rounded-md border bg-amber-50 p-2 text-xs dark:bg-amber-950/40">
              <p className="font-medium">用户 {issued.userId} 的令牌（仅显示一次，请立即保存）：</p>
              <code className="break-all text-[11px]">{issued.token}</code>
            </div>
          )}
          <div className="space-y-1">
            {(state?.users ?? []).map((u) => (
              <div key={u.userId} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                <span className="font-medium">{u.userId}</span>
                {u.label && <span className="text-xs text-muted-foreground">{u.label}</span>}
                {u.revokedAt ? (
                  <Badge variant="outline" className="ml-auto px-1.5 py-0 text-[10px]">已吊销</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7 px-2 text-xs"
                    disabled={busy}
                    onClick={() => handleRevoke(u.userId)}
                  >
                    吊销
                  </Button>
                )}
              </div>
            ))}
            {(state?.users ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">暂无用户，签发第一个令牌以启用多用户。</p>
            )}
          </div>
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export default UsersSection
