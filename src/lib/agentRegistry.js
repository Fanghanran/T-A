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
// 快照缓存：useSyncExternalStore 的 getSnapshot 必须返回稳定引用，
// 否则每次渲染都产出新数组 → React 判定快照恒变 → 无限重渲染（Maximum update depth exceeded）
let snapshot = []

function rebuildSnapshot() {
  snapshot = order.map((id) => registry.get(id))
  return snapshot
}

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
  rebuildSnapshot()
  notifyChanged()
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
 * 返回缓存的稳定数组引用：仅在实际注册变更时重建（useSyncExternalStore 契约）。
 * @returns {AgentDef[]}
 */
export function listAgents() {
  return snapshot
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
 * 默认聊天智能体（第一个可见项）。
 * @returns {AgentDef|undefined}
 */
export function getDefaultAgent() {
  return listAgents().filter((a) => a.available && !a.hidden)[0]
}

/* ---------- P1：服务端注册表同步 ---------- */

import { getUserToken } from './api'
import {
  Bot, Search, FileText, Users, Scissors, BookOpen, MessagesSquare, BrainCircuit,
  Code2, Globe, Mail, Calculator, Database, Languages, PenLine, ShieldCheck,
} from 'lucide-react'

/** 图标 key → lucide 组件映射（服务端只存字符串；白名单与后端 ICON_KEYS 对齐） */
export const ICON_MAP = {
  bot: Bot,
  search: Search,
  'file-text': FileText,
  users: Users,
  scissors: Scissors,
  'book-open': BookOpen,
  'message-square': MessagesSquare,
  'brain-circuit': BrainCircuit,
  code: Code2,
  globe: Globe,
  mail: Mail,
  calculator: Calculator,
  database: Database,
  languages: Languages,
  'pen-line': PenLine,
  'shield-check': ShieldCheck,
}

const listeners = new Set()
function notifyChanged() {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/** 订阅注册表变化（React useSyncExternalStore 用）；返回退订函数 */
export function subscribeAgents(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let serverLoaded = false

/**
 * 从服务端拉取 Agent Spec 并注册（P1）。
 * 静态内置定义（agentDefinitions.js）已先行注册作为降级兜底；此处按 id 覆盖元数据
 * （显示名/描述/图标）并追加服务端新建的自定义智能体。失败时静默（保持静态清单可用）。
 * @returns {Promise<boolean>} 是否成功
 */
export async function loadAgentsFromServer() {
  try {
    const token = getUserToken()
    const res = await fetch('/api/agents', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return false
    const data = await res.json()
    if (!Array.isArray(data?.items)) return false
    for (const item of data.items) {
      const cur = registry.get(item.id)
      registerAgent({
        id: item.id,
        name: item.name,
        description: item.description ?? '',
        icon: ICON_MAP[item.icon] ?? Bot,
        available: cur?.available ?? true,
        hidden: item.hidden ?? false,
        structuredInput: item.structuredInput ?? false,
        aliases: item.aliases ?? [],
        route: cur?.route ?? `/chat/${item.id}`,
      })
    }
    serverLoaded = true
    notifyChanged()
    return true
  } catch {
    return false
  }
}

/** 服务端清单是否已加载（避免重复拉取的判定用） */
export function isServerLoaded() {
  return serverLoaded
}
