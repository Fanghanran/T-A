import { History } from 'lucide-react'
import { AuditPanel } from '@/components/management/AuditPanel'

/**
 * AuditPage —— 操作审计独立菜单视图
 *
 * 从系统管理视图拆出为侧边栏独立入口：审计是跨工具/工作流/调优参数的
 * 横切记录，独立成页后可单独查看/刷新，不与启停操作混排。
 *
 * 内容主体复用 components/management/AuditPanel（常开表格，自包含数据加载），
 * 本页只做布局包装：更大条数、页头说明。
 */
export function AuditPage() {
  return (
    <div className="flex h-full flex-col">
      {/* 页头 */}
      <div className="flex items-center gap-2 border-b px-4 py-3 md:px-6">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold tracking-tight">操作审计</h2>
        <span className="text-[11px] text-muted-foreground">
          启停 / 调优参数修改 / 恢复默认的全部历史记录（时间倒序）
        </span>
      </div>

      {/* 主体：审计表格面板（常开，自带刷新） */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          <AuditPanel limit={100} />
        </div>
      </div>
    </div>
  )
}

export default AuditPage
