/**
 * managementApi —— 管理模块 REST 端点封装
 *
 * 对应后端 /api/management/*（server/lib/management/manager.js），
 * 供 ManagementPage 查询与启停工具/工作流。
 * 启停状态持久化于服务端 data/management/registry.json，重启后保持。
 *
 * 所有请求统一走 @/lib/api 的 request()：自动附加 x-request-id（与后端
 * requestTrace 串联日志）、统一错误解析并抛 AppError、204 返回 null。
 */

import { request } from '@/lib/api'

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
  return request(`/api/management/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

/** 探活：对指定 profile 发最小请求（chat 回 1 token / embed 返回 dim） */
export function testModelProfile(id) {
  return postJson('/api/management/models/test', { id })
}
