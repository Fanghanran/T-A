import { useEffect } from 'react'
import { child } from '@/lib/logger'

const log = child('error')

/**
 * useGlobalError —— 注册 window 级错误监听
 *
 * - unhandledrejection：Promise 未 catch 的 rejection
 * - error：脚本/资源加载错误
 *
 * 统一上报到 logger，不干扰业务逻辑。
 * 在 App.jsx 顶层调用一次即可。
 */
export function useGlobalError() {
  useEffect(() => {
    const handler = (e) => {
      const reason = e.reason ?? e.error ?? e.message
      log.error('未处理异常:', reason?.toString?.() ?? String(reason), {
        type: e.type,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
      })
    }
    window.addEventListener('error', handler)
    window.addEventListener('unhandledrejection', handler)
    return () => {
      window.removeEventListener('error', handler)
      window.removeEventListener('unhandledrejection', handler)
    }
  }, [])
}
