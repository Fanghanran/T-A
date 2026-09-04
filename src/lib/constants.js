/**
 * 触发内置智能体注册（副作用 import）——必须在读取 AGENTS 之前完成。
 * 新增智能体改 agentDefinitions.js 即可，无需改本文件。
 */
import './agentDefinitions'
import { listAgents as _listAgents } from './agentRegistry'

/**
 * AGENT_STATUS —— 智能体连接状态枚举
 * @enum {string}
 */
export const AGENT_STATUS = Object.freeze({
  ONLINE: 'online',
  THINKING: 'thinking',
  OFFLINE: 'offline',
})

/**
 * 状态文案映射表
 */
export const AGENT_STATUS_LABEL = {
  [AGENT_STATUS.ONLINE]: '在线',
  [AGENT_STATUS.THINKING]: '思考中',
  [AGENT_STATUS.OFFLINE]: '离线',
}

/**
 * AGENTS —— 已注册的「聊天智能体」清单（由 agentRegistry 派生，注册见 agentDefinitions.js）
 * 知识库（knowledge-base）是全局基础设施/管理中心，不作为聊天智能体出现（从 Sidebar「管理」区进入）。
 * available=false 的项在侧边栏置灰不可点击（占位）。
 */
export const AGENTS = Object.freeze(_listAgents())

/**
 * TECH_STACK_OPTIONS —— 面试题检索智能体可选技术栈
 */
export const TECH_STACK_OPTIONS = Object.freeze([
  'React',
  'Vue',
  'Vite',
  'Next.js',
  'TypeScript',
  'Node.js',
  'Webpack',
  'Tailwind CSS',
  'JavaScript',
  'CSS',
  'HTTP',
  '浏览器原理',
  '工程化',
  '性能优化',
  '状态管理',
])

/**
 * API_CHAT_ENDPOINT —— 流式对话端点
 */
export const API_CHAT_ENDPOINT = '/api/chat'

/**
 * 知识库智能体 id
 */
export const KNOWLEDGE_AGENT_ID = 'knowledge-base'

/**
 * 知识库 REST 端点根（前端经 Vite 代理转后端）
 * 完整契约见 README「知识库后端接口契约」一节
 */
export const KNOWLEDGE_API_BASE = '/api/knowledge'

/**
 * 知识库文档预设分类（后端无数据时的兜底建议项，实际以后端返回为准）
 */
export const KNOWLEDGE_CATEGORIES = Object.freeze([
  '前端',
  '后端',
  '算法',
  '工程化',
  '数据库',
  '计算机基础',
  '行为面试',
])

/**
 * 知识库预设标签建议（输入时联想）
 */
export const KNOWLEDGE_TAG_OPTIONS = Object.freeze([
  'React',
  'Vue',
  'Node.js',
  'TypeScript',
  'CSS',
  '性能优化',
  'HTTP',
  '浏览器原理',
  '系统设计',
  '手写题',
])
