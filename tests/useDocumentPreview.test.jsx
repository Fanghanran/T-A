import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDocumentPreview } from '@/hooks/useDocumentPreview'

vi.mock('@/lib/knowledgeApi', () => ({
  getDocument: vi.fn(),
  getDocumentChunks: vi.fn(),
}))

import { getDocument, getDocumentChunks } from '@/lib/knowledgeApi'

describe('useDocumentPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('selectDoc 拉取详情并写入 selectedDoc', async () => {
    getDocument.mockResolvedValue({ id: 'd1', title: '文档一' })
    const h = renderHook(() => useDocumentPreview())
    await act(async () => {
      await h.result.current.selectDoc('d1')
    })
    expect(h.result.current.selectedDoc?.id).toBe('d1')
    expect(h.result.current.previewLoading).toBe(false)
  })

  it('竞态：快速切换文档时只认最后一次选择', async () => {
    let resolveSlow
    getDocument.mockImplementation((id) => {
      if (id === 'slow') {
        return new Promise((resolve) => {
          resolveSlow = () => resolve({ id: 'slow', title: '旧文档' })
        })
      }
      return Promise.resolve({ id: 'fast', title: '新文档' })
    })
    const h = renderHook(() => useDocumentPreview())
    let p1
    await act(async () => {
      p1 = h.result.current.selectDoc('slow')
    })
    await act(async () => {
      await h.result.current.selectDoc('fast')
    })
    await act(async () => {
      resolveSlow()
      await p1
    })
    expect(h.result.current.selectedDoc?.id).toBe('fast')
  })

  it('loadChunks 竞态：翻页/切文档时过期切片不覆盖新状态', async () => {
    let resolveSlow
    getDocumentChunks.mockImplementation((docId) => {
      if (docId === 'slowDoc') {
        return new Promise((resolve) => {
          resolveSlow = () =>
            resolve({
              items: [{ id: 'stale-chunk' }],
              total: 1,
              page: 1,
              pageSize: 20,
            })
        })
      }
      return Promise.resolve({
        items: [{ id: 'fresh-chunk' }],
        total: 1,
        page: 1,
        pageSize: 20,
      })
    })
    const h = renderHook(() => useDocumentPreview())
    let p1
    await act(async () => {
      p1 = h.result.current.loadChunks('slowDoc')
    })
    await act(async () => {
      await h.result.current.loadChunks('fastDoc')
    })
    await act(async () => {
      resolveSlow()
      await p1
    })
    expect(h.result.current.selectedChunks.items[0]?.id).toBe('fresh-chunk')
    expect(h.result.current.chunksDocId).toBe('fastDoc')
  })
})
