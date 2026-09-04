/**
 * agentRegistry —— 前端智能体注册表（插件化扩展机制）
 *
 * 职责：统一管理智能体元数据（id / 名称 / 图标 / 是否可用 / 聊天路由）与页面映射，
 * 供 Sidebar 列表渲染与 AppShell 路由分发消费。
 *
 * 扩展新智能体：只需在 agentDefinitions.js（或任意位置）调用一次 registerAgent(def)，
 * 即可自动出现在侧边栏并接入 /chat/:id 路由，无需改动 Sidebar / AppShell / constants。
 *
 * @typedef {Object} AgentDef
 * @property {string} id           — 唯一标识符（也是路由参数值）
 * @property {string} name         — 显示名称
 * @property {string} description  — 功能描述（Header 展示）
 * @property {Function} icon       — lucide 图标组件
 * @property {boolean} [available] — 是否在侧边栏可用（false = 置灰占位）
 * @property {string} [route]      — 自定义路由路径（默认 `/chat/:id`）
 * @property {boolean} [structuredInput] — 是否使用结构化输入（如面试题检索的技术栈选择）
 */

/** @type {Map<string, AgentDef>} */
const registry = new Map()
// 注册顺序（保持列表稳定）
const order = []

/**
 * 注册一个智能体（重复 id 会覆盖定义但保留原顺序）。
 * @param {AgentDef} def
 */
export function registerAgent(def) {
  if (!def?.id || !def?.name || !def?.icon) {
    throw new Error('registerAgent: def must have id, name, icon')
  }
  const normalized = {
    available: true,
    structuredInput: false,
    route: `/chat/${def.id}`,
    ...def,
  }
  if (!registry.has(def.id)) order.push(def.id)
  registry.set(def.id, normalized)
  return normalized
}

/**
 * 按 id 获取智能体定义。
 * @param {string} id
 * @returns {AgentDef|undefined}
 */
export function getAgent(id) {
  return registry.get(id)
}

/**
 * 列出全部智能体（含 available=false 的占位项），保持注册顺序。
 * @returns {AgentDef[]}
 */
export function listAgents() {
  return order.map((id) => registry.get(id))
}

/**
 * 仅列出可用智能体。
 * @returns {AgentDef[]}
 */
export function listAvailableAgents() {
  return listAgents().filter((a) => a.available)
}

/**
 * 解析智能体对应的聊天路由路径。
 * @param {string} id
 * @returns {string}
 */
export function getAgentRoute(id) {
  return registry.get(id)?.route ?? '/chat'
}

/**
 * 默认聊天智能体（第一个可用项）。
 * @returns {AgentDef|undefined}
 */
export function getDefaultAgent() {
  return listAvailableAgents()[0]
}
