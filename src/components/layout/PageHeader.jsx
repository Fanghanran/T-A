import { cn } from '@/lib/utils'

/**
 * PageHeader —— 二级页面统一页头（仪表盘 / 系统管理 / 操作审计共用）
 *
 * 布局：[图标徽章] 标题 · 说明文字 …… [右侧动作区]
 * 说明支持动态内容（如"更新于 HH:mm:ss"）；窄屏下说明自动隐藏，动作区始终保留。
 *
 * @param {Object} props
 * @param {React.ElementType} [props.icon] lucide 图标组件
 * @param {string} props.title 页面标题
 * @param {React.ReactNode} [props.description] 说明文字（可动态）
 * @param {React.ReactNode} [props.children] 右侧动作区（按钮等）
 */
export function PageHeader({ icon: Icon, title, description, children }) {
  return (
    <header className="flex h-[3.25rem] shrink-0 items-center gap-2.5 border-b bg-background/60 px-4 backdrop-blur-sm md:px-6">
      {Icon && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </span>
      )}
      <h2 className="shrink-0 text-sm font-semibold tracking-tight">{title}</h2>
      {description && (
        <span
          className={cn(
            'hidden min-w-0 truncate text-xs text-muted-foreground/80 md:inline',
            'md:border-l md:border-border md:pl-2.5',
          )}
        >
          {description}
        </span>
      )}
      {children && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{children}</div>
      )}
    </header>
  )
}

export default PageHeader
