/**
 * documentListUtils —— DocumentList 共享工具函数与常量
 *
 * 从 DocumentList.jsx 提取的纯函数和常量，便于被其他组件复用。
 */

/** 友好体积显示 */
export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 友好日期 */
export function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    return ''
  }
}

export const SORT_OPTIONS = [
  { value: 'createdDesc', label: '上传时间（新→旧）' },
  { value: 'createdAsc', label: '上传时间（旧→新）' },
  { value: 'titleAsc', label: '标题（A→Z）' },
  { value: 'titleDesc', label: '标题（Z→A）' },
  { value: 'categoryAsc', label: '分类（A→Z）' },
  { value: 'categoryDesc', label: '分类（Z→A）' },
  { value: 'sizeDesc', label: '体积（大→小）' },
  { value: 'sizeAsc', label: '体积（小→大）' },
]
