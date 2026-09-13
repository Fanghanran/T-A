import { request } from './api'

/**
 * filesApi —— 文件管理 / 切片阅读的数据客户端（v3 三级存储）
 *
 * 对应后端 routes/files.js。设计依据 docs/向量库重构设计书.md §10.2：
 * 文件树 / 切片目录 / 切片阅读 三视图同源于「锚点层 + 持久层」。
 */

/** 文件树：文档列表 + 实存对账（fileExists） */
export function listFiles({ page = 1, pageSize = 50, category = '' } = {}) {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (category) qs.set('category', category)
  return request(`/api/files?${qs.toString()}`)
}

/** 切片目录（manifest）：每片的编号 / 标题 / 字数 / span 锚点 / 向量引用 */
export function getManifest(docId) {
  return request(`/api/files/${encodeURIComponent(docId)}/manifest`)
}

/** 正文：不传 range 返回全文；传 start/end 按锚点取片段 */
export function getContent(docId, range) {
  const qs = new URLSearchParams()
  if (range?.start !== undefined) qs.set('start', String(range.start))
  if (range?.end !== undefined) qs.set('end', String(range.end))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return request(`/api/files/${encodeURIComponent(docId)}/content${suffix}`)
}

/** 知识库用量（文件树头部展示） */
export function getFileStats() {
  return request('/api/files/stats')
}

/** 原件下载地址（浏览器直接下载，不走 fetch） */
export function downloadUrl(docId) {
  return `/api/files/${encodeURIComponent(docId)}/download`
}

/** 删除文件（级联清理切片目录与向量，走知识库既有端点以保证状态机一致） */
export function deleteFile(docId) {
  return request(`/api/knowledge/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' })
}

/** 切片阅读页地址 */
export function readerUrl(docId) {
  return `/knowledge/read/${encodeURIComponent(docId)}`
}
