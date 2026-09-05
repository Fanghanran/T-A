import * as React from 'react'
import { useDocumentList } from './useDocumentList'
import { useDocumentFacets } from './useDocumentFacets'
import { useDocumentStats } from './useDocumentStats'
import { useDocumentPreview } from './useDocumentPreview'
import { useDocumentSearch } from './useDocumentSearch'
import { useDocumentMutations } from './useDocumentMutations'
import { useBatchOperations } from './useBatchOperations'

/**
 * useKnowledgeBase —— 知识库状态管理编排器
 *
 * 组合 7 个子 Hook，对外保持与旧版完全相同的接口（所有现有消费者无需修改）。
 *
 * 子 Hook 职责：
 *   useDocumentList       列表 / 过滤 / 排序 / 分页 / 批量选择标识
 *   useDocumentFacets     分类 / 标签聚合
 *   useDocumentStats      统计（文档数 / 切片数 / 分类分布）
 *   useDocumentPreview    文档详情预览 / 切片查看
 *   useDocumentSearch     语义检索
 *   useDocumentMutations  上传 / 手动录入 / 删除 / 编辑
 *   useBatchOperations    批量删除 / 改分类 / 加标签 / 去标签
 */
export function useKnowledgeBase() {
  const list = useDocumentList()
  const facets = useDocumentFacets()
  const stats = useDocumentStats()
  const preview = useDocumentPreview()
  const search = useDocumentSearch(list.filters)

  // 先解构出 useCallback 稳定的函数引用，refreshAll 身份才稳定
  const { refresh: refreshList } = list
  const { loadFacets } = facets
  const { loadStats } = stats
  /** 三合一刷新：列表 + facets + 统计（消除旧版 7 处重复的 Promise.all） */
  const refreshAll = React.useCallback(
    () => Promise.all([refreshList(), loadFacets(), loadStats()]),
    [refreshList, loadFacets, loadStats],
  )

  const mutations = useDocumentMutations({
    refreshAll,
    loadFacets: facets.loadFacets,
    loadStats: stats.loadStats,
    setDocuments: list.setDocuments,
    setSelectedDoc: preview.setSelectedDoc,
    getChunksDocId: () => preview.chunksDocId,
    loadChunks: preview.loadChunks,
    setSelectedIds: list.setSelectedIds,
    clearForDeleted: preview.clearForDeleted,
  })

  const batch = useBatchOperations({
    getSelectedIds: () => list.selectedIds,
    setSelectedIds: list.setSelectedIds,
    getSelectedDoc: () => preview.selectedDoc,
    setSelectedDoc: preview.setSelectedDoc,
    getChunksDocId: () => preview.chunksDocId,
    clearForDeleted: preview.clearForDeleted,
    refreshAll,
  })

  // ---- 初始化 & 依赖变化刷新（refreshList/loadFacets/loadStats 均为 useCallback 稳定引用） ----
  React.useEffect(() => {
    refreshList()
  }, [list.filters, list.page, list.sort, refreshList])

  React.useEffect(() => {
    loadFacets().then(() => {
      // facets 与统计面板都含分类聚合，一次性把 stats 也拉一下
      loadStats()
    })
  }, [loadFacets, loadStats])

  const busy =
    list.loading ||
    search.searching ||
    mutations.uploading ||
    preview.previewLoading ||
    mutations.creating ||
    mutations.updating ||
    batch.batchLoading ||
    preview.chunksLoading

  // 统一错误：取各子 Hook 中最新的非空错误
  const error =
    list.error ??
    mutations.error ??
    batch.error ??
    search.error ??
    preview.error ??
    null

  return {
    // 列表
    documents: list.documents,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    setPageSize: list.setPageSize,
    sort: list.sort,
    setSort: list.setSort,
    // facets
    categories: facets.categories,
    tags: facets.tags,
    loadFacets: facets.loadFacets,
    // 过滤
    filters: list.filters,
    setFilter: list.setFilter,
    resetFilters: list.resetFilters,
    // 状态
    loading: list.loading,
    error,
    busy,
    // 选择 / 批量
    selectedIds: list.selectedIds,
    toggleSelectId: list.toggleSelectId,
    clearSelection: list.clearSelection,
    toggleSelectAllVisible: list.toggleSelectAllVisible,
    batchLoading: batch.batchLoading,
    batchDelete: batch.batchDelete,
    batchSetCategory: batch.batchSetCategory,
    batchAddTags: batch.batchAddTags,
    batchRemoveTag: batch.batchRemoveTag,
    // 预览
    selectedDoc: preview.selectedDoc,
    previewLoading: preview.previewLoading,
    selectDoc: preview.selectDoc,
    setSelectedDoc: preview.setSelectedDoc,
    // 切片
    selectedChunks: preview.selectedChunks,
    chunksLoading: preview.chunksLoading,
    chunksDocId: preview.chunksDocId,
    loadChunks: preview.loadChunks,
    // 统计
    stats: stats.stats,
    statsLoading: stats.statsLoading,
    loadStats: stats.loadStats,
    // 检索
    searchResults: search.searchResults,
    searching: search.searching,
    runSearch: search.runSearch,
    clearSearch: search.clearSearch,
    // 写操作
    upload: mutations.upload,
    uploading: mutations.uploading,
    createManual: mutations.createManual,
    creating: mutations.creating,
    updateMeta: mutations.updateMeta,
    updateContent: mutations.updateContent,
    updating: mutations.updating,
    remove: mutations.remove,
    removingId: mutations.removingId,
    // 刷新
    refresh: list.refresh,
  }
}
