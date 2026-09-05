import * as React from 'react'
import { batchDocuments, getDocument } from '@/lib/knowledgeApi'
import { child } from '@/lib/logger'

const log = child('knowledge:batch')

/**
 * useBatchOperations —— 知识库批量操作（删除 / 改分类 / 加标签 / 去标签）
 *
 * 内部用统一的 runBatch() 消除四个批量函数的重复骨架：
 *   setBatchLoading → setError(null) → try { batchDocuments + refreshAll } catch finally
 *
 * @param {Object} deps
 * @param {() => string[]} deps.getSelectedIds       当前批量选择（避免闭包过期）
 * @param {Function} deps.setSelectedIds
 * @param {() => object|null} deps.getSelectedDoc    当前预览文档（删除/改分类后联动）
 * @param {Function} deps.setSelectedDoc
 * @param {() => string|null} deps.getChunksDocId    当前切片所属文档
 * @param {Function} deps.clearForDeleted            删除后清理预览/切片
 * @param {() => Promise<any>} deps.refreshAll       三合一刷新
 */
export function useBatchOperations(deps) {
  const {
    getSelectedIds,
    setSelectedIds,
    getSelectedDoc,
    setSelectedDoc,
    clearForDeleted,
    refreshAll,
  } = deps

  const [batchLoading, setBatchLoading] = React.useState(false)
  const [error, setError] = React.useState(null)

  /** 通用批量执行器：统一 loading / error / 刷新生命周期 */
  const runBatch = React.useCallback(
    async (ids, op, payload, { onSuccess } = {}) => {
      if (!ids?.length) return null
      setBatchLoading(true)
      setError(null)
      try {
        const res = await batchDocuments(ids, op, payload)
        await refreshAll()
        await onSuccess?.(res)
        return res
      } catch (e) {
        log.error(`[useBatchOperations] 批量操作 ${op} 失败：`, { ids, err: e })
        setError(e)
        return null
      } finally {
        setBatchLoading(false)
      }
    },
    [refreshAll],
  )

  /** 批量删除 */
  const batchDelete = React.useCallback(
    async (ids = getSelectedIds()) => {
      return runBatch(ids, 'delete', undefined, {
        onSuccess: (res) => {
          const deleted = res?.deleted ?? []
          clearForDeleted(deleted)
          setSelectedIds((prev) => prev.filter((id) => !deleted.includes(id)))
        },
      })
    },
    [runBatch, getSelectedIds, clearForDeleted, setSelectedIds],
  )

  /** 批量设置分类 */
  const batchSetCategory = React.useCallback(
    async (category, ids = getSelectedIds()) => {
      if (typeof category !== 'string') return null
      return runBatch(
        ids,
        'setCategory',
        { category: category.trim() },
        {
          onSuccess: async (res) => {
            const updated = res?.updated ?? []
            // 若预览中的文档被改，重新拉取它（仅详情，不重载切片）
            const cur = getSelectedDoc()
            if (cur && updated.includes(cur.id)) {
              try {
                const fresh = await getDocument(cur.id)
                if (fresh) setSelectedDoc(fresh)
              } catch (err) {
                log.error(
                  '[useBatchOperations] 批量改分类后刷新预览失败：',
                  err,
                )
              }
            }
          },
        },
      )
    },
    [runBatch, getSelectedIds, getSelectedDoc, setSelectedDoc],
  )

  /** 批量加标签 */
  const batchAddTags = React.useCallback(
    async (tagList, ids = getSelectedIds()) => {
      const tagsArr = Array.isArray(tagList) ? tagList : []
      if (!tagsArr.length) return null
      return runBatch(ids, 'addTags', { tags: tagsArr })
    },
    [runBatch, getSelectedIds],
  )

  /** 批量去某标签 */
  const batchRemoveTag = React.useCallback(
    async (tag, ids = getSelectedIds()) => {
      if (!tag) return null
      return runBatch(ids, 'removeTag', { tag })
    },
    [runBatch, getSelectedIds],
  )

  return {
    batchLoading,
    batchDelete,
    batchSetCategory,
    batchAddTags,
    batchRemoveTag,
    error,
    setError,
  }
}
