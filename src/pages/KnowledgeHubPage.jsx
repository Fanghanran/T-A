import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Network, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * KnowledgeHubPage —— 知识库统一入口（文档管理 + 知识网络 合并）
 *
 * 背景：原先侧栏是「文档管理 / 知识网络」两个平级菜单，两个页面各管一半 —
 * 看文档的不知道图长什么样，看图的不方便管文档。现按需求合并为一个入口：
 * 侧栏只留「知识网络」，页面内用标签页承载两套功能，切换状态写进 URL（?tab=）
 * 以便前进/后退与分享链接都能回到同一视图。
 *
 * 两个子页面均自带 PageHeader，此处只提供标签栏与容器，不改动其内部实现。
 */

const KnowledgeBasePage = React.lazy(() => import('@/pages/KnowledgeBasePage'))
const KnowledgeGraphPage = React.lazy(() => import('@/pages/KnowledgeGraphPage'))

const TABS = [
  { key: 'graph', label: '知识网络', icon: Network, desc: '切片语义网络 + 词条' },
  { key: 'docs', label: '文档管理', icon: FileText, desc: '录入 / 分类 / 检索 / 阅读' },
]

export function KnowledgeHubPage({ onLoadingChange }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam : 'graph'

  const switchTab = (key) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      {/* 标签栏：合并后两套功能共存于一个入口 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-4">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => switchTab(t.key)}
              className={cn(
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs transition-colors',
                active
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                · {t.desc}
              </span>
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1">
        <React.Suspense fallback={null}>
          {tab === 'graph' ? (
            <KnowledgeGraphPage onLoadingChange={onLoadingChange} />
          ) : (
            <KnowledgeBasePage onLoadingChange={onLoadingChange} />
          )}
        </React.Suspense>
      </div>
    </div>
  )
}

export default KnowledgeHubPage
