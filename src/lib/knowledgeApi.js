import { request } from '@/lib/api'
import { KNOWLEDGE_API_BASE } from '@/lib/constants'

/**
 * 知识库 REST 客户端 —— 对接真实后端
 *
 * 所有方法经 Vite 代理（/api -> http://localhost:3000）访问后端，
 * 统一走 @/lib/api 的 request()：自动附加 x-request-id（与后端 requestTrace
 * 串联日志）、统一错误解析并抛 AppError、204 返回 null。
 * 调用方只需按原契约使用返回值，失败时 catch AppError 并在 UI 上降级提示。
 *
 * 后端接口契约见 README「知识库后端接口契约」。
 */

/** JSON GET（query 参数跳过 undefined/null/空串） */
async function get(path, query) {
  const search = new URLSearchParams()
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        search.set(k, String(v))
      }
    })
  }
  const qs = search.toString()
  return request(`${KNOWLEDGE_API_BASE}${path}${qs ? `?${qs}` : ''}`)
}

/** JSON POST */
async function postJson(path, body) {
  return request(`${KNOWLEDGE_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/** multipart POST（上传文件） */
async function postForm(path, formData) {
  // 注意：不设置 Content-Type，让浏览器自动带上 multipart boundary
  return request(`${KNOWLEDGE_API_BASE}${path}`, {
    method: 'POST',
    body: formData,
  })
}

/** DELETE（后端成功返回 204 → request() 返回 null） */
async function del(path) {
  return request(`${KNOWLEDGE_API_BASE}${path}`, { method: 'DELETE' })
}

/** PATCH JSON */
async function patchJson(path, body) {
  return request(`${KNOWLEDGE_API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/**
 * 文档列表（支持分类/标签/关键词过滤、排序、分页）
 * GET /documents?category=&tag=&q=&sort=&page=&pageSize=
 * @returns {Promise<{items: Array, total: number, page: number, pageSize: number}>}
 */
export function listDocuments(params = {}) {
  return get('/documents', params)
}

/**
 * 上传文档
 * POST /documents (multipart/form-data)
 * @param {File} file
 * @param {{category?: string, tags?: string[], chunkStrategy?: 'semantic'|'delimiter', delimiter?: string, maxChars?: number}} meta
 * @returns {Promise<Object>} 新建文档对象
 */
export function uploadDocument(file, meta = {}) {
  const form = new FormData()
  form.append('file', file)
  if (meta.category) form.append('category', meta.category)
  if (meta.tags?.length) form.append('tags', JSON.stringify(meta.tags))
  if (meta.chunkStrategy === 'delimiter') {
    form.append('chunkStrategy', 'delimiter')
    if (meta.delimiter) form.append('delimiter', meta.delimiter)
    if (meta.maxChars) form.append('maxChars', String(meta.maxChars))
  }
  return postForm('/documents', form)
}

/**
 * 预览切片（不入库，零副作用）
 * POST /knowledge/preview-chunks
 * @param {string} text 文档纯文本
 * @param {{strategy?: 'semantic'|'delimiter', delimiter?: string, maxChars?: number}} [opts]
 * @returns {Promise<{chunks: Array<{idx,heading,text,chars,preContext,postContext}>, total: number}>}
 */
export function previewChunks(text, opts = {}) {
  const body = {
    text,
    strategy: opts.strategy || 'semantic',
  }
  if (opts.strategy === 'delimiter') {
    if (opts.delimiter) body.delimiter = opts.delimiter
    if (opts.maxChars) body.maxChars = opts.maxChars
  }
  return postJson('/preview-chunks', body)
}

/**
 * 删除文档
 * DELETE /documents/:id
 */
export function deleteDocument(id) {
  return del(`/documents/${encodeURIComponent(id)}`)
}

/**
 * 文档详情（含正文内容用于预览）
 * GET /documents/:id
 */
export function getDocument(id) {
  return get(`/documents/${encodeURIComponent(id)}`)
}

/**
 * 分类列表
 * GET /categories
 * @returns {Promise<Array<{name: string, count: number}>>}
 */
export function listCategories() {
  return get('/categories')
}

/**
 * 标签列表
 * GET /tags
 * @returns {Promise<Array<{name: string, count: number}>>}
 */
export function listTags() {
  return get('/tags')
}

/**
 * 语义检索
 * POST /search  { query, category?, tag? }
 * @returns {Promise<{results: Array<{id, title, snippet, score, category, tags}>}>}
 */
export function searchKnowledge({ query, category, tag } = {}) {
  return postJson('/search', { query, category, tag })
}

/**
 * 单条手动录入知识（直接写正文 + 元数据，无需上传文件）
 * POST /documents/manual  { title, content, category?, tags?, source? }
 * @returns {Promise<Object>} 新建文档对象
 */
export function createManualEntry({
  title,
  content,
  category,
  tags,
  source,
} = {}) {
  return postJson('/documents/manual', {
    title,
    content,
    category,
    tags,
    source,
  })
}

/**
 * 编辑文档：更新元数据（title/category/tags/source），也可单独更新正文 content
 * PATCH /documents/:id  { title?, category?, tags?, source?, content? }
 *   - 只传元数据字段 → 走 patchMeta（不重切片不重嵌入）
 *   - 携带 content 字段 → 后端内部重切片 + 重嵌入向量
 * @returns {Promise<Object>} 更新后的文档对象
 */
export function patchDocument(id, patch = {}) {
  return patchJson(`/documents/${encodeURIComponent(id)}`, patch)
}

/**
 * 读取文档切片列表（带 displayTitle 独立标题）
 * GET /documents/:id/chunks?page=&pageSize=
 * @returns {Promise<{items: Array<{id, docId, displayTitle, heading?, text, tokens, category, tags}>, total: number, page: number, pageSize: number}>}
 */
export function getDocumentChunks(id, params = {}) {
  return get(`/documents/${encodeURIComponent(id)}/chunks`, params)
}

/**
 * 批量操作
 * POST /documents/batch
 * @param {string[]} ids 文档 id 列表，必填
 * @param {'delete'|'setCategory'|'addTags'|'removeTag'} op
 * @param {{category?: string, tags?: string[], tag?: string}} payload
 * @returns {Promise<Object>} { updated?:string[], deleted?:string[], failed?:{id,message}[] }
 */
export function batchDocuments(ids, op, payload = {}) {
  return postJson('/documents/batch', { ids, op, ...payload })
}

// ---------- 两段式上传：prepare（抽文本+切片+评分，可预览 PDF/DOCX）→ commit（入库） ----------

/**
 * 阶段一：prepare。服务端抽文本+切片+启发式评分，正文缓存在服务端（30 分钟），
 * 不嵌向量不入库，秒级返回。PDF/DOCX 也能预览（解析在服务端完成）。
 * @param {File} file
 * @param {{chunkStrategy?:string, delimiter?:string, maxChars?:number}} [strategyMeta] 切片策略（delimiter 模式才传后两项）
 * @returns {Promise<{previewId:string, title:string, size:number, chunkCount:number, avgScore:number, chunks:Array}>}
 *   重复内容时后端返回 409 { duplicate:true, existingId, message }（request() 会抛 AppError）
 */
export function prepareDocument(file, strategyMeta = {}) {
  const fd = new FormData()
  fd.append('file', file)
  if (strategyMeta.chunkStrategy)
    fd.append('chunkStrategy', strategyMeta.chunkStrategy)
  if (strategyMeta.delimiter) fd.append('delimiter', strategyMeta.delimiter)
  if (strategyMeta.maxChars != null)
    fd.append('maxChars', String(strategyMeta.maxChars))
  return postForm('/documents/prepare', fd)
}

/**
 * 阶段二：commit。对 prepare 缓存的正文做 embedding + 入库。
 * 异步模式（默认）立即返回 jobId，用 getUploadJob 轮询进度。
 * @param {string} previewId prepare 返回的预览 ID（一次性，commit 后失效）
 * @param {{category?:string, tags?:string[], withQuestions?:boolean, async?:boolean}} [opts]
 *   withQuestions=true 才生成检索增强问题（省一次 LLM 调用）
 * @returns {Promise<{jobId:string}>|Promise<object>} async 模式返回 { jobId }；同步模式返回文档
 */
export function commitDocument(previewId, opts = {}) {
  const {
    category = '',
    tags = [],
    withQuestions = false,
    async: asJob = true,
  } = opts
  return postJson('/documents/commit', {
    previewId,
    category,
    tags,
    withQuestions,
    async: asJob,
  })
}

/**
 * 查询异步入库任务进度。
 * @param {string} jobId
 * @returns {Promise<{id:string, title:string, stage:'chunking'|'embedding'|'indexing'|'done'|'error', chunkCount:number|null, doc:object|null, error:string|null}>}
 */
export function getUploadJob(jobId) {
  return get(`/documents/jobs/${jobId}`)
}

// ---------- 分类 / 标签聚合治理 ----------

/**
 * 分类重命名（作用于该分类下全部文档及其切片；to='' 表示并入「未分类」）
 * POST /categories/rename  { from, to }
 * @returns {Promise<{ renamed:number, affected:string[], failed?:Array }>}
 */
export function renameCategory(from, to) {
  return postJson('/categories/rename', { from, to })
}

/**
 * 标签合并（from: string|string[] → to；来源标签被移除并补上目标标签）
 * POST /tags/merge  { from, to }
 * @returns {Promise<{ merged:number, from:string[], to:string, affected:string[], failed?:Array }>}
 */
export function mergeTags(from, to) {
  return postJson('/tags/merge', { from, to })
}

// ---------- 库内查重（存量切片两两相似度扫描 + 清理） ----------

/**
 * 扫描库内重复切片对（与入库去重共用阈值：跨文档 0.985 / 同文档 0.96）
 * POST /duplicates/scan  { maxChunks? }
 * @returns {Promise<{ scanned:number, total:number, truncated:boolean, pairs:Array<{sim:number, scope:'within'|'cross', a:{chunkId,docId,idx,heading,snippet}, b:{...}}>, pairTotal:number, ms:number }>}
 */
export function scanDuplicates({ maxChunks } = {}) {
  return postJson('/duplicates/scan', { maxChunks })
}

/**
 * 删除选中的重复切片（按 chunkId，保留一个后清理其余）
 * POST /duplicates/delete  { chunkIds: string[] }
 * @returns {Promise<{ deleted:number, failed?:Array }>}
 */
export function deleteDuplicateChunks(chunkIds) {
  return postJson('/duplicates/delete', { chunkIds })
}
