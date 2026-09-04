/**
 * docProcessorApi —— 文档处理智能体 REST 端点封装
 *
 * 对应后端 POST /api/doc-processor/{preview,adjust,commit,export}（index.js），
 * 供底部操作栏（DocActionBar）、预览界面（DocPreviewDialog）、导出界面（DocExportDialog）直调。
 * 这些端点与 /api/chat 的 doc-processor 分支共享同一份服务端预览缓存，
 * 调整结果两侧互通。
 *
 * 所有请求统一走 @/lib/api 的 request()：自动附加 x-request-id（与后端
 * requestTrace 串联日志）、统一错误解析并抛 AppError、204 返回 null。
 */

import { request } from '@/lib/api'

/** JSON POST */
function postJson(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/**
 * 预览切片（缓存优先，含用户已做的调整）。
 * @returns {Promise<{ docId:string, title:string, chunks:Array<{idx:number,heading:string,text:string,chars:number,preContext:string,postContext:string}>, totalChunks:number, totalChars:number }>}
 */
export function previewDoc(docId) {
  return postJson('/api/doc-processor/preview', { docId })
}

/**
 * 应用自然语言调整指令（"合并第2、3块" / "拆分第5块" / "maxChars 改成 1000"）。
 * @returns {Promise<{ docId:string, chunks:Array, totalChunks:number, totalChars:number, adjustment:object }>}
 */
export function adjustDoc(docId, instruction) {
  return postJson('/api/doc-processor/adjust', { docId, instruction })
}

/**
 * 入库（embed + 标注 + 去重 + 写入 Milvus）。已入库时后端返回 409（err.status === 409）。
 * @returns {Promise<{ docId:string, title:string, chunkCount:number, totalChars:number, ms:number, skippedWithin:number, skippedCross:number }>}
 */
export function commitDoc(docId) {
  return postJson('/api/doc-processor/commit', { docId })
}

/**
 * 批量入库（操作栏「全部入库」）。单个失败不中断整批，逐文档返回结果。
 * @param {string[]} docIds
 * @returns {Promise<{ total:number, okCount:number, failCount:number, results:Array<{docId:string, ok:boolean, chunkCount?:number, error?:string, status?:number}> }>}
 */
export function commitDocs(docIds) {
  return postJson('/api/doc-processor/commit-batch', { docIds })
}

/**
 * 导出整理后的 Markdown。
 * @returns {Promise<{ docId:string, markdown:string, filename:string, chunkCount:number }>}
 */
export function exportDoc(docId) {
  return postJson('/api/doc-processor/export', { docId })
}

// ---------- 处理模板（保存常用切片参数组合，一键套用） ----------

/** 模板列表 */
export async function listTemplates() {
  const data = await request('/api/doc-processor/templates')
  return data.templates || []
}

/**
 * 新建/更新模板（同名覆盖）。
 * @param {{ name:string, strategy?:'semantic'|'delimiter', maxChars?:number, delimiter?:string }} t
 */
export function saveTemplate(t) {
  return postJson('/api/doc-processor/templates', t)
}

/** 删除模板 */
export function deleteTemplate(id) {
  return request(`/api/doc-processor/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/**
 * 套用模板：按模板参数对文档重新切片（服务端预览缓存同步更新），返回带评分的新切片。
 * @returns {Promise<{ docId:string, template:object, chunks:Array, totalChunks:number, totalChars:number, avgScore:number }>}
 */
export function applyTemplate(docId, templateId) {
  return postJson('/api/doc-processor/templates/apply', { docId, templateId })
}

/**
 * 批量套用模板（统一策略处理）：把同一模板套用到多份文档，逐份重切并写入预览缓存。
 * 单个失败不中断整批，返回逐文档结果。
 * @param {string[]} docIds
 * @param {string} templateId
 * @returns {Promise<{ template:object, total:number, okCount:number, failCount:number, results:Array<{docId:string, ok:boolean, totalChunks?:number, avgScore?:number, error?:string}> }>}
 */
export function applyTemplateBatch(docIds, templateId) {
  return postJson('/api/doc-processor/templates/apply-batch', {
    docIds,
    templateId,
  })
}
