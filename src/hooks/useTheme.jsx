import * as React from 'react'

/**
 * ThemeContext —— 深/浅色模式 Context
 * 提供当前主题与切换函数，状态持久化到 localStorage，并在 <html> 上切换 class。
 */

const ThemeContext = React.createContext(null)

const STORAGE_KEY = 'interview-agent-theme'

function applyTheme(theme) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
}

export function ThemeProvider({ children, defaultTheme = 'dark' }) {
  const [theme, setTheme] = React.useState(() => {
    if (typeof window === 'undefined') return defaultTheme
    return localStorage.getItem(STORAGE_KEY) || defaultTheme
  })

  React.useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const toggleTheme = React.useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  const value = React.useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * useTheme —— 获取主题上下文
 * 必须在 ThemeProvider 内部调用。
 */
export function useTheme() {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme 必须在 <ThemeProvider> 内部使用')
  }
  return ctx
}
