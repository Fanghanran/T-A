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

/**
 * AuthTokenDialog —— 用户令牌输入（M5a）
 *
 * 监听 api 层广播的 auth:required（后端 AUTH_MODE=user-token 且请求缺令牌/令牌失效时触发），
 * 让用户粘贴管理页签发的令牌；保存后刷新页面重新拉取数据。
 */
export function AuthTokenDialog() {
  const [open, setOpen] = React.useState(false)
  const [token, setToken] = React.useState('')
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    const onRequired = (e) => {
      setMessage(e?.detail?.message || '')
      setOpen(true)
    }
    window.addEventListener('auth:required', onRequired)
    return () => window.removeEventListener('auth:required', onRequired)
  }, [])

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
        <DialogFooter>
          <Button type="button" onClick={handleSave} disabled={!token.trim()}>
            保存并重载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AuthTokenDialog
