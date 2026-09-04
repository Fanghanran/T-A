import * as React from 'react'
import { listDocuments } from '@/lib/knowledgeApi'
import { child } from '@/lib/logger'

const log = child('knowledge:list')

/**
 * useDocumentList —— 知识库文档列表状态
 *
 * 职责：文档列表、过滤、排序、分页、批量选择标识。
 * 过滤变化会清空批量选择（二者天然耦合，故同置于此）。
 *
 * @param {Object} [opts]
 * @param {() => void} [opts.onFilterChange] 过滤变化时的附加回调（如清空选择）
 */
export function useDocumentList() {
  const [documents, setDocuments] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [sort, setSortState] = React.useState('createdDesc')
  const [filters, setFilters] = React.useState({ category: '', tag: '', q: '' })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)

  // —— 批量选择标识（与过滤耦合：过滤变化时清空）——
  const [selectedIds, setSelectedIds] = React.useState([])

  // 竞态守卫：快速连续过滤/翻页时，仅最后一次请求允许落 state（过期响应直接丢弃）
  const refreshSeq = React.useRef(0)

  /** 列表刷新（过滤 + 排序 + 分页） */
  const refresh = React.useCallback(
    async (override) => {
      const f = override?.filters ?? filters
      const p = override?.page ?? page
      const ps = override?.pageSize ?? pageSize
      const s = override?.sort ?? sort
      const seq = ++refreshSeq.current
      setLoading(true)
      setError(null)
      try {
        const res = await listDocuments({
          ...f,
          page: p,
          pageSize: ps,
          sort: s,
        })
        if (seq !== refreshSeq.current) return null // 已有更新的请求，丢弃过期响应
        setDocuments(res?.items ?? [])
        setTotal(res?.total ?? 0)
        if (typeof res?.pageSize === 'number') setPageSize(res.pageSize)
        return res
      } catch (e) {
        if (seq !== refreshSeq.current) return null
        log.error('[useDocumentList] 文档列表加载失败：', e)
        setError(e)
        return null
      } finally {
        if (seq === refreshSeq.current) setLoading(false)
      }
    },
    [filters, page, pageSize, sort],
  )

  const setFilter = React.useCallback((key, value) => {
    setPage(1)
    setSelectedIds([])
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const resetFilters = React.useCallback(() => {
    setPage(1)
    setSelectedIds([])
    setFilters({ category: '', tag: '', q: '' })
  }, [])

  const setSort = React.useCallback((nextSort) => {
    setPage(1)
    setSortState(
      typeof nextSort === 'string' && nextSort ? nextSort : 'createdDesc',
    )
  }, [])

  // —— 批量选择切换 ——
  const toggleSelectId = React.useCallback((id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }, [])
  const clearSelection = React.useCallback(() => setSelectedIds([]), [])
  const toggleSelectAllVisible = React.useCallback(() => {
    const visibleIds = documents.map((d) => d.id)
    setSelectedIds((prev) => {
      const allSelected =
        visibleIds.length > 0 && visibleIds.every((id) => prev.includes(id))
      if (allSelected) return prev.filter((id) => !visibleIds.includes(id))
      const merged = new Set([...prev, ...visibleIds])
      return [...merged]
    })
  }, [documents])

  return {
    // 数据
    documents,
    setDocuments,
    total,
    page,
    setPage,
    pageSize,
    setPageSize,
    sort,
    setSort,
    filters,
    setFilter,
    resetFilters,
    loading,
    error,
    setError,
    // 批量选择标识
    selectedIds,
    setSelectedIds,
    toggleSelectId,
    clearSelection,
    toggleSelectAllVisible,
    // 操作
    refresh,
  }
}
