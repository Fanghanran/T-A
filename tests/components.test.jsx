import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { DocumentList } from '@/components/knowledge/DocumentList'

describe('ConfirmDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('确认回调：点击确认键触发 onConfirm', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="删除会话"
        description="不可恢复"
        destructive
        confirmLabel="确认删除"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('取消：点击取消键触发 onOpenChange(false) 且不执行 onConfirm', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="删除会话"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('DocumentList 批量工具栏', () => {
  const baseProps = {
    documents: [
      { id: 'd1', title: '文档一', size: 100, uploadedAt: '2026-09-01' },
      { id: 'd2', title: '文档二', size: 200, uploadedAt: '2026-09-02' },
    ],
    loading: false,
  }

  it('有选中项时展示批量工具栏，点击批量删除触发回调', () => {
    const onBatchDelete = vi.fn()
    render(
      <DocumentList
        {...baseProps}
        selectedIds={['d1', 'd2']}
        onBatchDelete={onBatchDelete}
      />,
    )
    expect(screen.getByText('已选 2 篇')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /批量删除/ }))
    expect(onBatchDelete).toHaveBeenCalledTimes(1)
  })

  it('无批量 props 时退化为纯列表（不出批量工具栏）', () => {
    render(<DocumentList {...baseProps} />)
    expect(screen.queryByText(/已选/)).toBeNull()
    expect(screen.getByText('文档一')).toBeTruthy()
  })
})
