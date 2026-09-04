import * as React from 'react'
import { getDocument, getDocumentChunks } from '@/lib/knowledgeApi'
import { child } from '@/lib/logger'

const log = child('knowledge:preview')

const EMPTY_CHUNKS = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  avgScore: null,
  scoreMode: null,
}

/**
 * useDocumentPreview —— 文档详情预览 + 切片查看
 */
export function useDocumentPreview() {
  const [selectedDoc, setSelectedDoc] = React.useState(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)

  const [selectedChunks, setSelectedChunks] = React.useState(EMPTY_CHUNKS)
  const [chunksLoading, setChunksLoading] = React.useState(false)
  const [chunksDocId, setChunksDocId] = React.useState(null)
  const [error, setError] = React.useState(null)

  // 竞态守卫：快速切换文档/翻页时，仅最后一次请求允许落 state（过期响应直接丢弃）
  const chunksSeq = React.useRef(0)
  const selectSeq = React.useRef(0)

  /** 切片列表 */
  const loadChunks = React.useCallback(async (docId, params = {}) => {
    if (!docId) return null
    const seq = ++chunksSeq.current
    setChunksLoading(true)
    try {
      const cp = { page: 1, pageSize: 20, ...params }
      const res = await getDocumentChunks(docId, cp)
      if (seq !== chunksSeq.current) return null // 已切到别的文档/页，丢弃过期响应
      const items = res?.items ?? []
      const total = Number(res?.total ?? items.length)
      const p = Number(res?.page ?? cp.page)
      const ps = Number(res?.pageSize ?? cp.pageSize)
      setSelectedChunks({
        items,
        total,
        page: p,
        pageSize: ps,
        avgScore: Number.isFinite(Number(res?.avgScore)) ? res.avgScore : null,
        scoreMode: typeof res?.scoreMode === 'string' ? res.scoreMode : null,
      })
      setChunksDocId(docId)
      return res
    } catch (e) {
      if (seq !== chunksSeq.current) return null
      log.error('[useDocumentPreview] 切片列表加载失败：', { docId, err: e })
      setError(e)
      return null
    } finally {
      if (seq === chunksSeq.current) setChunksLoading(false)
    }
  }, [])

  /** 预览详情：仅拉取文档正文（切片改为切到「切片」tab 时懒加载，见 DocumentPreview 效应） */
  const selectDoc = React.useCallback(async (id) => {
    const seq = ++selectSeq.current
    setPreviewLoading(true)
    setError(null)
    try {
      const doc = await getDocument(id)
      if (seq !== selectSeq.current) return null // 已切换到其他文档，丢弃过期详情
      setSelectedDoc(doc)
      return doc
    } catch (e) {
      if (seq !== selectSeq.current) return null
      log.error('[useDocumentPreview] 文档详情加载失败：', { id, err: e })
      setError(e)
      return null
    } finally {
      if (seq === selectSeq.current) setPreviewLoading(false)
    }
  }, [])

  /** 当某些文档被删除时，清理对应的预览 / 切片状态 */
  const clearForDeleted = React.useCallback((deletedIds = []) => {
    if (!Array.isArray(deletedIds) || !deletedIds.length) return
    setSelectedDoc((prev) =>
      prev && deletedIds.includes(prev.id) ? null : prev,
    )
    setChunksDocId((prev) => {
      if (prev && deletedIds.includes(prev)) {
        setSelectedChunks(EMPTY_CHUNKS)
        return null
      }
      return prev
    })
  }, [])

  return {
    selectedDoc,
    setSelectedDoc,
    previewLoading,
    selectedChunks,
    setSelectedChunks,
    chunksLoading,
    chunksDocId,
    setChunksDocId,
    loadChunks,
    selectDoc,
    clearForDeleted,
    error,
    setError,
  }
}
