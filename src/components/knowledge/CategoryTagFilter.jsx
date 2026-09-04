import * as React from 'react'
import { Search, X, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_TAG_OPTIONS } from '@/lib/constants'
import { cn } from '@/lib/utils'

/**
 * CategoryTagFilter —— 知识库列表过滤面板
 *
 * 字段：
 * - q：关键词（列表模糊过滤）
 * - category：分类下拉（单选）
 * - tag：标签下拉（单选）
 *
 * @param {Object} props
 * @param {{category:string,tag:string,q:string}} props.filters 当前过滤
 * @param {Array<{name:string,count?:number}>} props.categories 后端分类
 * @param {Array<{name:string,count?:number}>} props.tags 后端标签
 * @param {(key:string,value:string)=>void} props.setFilter 设置单个过滤项
 * @param {()=>void} props.resetFilters 重置过滤
 * @param {() => void} [props.onRefresh] 手动刷新
 */
export function CategoryTagFilter({
  filters,
  categories = [],
  tags = [],
  setFilter,
  resetFilters,
  onRefresh,
}) {
  // 后端无分类/标签时，用预设兜底展示，避免空下拉
  const categoryOptions =
    categories.length > 0 ? categories.map((c) => c.name) : KNOWLEDGE_CATEGORIES
  const tagOptions =
    tags.length > 0 ? tags.map((t) => t.name) : KNOWLEDGE_TAG_OPTIONS

  const selectClass = cn(
    'h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          placeholder="关键词过滤…"
          className="pl-8"
        />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">分类</span>
        <select
          value={filters.category}
          onChange={(e) => setFilter('category', e.target.value)}
          className={selectClass}
        >
          <option value="">全部</option>
          {categoryOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">标签</span>
        <select
          value={filters.tag}
          onChange={(e) => setFilter('tag', e.target.value)}
          className={selectClass}
        >
          <option value="">全部</option>
          {tagOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1"
          onClick={resetFilters}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          重置
        </Button>
        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={onRefresh}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            刷新
          </Button>
        )}
      </div>
    </div>
  )
}

export default CategoryTagFilter
