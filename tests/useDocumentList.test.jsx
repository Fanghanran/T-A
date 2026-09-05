import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDocumentList } from '@/hooks/useDocumentList'

vi.mock('@/lib/knowledgeApi', () => ({
  listDocuments: vi.fn(),
}))

import { listDocuments } from '@/lib/knowledgeApi'

describe('useDocumentList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refresh 拉取列表并写入 state', async () => {
    listDocuments.mockResolvedValue({
      items: [{ id: 'd1', title: 'A' }],
      total: 1,
      pageSize: 20,
    })
    const h = renderHook(() => useDocumentList())
    await act(async () => {
      await h.result.current.refresh()
    })
    expect(h.result.current.documents).toHaveLength(1)
    expect(h.result.current.total).toBe(1)
    expect(h.result.current.loading).toBe(false)
  })

  it('竞态：快速连续刷新时只认最后一次请求（过期响应被丢弃）', async () => {
    let resolveSlow
    listDocuments.mockImplementation(({ sort }) => {
      if (sort === 'slow') {
        return new Promise((resolve) => {
          resolveSlow = () => resolve({ items: [{ id: 'stale' }], total: 1 })
        })
      }
      return Promise.resolve({ items: [{ id: 'fresh' }], total: 1 })
    })

    const h = renderHook(() => useDocumentList())
    // 先发起慢请求（旧），再发起快请求（新）；最后让慢请求乱序返回
    let p1
    await act(async () => {
      p1 = h.result.current.refresh({ sort: 'slow' })
    })
    await act(async () => {
      await h.result.current.refresh({ sort: 'fast' })
    })
    await act(async () => {
      resolveSlow()
      await p1
    })

    expect(h.result.current.documents[0]?.id).toBe('fresh')
    expect(h.result.current.loading).toBe(false)
  })

  it('请求失败时写入 error 且不崩溃', async () => {
    listDocuments.mockRejectedValue(new Error('boom'))
    const h = renderHook(() => useDocumentList())
    await act(async () => {
      await h.result.current.refresh()
    })
    expect(h.result.current.error?.message).toBe('boom')
  })

  it('setFilter 重置页码并清空批量选择', () => {
    const h = renderHook(() => useDocumentList())
    act(() => h.result.current.setPage(3))
    act(() => h.result.current.toggleSelectId('x'))
    expect(h.result.current.page).toBe(3)
    expect(h.result.current.selectedIds).toEqual(['x'])
    act(() => h.result.current.setFilter('category', '前端'))
    expect(h.result.current.page).toBe(1)
    expect(h.result.current.selectedIds).toEqual([])
    expect(h.result.current.filters.category).toBe('前端')
  })
})
