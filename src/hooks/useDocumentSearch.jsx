import * as React from 'react'
import { searchKnowledge } from '@/lib/knowledgeApi'
import { child } from '@/lib/logger'

const log = child('knowledge:search')

/**
 * useDocumentSearch —— 知识库语义检索（独立于列表过滤）
 *
 * @param {{ category?: string, tag?: string }} filters 当前过滤条件（透传给检索端点）
 */
export function useDocumentSearch(filters = {}) {
  const [searchResults, setSearchResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [error, setError] = React.useState(null)

  // 竞态守卫：连续检索时仅最后一次请求落 state（过期结果直接丢弃）
  const searchSeq = React.useRef(0)

  const runSearch = React.useCallback(
    async (query) => {
      if (!query?.trim()) {
        setSearchResults([])
        return
      }
      const seq = ++searchSeq.current
      setSearching(true)
      setError(null)
      try {
        const res = await searchKnowledge({
          query,
          category: filters.category || undefined,
          tag: filters.tag || undefined,
        })
        if (seq !== searchSeq.current) return [] // 已有更新的检索，丢弃过期结果
        setSearchResults(res?.results ?? [])
        return res?.results ?? []
      } catch (e) {
        if (seq !== searchSeq.current) return []
        log.error('[useDocumentSearch] 语义检索失败：', { query, err: e })
        setError(e)
        return []
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters?.category, filters?.tag],
  )

  const clearSearch = React.useCallback(() => setSearchResults([]), [])

  return { searchResults, searching, runSearch, clearSearch, error, setError }
}
