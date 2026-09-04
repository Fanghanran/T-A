import * as React from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { child } from '@/lib/logger'

const log = child('error')

/**
 * ErrorBoundary —— 全局 React 错误边界
 *
 * 捕获子组件树未处理的渲染异常，展示兜底 UI 并记录日志。
 * 放在 App.jsx 最外层，包裹 ThemeProvider + AppShell。
 */
export class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    log.error('React 组件异常:', error.message, { stack: info.componentStack })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-dvh items-center justify-center gap-3 px-6 text-sm text-destructive">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <div className="space-y-2">
            <p className="font-medium">应用遇到异常</p>
            <p className="text-xs text-muted-foreground">
              {this.state.error?.message ?? '未知错误'}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={this.handleReset}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新页面
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
