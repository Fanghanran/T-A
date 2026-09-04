import * as React from 'react'
import {
  uploadDocument,
  deleteDocument,
  createManualEntry,
  patchDocument,
} from '@/lib/knowledgeApi'
import { child } from '@/lib/logger'

const log = child('knowledge:mutations')

/**
 * useDocumentMutations —— 知识库写操作（上传 / 手动录入 / 删除 / 编辑）
 *
 * @param {Object} deps
 * @param {() => Promise<any>} deps.refreshAll      三合一刷新（列表 + facets + 统计）
 * @param {() => Promise<any>} deps.loadFacets
 * @param {() => Promise<any>} deps.loadStats
 * @param {Function} deps.setDocuments              列表局部更新（编辑后同步）
 * @param {Function} deps.setSelectedDoc            预览同步
 * @param {() => string|null} deps.getChunksDocId    当前切片所属文档（编辑正文后需重载切片）
 * @param {Function} deps.loadChunks
 * @param {Function} deps.setSelectedIds            删除后从批量选择中剔除
 * @param {Function} deps.clearForDeleted           删除后清理预览/切片
 */
export function useDocumentMutations(deps) {
  const {
    refreshAll,
    loadFacets,
    loadStats,
    setDocuments,
    setSelectedDoc,
    getChunksDocId,
    loadChunks,
    setSelectedIds,
    clearForDeleted,
  } = deps

  const [uploading, setUploading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [updating, setUpdating] = React.useState(false)
  const [removingId, setRemovingId] = React.useState(null)
  const [error, setError] = React.useState(null)

  /** 上传 */
  const upload = React.useCallback(
    async (file, meta) => {
      setUploading(true)
      setError(null)
      try {
        await uploadDocument(file, meta)
        await refreshAll()
        return true
      } catch (e) {
        log.error('[useDocumentMutations] 上传失败：', e)
        setError(e)
        return false
      } finally {
        setUploading(false)
      }
    },
    [refreshAll],
  )

  /** 手动录入 */
  const createManual = React.useCallback(
    async (payload) => {
      setCreating(true)
      setError(null)
      try {
        const doc = await createManualEntry(payload)
        await refreshAll()
        return doc
      } catch (e) {
        log.error('[useDocumentMutations] 手动录入失败：', e)
        setError(e)
        return null
      } finally {
        setCreating(false)
      }
    },
    [refreshAll],
  )

  /** 单篇删除 */
  const remove = React.useCallback(
    async (id) => {
      setRemovingId(id)
      setError(null)
      try {
        await deleteDocument(id)
        clearForDeleted([id])
        setSelectedIds((prev) => prev.filter((x) => x !== id))
        await refreshAll()
        return true
      } catch (e) {
        log.error('[useDocumentMutations] 删除文档失败：', { id, err: e })
        setError(e)
        return false
      } finally {
        setRemovingId(null)
      }
    },
    [refreshAll, clearForDeleted, setSelectedIds],
  )

  /** 只改元数据（不重嵌入） */
  const updateMeta = React.useCallback(
    async (id, meta) => {
      setUpdating(true)
      setError(null)
      try {
        const updated = await patchDocument(id, { ...meta })
        setDocuments((prev) =>
          prev.map((d) => (d.id === id ? { ...d, ...updated } : d)),
        )
        setSelectedDoc((prev) =>
          prev?.id === id ? { ...prev, ...updated } : prev,
        )
        await Promise.all([loadFacets(), loadStats()])
        return updated
      } catch (e) {
        log.error('[useDocumentMutations] 更新元数据失败：', { id, err: e })
        setError(e)
        return null
      } finally {
        setUpdating(false)
      }
    },
    [loadFacets, loadStats, setDocuments, setSelectedDoc],
  )

  /** 改正文（触发重切片 + 重嵌入） */
  const updateContent = React.useCallback(
    async (id, content) => {
      setUpdating(true)
      setError(null)
      try {
        const updated = await patchDocument(id, { content })
        setDocuments((prev) =>
          prev.map((d) => (d.id === id ? { ...d, ...updated } : d)),
        )
        setSelectedDoc((prev) =>
          prev?.id === id ? { ...prev, ...updated } : prev,
        )
        // 正文已改：切片缓存失效
        if (getChunksDocId() === id) {
          loadChunks(id, { page: 1 })
        }
        await Promise.all([loadFacets(), loadStats()])
        return updated
      } catch (e) {
        log.error('[useDocumentMutations] 更新正文失败：', { id, err: e })
        setError(e)
        return null
      } finally {
        setUpdating(false)
      }
    },
    [
      loadFacets,
      loadStats,
      setDocuments,
      setSelectedDoc,
      getChunksDocId,
      loadChunks,
    ],
  )

  return {
    upload,
    uploading,
    createManual,
    creating,
    updateMeta,
    updateContent,
    updating,
    remove,
    removingId,
    error,
    setError,
  }
}
