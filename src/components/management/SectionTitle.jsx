import * as React from 'react'
import { Badge } from '@/components/ui/badge'

/** 分区标题：图标 + 名称 + 统计徽标 */
export function SectionTitle({ icon, title, stats }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <h3 className="text-sm font-semibold">{title}</h3>
      {stats && (
        <Badge variant="secondary" className="text-[10px]">
          {stats.enabled}/{stats.total} 启用
        </Badge>
      )}
    </div>
  )
}
