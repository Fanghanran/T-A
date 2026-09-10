/**
 * managementApi —— 管理模块 REST 端点封装
 *
 * 对应后端 /api/management/*（server/lib/management/manager.js），
 * 供系统管理子页面（工作流/工具/参数/模型管理）查询与启停工具/工作流。
 * 启停状态持久化于服务端 data/management/registry.json，重启后保持。
 *
 * 所有请求统一走 @/lib/api 的 request()：自动附加 x-request-id（与后端
 * requestTrace 串联日志）、统一错误解析并抛 AppError、204 返回 null。
 */

import { request } from '@/lib/api'

/** GET */
function get(url) {
  return request(url)
}

/** DELETE */
function del(url) {
  return request(url, { method: 'DELETE' })
}

/** JSON PATCH */
function patchJson(url, body) {
  return request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/** JSON POST */
function postJson(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/**
 * 总览：工具 + 工作流（含统计与启用状态）。
 * @returns {Promise<{ tools:{ items:Array, total:number, enabled:number, disabled:number }, workflows:{ items:Array, total:number, enabled:number, disabled:number } }>}
 */
/** 用户管理（M5a / ADR-008）：列表 / 签发 / 吊销 */
export function fetchUsers() {
  return get('/api/management/users')
}
export function issueUser(userId, label) {
  return postJson('/api/management/users', { userId, label })
}
export function revokeUser(userId) {
  return del(`/api/management/users/${encodeURIComponent(userId)}`)
}

/** 存储 owner schema 状态与重建（M5a 迁移） */
export function fetchOwnerSchema() {
  return get('/api/management/storage/owner-schema')
}
export function ownerRebuild(dryRun = true) {
  return postJson('/api/management/storage/owner-rebuild', { dryRun })
}

export function fetchOverview() {
  return request('/api/management/overview')
}

/** 工具列表（含启用状态） */
export function fetchTools() {
  return request('/api/management/tools')
}

/** 工作流列表（含启用状态） */
export function fetchWorkflows() {
  return request('/api/management/workflows')
}

/**
 * 启停工具。
 * @param {string} name
 * @param {boolean} enabled
 */
export function setToolEnabled(name, enabled) {
  return patchJson(`/api/management/tools/${encodeURIComponent(name)}`, {
    enabled,
  })
}

/**
 * 启停工作流。工作流禁用后对应聊天分支回退关键词路由。
 * @param {string} name
 * @param {boolean} enabled
 */
export function setWorkflowEnabled(name, enabled) {
  return patchJson(`/api/management/workflows/${encodeURIComponent(name)}`, {
    enabled,
  })
}

/**
 * 恢复默认：清空启停覆盖（scope: 'tools' | 'workflows' | 'all'），全部回到启用态。
 * @param {'tools'|'workflows'|'all'} scope
 */
export function resetRegistry(scope = 'all') {
  return postJson('/api/management/reset', { scope })
}

/**
 * 最近管理操作审计（时间倒序）。
 * @param {number} [limit=50]
 */
export function fetchAudit(limit = 50) {
  return request(`/api/management/audit?limit=${limit}`)
}

/**
 * 审计功能总开关（系统管理页「操作审计」行开关）。
 * 关闭后管理操作不再写入审计日志。
 * @param {boolean} enabled
 */
export function setAuditEnabled(enabled) {
  return patchJson('/api/management/audit', { enabled })
}

/**
 * 调优参数全量（分组 + 当前值 + 默认值 + 范围）。
 * @returns {Promise<{ groups:Array, items:Array, total:number, modified:number }>}
 */
export function fetchTunables() {
  return request('/api/management/tunables')
}

/**
 * 修改一个调优参数（服务端校验范围，原地改活对象 → 热生效）。
 * @param {string} key 扁平键，如 "chunker.maxChars"
 * @param {number|boolean|string} value
 */
export function setTunable(key, value) {
  return patchJson(`/api/management/tunables/${encodeURIComponent(key)}`, {
    value,
  })
}

/** 调优参数全部恢复默认值 */
export function resetTunables() {
  return postJson('/api/management/tunables/reset', {})
}

/* ---------- 模型管理（ADR-006） ---------- */

/** 模型管理全量视图：{ profiles, routes, roles, agents }（密钥已脱敏） */
export function fetchModels() {
  return request('/api/management/models')
}

/**
 * 新增/更新模型 profile（id 相同即覆盖）。
 * @param {{id?:string, kind:'chat'|'embedding', label?:string, baseUrl?:string, apiKeyRef?:string, apiKeyInline?:string, model:string, enabled?:boolean}} profile
 */
export function saveModelProfile(profile) {
  return postJson('/api/management/models', profile)
}

/** 删除 profile（被路由引用或内置播种的会被 400 拒绝） */
export function deleteModelProfile(id) {
  return request(`/api/management/models/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/**
 * 更新路由绑定（roles / agents / defaults 三级），热生效。
 * @param {{roles?:object, agents?:object, defaults?:object}} partial
 */
export function updateModelRoutes(partial) {
  return request('/api/management/models/routes', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial ?? {}),
  })
}

/**
 * 更新模型运行时设置（qwen3 思考模式开关等），热生效。
 * @param {{thinking?:boolean}} partial
 */
export function updateModelSettings(partial) {
  return request('/api/management/models/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial ?? {}),
  })
}

/** 探活：对指定 profile 发最小请求（chat 回 1 token / embed 返回 dim） */
export function testModelProfile(id) {
  return postJson('/api/management/models/test', { id })
}

/**
 * 服务模型发现：从已启用 profile 的 baseUrl 拉取全部可用模型
 * （Ollama /api/tags 优先，OpenAI 兼容 /v1/models 回落）。
 * @returns {Promise<{items:Array<{model:string, kind:'chat'|'embedding', baseUrl:string, apiKeyRef:string, source:'ollama'|'openai'}>, errors:Array<{baseUrl:string, error:string}>}>}
 */
export function discoverModels() {
  return get('/api/management/models/discover')
}

/* ---------- ES 关键词索引（状态核对 + 全量回填） ---------- */

/** ES 索引状态：启用开关、索引条数、与 Milvus 切片总数的偏差 */
export function fetchEsStatus() {
  return get('/api/management/es/status')
}

/** 全量回填：Milvus → ES（幂等，先清后建） */
export function syncEsIndex() {
  return fetch('/api/management/es/sync', { method: 'POST' }).then((r) => {
    if (!r.ok) return r.json().then((j) => Promise.reject(new Error(j.error || r.status)))
    return r.json()
  })
}

/* ---------- 向量库浏览（只读：集合结构 + 文档/切片/向量明细） ---------- */

/**
 * 向量库总览：连接信息（地址/维度/度量）+ 三个集合的结构与行数。
 * @returns {Promise<{ address:string, ready:boolean, dim:number, metric:string,
 *   collections:Array<{ name:string, rowCount:number, createdTime:string|null,
 *     fields:Array<{name:string,type:string,isVector:boolean,isPrimaryKey:boolean,dim:number|null}>,
 *     indexes:Array<{field:string,indexType:string,metricType:string,indexedRows:number,state:string}> }> }>}
 */
export function fetchVectorOverview() {
  return get('/api/management/vector/overview')
}

/**
 * 向量库文档浏览列表（Admin 跨 owner 视角，含每篇切片数）。
 * @param {string} [q] 按标题/分类/ID 过滤
 */
export function fetchVectorDocuments(q = '') {
  return get(
    `/api/management/vector/documents${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  )
}

/**
 * 指定文档的切片明细（含 text_vector / question_vector 预览：dim/范数/前8维）。
 * @param {string} docId
 */
export function fetchVectorChunks(docId) {
  return get(
    `/api/management/vector/documents/${encodeURIComponent(docId)}/chunks`,
  )
}

/**
 * 知识网络图（切片级语义相似网络，按文档着色）。
 * 服务端按 threshold/topK 裁边；前端可在 threshold 之上本地调高再过滤，
 * 语义与直接以更高阈值请求服务端等价（更强边必在其低阈值 top-K 邻居内）。
 * includeWiki=false 时不含 LLM Wiki 词条节点（仪表盘卡片用，独立页面默认含）。
 * @param {{ threshold?:number, topK?:number, includeWiki?:boolean }} [opts]
 */
export function fetchVectorGraph({
  threshold = 0.5,
  topK = 6,
  includeWiki = true,
} = {}) {
  // cache:'no-store'：响应带 ETag 无 Cache-Control 时浏览器会启发式缓存，
  // 生成任务结束重拉图时可能拿到旧快照（无 wiki 节点）——禁缓存保数据新鲜
  return request(
    `/api/management/vector/graph?threshold=${threshold}&topK=${topK}` +
      `&includeWiki=${includeWiki ? '1' : '0'}`,
    { cache: 'no-store' },
  )
}

/* ---------- LLM Wiki（知识网络独立页 · 词条生成与查询） ---------- */

/**
 * 触发 Wiki 词条生成（后台 job：实体抽取 → 归一合并 → 词条摘要）。
 * @returns {Promise<{jobId:string}>} 进行中任务 409 返回 { jobId }
 */
export function startWikiGeneration() {
  return postJson('/api/management/wiki/generate', {})
}

/** 查询生成任务进度（stage: extracting/normalizing/summarizing/done/error/cancelled） */
export function fetchWikiJob(jobId) {
  // 轮询类端点：禁浏览器缓存（后端 jobs 响应带 ETag，304 会卡住旧进度）
  return request(`/api/management/wiki/jobs/${encodeURIComponent(jobId)}`, {
    cache: 'no-store',
  })
}

/** 取消生成任务（进行中标记取消，已完成的幂等返回） */
export function cancelWikiJob(jobId) {
  return postJson(
    `/api/management/wiki/jobs/${encodeURIComponent(jobId)}/cancel`,
    {},
  )
}

/** Wiki 状态：当前任务 + 词条统计（挂载时恢复轮询用） */
export function fetchWikiStatus() {
  // 轮询类端点：禁浏览器缓存（统计随生成任务持续增长）
  return request('/api/management/wiki/status', { cache: 'no-store' })
}

/** 清空全部 Wiki 词条数据（有进行中任务时后端 409 拒绝） */
export function clearWiki() {
  return del('/api/management/wiki')
}
