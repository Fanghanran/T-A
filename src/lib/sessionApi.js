/**
 * sessionApi —— 会话管理 REST 接口封装
 *
 * 对应后端 server/index.js 新增路由：
 *   GET    /api/sessions?agentName=xxx       列表（按 agent 过滤，按 updatedAt 倒序）
 *   POST   /api/sessions                     创建（{agentName, title?}）
 *   GET    /api/sessions/:id                 详情 + messages[]（切换会话时加载历史）
 *   PATCH  /api/sessions/:id                 重命名（{title}）
 *   DELETE /api/sessions/:id                 删除
 */

import { request } from '@/lib/api'

const BASE = '/api/sessions'

/**
 * 统一走 @/lib/api 的 request()：
 *  - 自动附加 x-request-id，与后端 requestTrace 串联日志
 *  - 非 2xx 解析错误体后抛 AppError（message/status/code/requestId）
 *  - 204 No Content 返回 null（DELETE /api/sessions/:id 即 204）
 */
async function _request(url, opts = {}) {
  return request(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
}

/** 会话列表（按 agentName 过滤） */
export async function listSessions(agentName) {
  const q =
    typeof agentName === 'string' && agentName.trim()
      ? `?agentName=${encodeURIComponent(agentName)}`
      : ''
  const data = await _request(`${BASE}${q}`)
  return Array.isArray(data?.items) ? data.items : []
}

/** 创建会话 */
export async function createSession({ agentName, title }) {
  if (typeof agentName !== 'string' || !agentName.trim()) {
    throw new Error('createSession: agentName 必填')
  }
  return _request(BASE, {
    method: 'POST',
    body: JSON.stringify({ agentName: agentName.trim(), title }),
  })
}

/** 会话详情（含历史消息） */
export async function getSessionDetail(id) {
  return _request(`${BASE}/${encodeURIComponent(id)}`)
}

/** 重命名 */
export async function renameSession(id, title) {
  return _request(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

/** 删除（204 → null） */
export async function deleteSession(id) {
  return _request(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 生成会话复盘报告（LLM 聚合，一次一存覆盖式） */
export function generateSessionReport(id) {
  return _request(`${BASE}/${encodeURIComponent(id)}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}

/** 读取已生成的复盘报告（无则 404） */
export function getSessionReport(id) {
  return _request(`${BASE}/${encodeURIComponent(id)}/report`)
}
