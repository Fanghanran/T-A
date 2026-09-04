import * as React from 'react'
import { FileSearch, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

/**
 * SearchResultsPanel —— 语义检索结果面板（右侧栏）
 *
 * @param {Object} props
 * @param {Array} props.results
 * @param {(docId:string)=>void} props.onSelectDoc
 * @param {()=>void} props.onClearSearch
 * @param {boolean} [props.showEmptyHint] 无结果时是否显示空态提示（默认 false，由父级控制）
 */
export function SearchResultsPanel({ results, onSelectDoc, onClearSearch }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2.5 md:px-6">
        <span className="text-sm font-medium">
          检索结果（{results.length}）
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onClearSearch}>
          <X className="mr-1 h-4 w-4" />
          清除
        </Button>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-4 md:px-6">
          {results.map((r) => (
            <button
              key={r.id ?? r.title ?? r.snippet}
              type="button"
              onClick={() => onSelectDoc(r.docId)}
              className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm font-medium">
                  {r.displayTitle || r.title}
                </span>
                {typeof r.score === 'number' && (
                  <Badge variant="outline" className="text-[10px]">
                    相似 {(r.score * 100).toFixed(0)}%
                  </Badge>
                )}
              </div>
              <p className="line-clamp-3 text-xs text-muted-foreground">
                {r.snippet}
              </p>
              {(r.category || r.tags?.length) && (
                <div className="flex flex-wrap gap-1">
                  {r.category && (
                    <Badge variant="secondary" className="text-[10px]">
                      {r.category}
                    </Badge>
                  )}
                  {r.tags?.slice(0, 4).map((t) => (
                    <Badge
                      key={t}
                      variant="outline"
                      className="text-[10px] text-muted-foreground"
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 右侧栏空态提示 */
export function SearchEmptyHint() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
      <FileSearch className="h-10 w-10" />
      <p>输入问题进行语义检索，或从左侧选择文档预览。</p>
      <Separator className="my-2 max-w-xs" />
      <p className="max-w-xl text-[11px]">
        支持上传 md/txt/html/csv/tsv/log/json/yaml/yml（可扩展）与单条手动录入；
        所有知识会自动切片并生成独立 displayTitle 存入向量库，供全局 RAG
        检索使用。
        左侧支持排序、分页、全选批量删除/改分类/加标签/去标签，右键顶栏可进入编辑与切片视图。
      </p>
    </div>
  )
}
