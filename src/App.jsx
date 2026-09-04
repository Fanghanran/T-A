import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/hooks/useTheme'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useGlobalError } from '@/hooks/useGlobalError'

// 首次访问（无 localStorage 记忆时）跟随系统深浅色偏好，而非硬编码 dark
const _prefersDark =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
const _systemDefault = _prefersDark ? 'dark' : 'light'

/**
 * App —— 根组件
 * 包裹主题 Provider，渲染应用外壳（侧边栏 + Header + 智能体视图）。
 */
export default function App() {
  useGlobalError()
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={_systemDefault}>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
