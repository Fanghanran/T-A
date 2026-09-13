import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { setUserToken } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

/**
 * AuthTokenDialog —— 用户令牌输入（M5a，legacy token 模式兜底）
 *
 * 监听 api 层广播的 auth:required（后端 AUTH_MODE=user-token/token 且请求缺令牌/令牌失效时触发），
 * 让用户粘贴管理页签发的令牌；保存后刷新页面重新拉取数据。
 * jwt 模式不弹此框：401 由 useAuth 清令牌并跳 /auth 登录页。
 */
export function AuthTokenDialog() {
  const { mode } = useAuth()
  const [open, setOpen] = React.useState(false)
  const [token, setToken] = React.useState('')
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    const onRequired = (e) => {
      if (mode === 'jwt') return // 会话过期走 AuthGate 跳登录，不弹粘贴框
      setMessage(e?.detail?.message || '')
      setOpen(true)
    }
    window.addEventListener('auth:required', onRequired)
    return () => window.removeEventListener('auth:required', onRequired)
  }, [mode])

  const handleSave = () => {
    if (!token.trim()) return
    setUserToken(token.trim())
    setOpen(false)
    // 重新加载以让所有已挂载的数据请求带上新令牌
    window.location.reload()
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>需要用户令牌</DialogTitle>
          <DialogDescription>
            {message || '本服务已启用多用户模式，请粘贴系统管理员在「系统管理 → 用户管理」中签发的令牌。'}
          </DialogDescription>
        <Input
          placeholder="ua_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
          }}
        />
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false)
              window.location.assign('/auth')
            }}
          >
            前往登录页
          </Button>
          <Button type="button" onClick={handleSave} disabled={!token.trim()}>
            保存并重载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AuthTokenDialog
