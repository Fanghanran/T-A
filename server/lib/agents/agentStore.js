/**
 * agentStore —— Agent Spec 持久层（P1 · agents.db）
 *
 * 职责：
 *   - agents.db 建表 + 内置智能体幂等 seed（INSERT OR IGNORE，保留用户对内置的修改）
 *   - Agent Spec CRUD（管理端）与 listForFrontend（注册表数据源）
 *
 * 与 handler 的关系：本模块只管元数据（spec）。handler 解析在 routes/chat.js 的
 * 合并注册（built_in → builtinHandlers 映射；自定义 → genericAgentDef）。
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from '../logger.js'

const log = childLogger('agentStore')

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management')
const DB_FILE = join(DATA_DIR, 'agents.db')

/** 与 accounts.js 同款的 ID 规则（复用语义：字母数字下划线连字符，字母/数字开头） */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 图标白名单（前端 ICON_MAP 的 key；服务端只存字符串） */
export const ICON_KEYS = new Set([
  'bot', 'search', 'file-text', 'users', 'scissors', 'book-open', 'message-square',
  'brain-circuit', 'code', 'globe', 'mail', 'calculator', 'database', 'languages',
  'pen-line', 'shield-check',
])

const RUNTIMES = new Set(['chat', 'rag'])

mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 3000')

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL DEFAULT 'bot',
    aliases       TEXT NOT NULL DEFAULT '[]',
    enabled       INTEGER NOT NULL DEFAULT 1,
    built_in      INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0,
    runtime       TEXT NOT NULL DEFAULT 'chat',
    builtin_ref   TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    model_role    TEXT NOT NULL DEFAULT '',
    knowledge     TEXT NOT NULL DEFAULT '{}',
    structured_input INTEGER NOT NULL DEFAULT 0,
    greeting      TEXT NOT NULL DEFAULT '',
    suggestions   TEXT NOT NULL DEFAULT '[]',
    sort_order    INTEGER NOT NULL DEFAULT 100,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
`)

/* ---------- 内置智能体 seed（幂等）---------- */

const BUILTIN_SEEDS = [
  { agentId: 'interview-retrieval', name: '面试题检索', description: '按关键词与技术栈精准检索面试题目，不足时自动兜底知识库', icon: 'search', aliases: ['面试题检索'], structuredInput: 1, builtinRef: 'interview-retrieval', sortOrder: 10 },
  { agentId: 'resume-analysis', name: '简历分析', description: '解析简历并给出优化建议、岗位匹配与针对性面试题', icon: 'file-text', aliases: ['简历分析'], builtinRef: 'resume-analysis', sortOrder: 20 },
  { agentId: 'mock-interview', name: '模拟面试', description: 'AI 模拟真实面试场景对练，结束输出能力评分报告', icon: 'users', aliases: ['模拟面试'], structuredInput: 1, builtinRef: 'mock-interview', sortOrder: 30 },
  { agentId: 'doc-processor', name: '文档处理', description: '预处理、切片、整理文档，支持多种格式与自定义策略', icon: 'scissors', aliases: ['文档处理'], builtinRef: 'doc-processor', sortOrder: 40 },
  // 隐藏路由智能体：不进前端侧栏，仅作意图路由/兜底目标
  { agentId: 'knowledge-base', name: 'knowledge-base', description: '知识库 RAG 检索问答（内部路由）', icon: 'book-open', aliases: ['知识库'], hidden: 1, builtinRef: 'knowledge-base', sortOrder: 900 },
  { agentId: 'default-chat', name: 'default-chat', description: '通用对话兜底（内部路由）', icon: 'message-square', hidden: 1, builtinRef: 'default-chat', sortOrder: 910 },
]

/** 启动 seed：INSERT OR IGNORE —— 已有行（含用户对内置的改名/停用）永不覆盖 */
export function seedBuiltinAgents() {
  const now = new Date().toISOString()
  const ins = db.prepare(`
    INSERT OR IGNORE INTO agents
      (agent_id, name, description, icon, aliases, enabled, built_in, hidden, runtime, builtin_ref,
       structured_input, sort_order, created_at, updated_at)
    VALUES
      (@agentId, @name, @description, @icon, @aliases, 1, 1, @hidden, 'builtin', @builtinRef,
       @structuredInput, @sortOrder, @now, @now)
  `)
  const tx = db.transaction(() => {
    for (const s of BUILTIN_SEEDS) {
      ins.run({
        agentId: s.agentId,
        name: s.name,
        description: s.description,
        icon: s.icon,
        aliases: JSON.stringify(s.aliases ?? []),
        hidden: s.hidden ?? 0,
        builtinRef: s.builtinRef,
        structuredInput: s.structuredInput ?? 0,
        sortOrder: s.sortOrder ?? 100,
        now,
      })
    }
  })
  tx()
  const n = db.prepare('SELECT COUNT(*) AS c FROM agents').get().c
  log.info(`[agentStore] seed 完成：内置 ${BUILTIN_SEEDS.length} 个，当前共 ${n} 个 spec`)
}

/* ---------- 行 ↔ spec 映射 ---------- */

function rowToSpec(r) {
  return {
    id: r.agent_id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    aliases: JSON.parse(r.aliases || '[]'),
    enabled: !!r.enabled,
    builtIn: !!r.built_in,
    hidden: !!r.hidden,
    runtime: r.runtime,
    builtinRef: r.builtin_ref,
    systemPrompt: r.system_prompt,
    modelRole: r.model_role,
    knowledge: JSON.parse(r.knowledge || '{}'),
    structuredInput: !!r.structured_input,
    greeting: r.greeting,
    suggestions: JSON.parse(r.suggestions || '[]'),
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 全量 spec（管理端；按内置优先 + sort_order 稳定排序） */
export function listSpecs() {
  const rows = db.prepare('SELECT * FROM agents ORDER BY built_in DESC, sort_order ASC, agent_id ASC').all()
  return rows.map(rowToSpec)
}

/** 前端注册表数据源：enabled 项，隐藏项保留（前端自行过滤侧栏展示） */
export function listForFrontend() {
  return listSpecs()
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      icon: s.icon,
      hidden: s.hidden,
      structuredInput: s.structuredInput,
      aliases: s.aliases,
    }))
}

/** 数据版本号（最后更新时间戳的最大值）；/api/agents 的一致性判断用 */
export function version() {
  return db.prepare('SELECT MAX(updated_at) AS v FROM agents').get()?.v ?? ''
}

export function findSpec(agentId) {
  const r = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(String(agentId ?? ''))
  return r ? rowToSpec(r) : null
}

/* ---------- 校验 ---------- */

/** 全局别名唯一性（含 name 与内置 aliases 的跨行冲突检测；excludeId 用于更新场景） */
function assertAliasesFree(aliases, excludeId) {
  const rows = db.prepare('SELECT agent_id, name, aliases FROM agents').all()
  const taken = new Map()
  for (const r of rows) {
    if (r.agent_id === excludeId) continue
    taken.set(r.name, r.agent_id)
    for (const a of JSON.parse(r.aliases || '[]')) taken.set(a, r.agent_id)
  }
  for (const a of aliases) {
    const owner = taken.get(a)
    if (owner) throw new Error(`别名「${a}」已被智能体 ${owner} 占用`)
  }
}

/** 新建/更新共用的字段校验；返回规范化后的字段集 */
function validateSpecFields({ name, description, icon, aliases, enabled, hidden, runtime, builtinRef, systemPrompt, modelRole, knowledge, structuredInput, greeting, suggestions, sortOrder }) {
  const out = {}
  if (name !== undefined) {
    const n = String(name ?? '').trim()
    if (!n || n.length > 50) throw new Error('名称必填且不超过 50 字')
    out.name = n
  }
  if (description !== undefined) out.description = String(description ?? '').trim().slice(0, 200)
  if (icon !== undefined) {
    const k = String(icon ?? 'bot')
    if (!ICON_KEYS.has(k)) throw new Error(`未知图标：${k}`)
    out.icon = k
  }
  if (aliases !== undefined) {
    if (!Array.isArray(aliases)) throw new Error('别名必须为数组')
    const list = [...new Set(aliases.map((a) => String(a ?? '').trim()).filter(Boolean))]
    if (list.length > 8) throw new Error('别名不超过 8 个')
    for (const a of list) {
      if (a.length > 30) throw new Error(`别名过长：${a}`)
    }
    out.aliases = JSON.stringify(list)
  }
  if (enabled !== undefined) out.enabled = enabled ? 1 : 0
  if (hidden !== undefined) out.hidden = hidden ? 1 : 0
  if (runtime !== undefined) {
    if (!RUNTIMES.has(runtime)) throw new Error(`runtime 必须为 chat 或 rag`)
    out.runtime = runtime
  }
  if (builtinRef !== undefined) out.builtin_ref = String(builtinRef ?? '')
  if (systemPrompt !== undefined) {
    const p = String(systemPrompt ?? '')
    if (p.length > 4000) throw new Error('System Prompt 不超过 4000 字')
    out.system_prompt = p
  }
  if (modelRole !== undefined) out.model_role = String(modelRole ?? '').trim()
  if (knowledge !== undefined) {
    try {
      const k = typeof knowledge === 'string' ? JSON.parse(knowledge) : knowledge
      if (k == null || typeof k !== 'object' || Array.isArray(k)) throw new Error()
      out.knowledge = JSON.stringify(k)
    } catch {
      throw new Error('knowledge 必须为 JSON 对象')
    }
  }
  if (structuredInput !== undefined) out.structured_input = structuredInput ? 1 : 0
  if (greeting !== undefined) out.greeting = String(greeting ?? '').slice(0, 500)
  if (suggestions !== undefined) {
    if (!Array.isArray(suggestions)) throw new Error('建议问题必须为数组')
    const list = suggestions.map((s) => String(s ?? '').trim()).filter(Boolean)
    if (list.length > 5) throw new Error('建议问题不超过 5 条')
    out.suggestions = JSON.stringify(list)
  }
  if (sortOrder !== undefined) {
    const n = Number(sortOrder)
    if (!Number.isFinite(n)) throw new Error('sortOrder 必须为数字')
    out.sort_order = Math.trunc(n)
  }
  return out
}

/* ---------- CRUD ---------- */

/* ---------- 变更通知（运行时热同步钩子；routes/chat.js 启动时注册） ---------- */

let changeListener = null

/** 注册 spec 变更回调（单播，后注册覆盖前者） */
export function onSpecChange(fn) {
  changeListener = typeof fn === 'function' ? fn : null
}

/** CRUD 写操作后触发运行时热同步；回调异常只告警，不影响事务结果 */
function emitSpecChange(agentId) {
  try {
    changeListener?.(agentId)
  } catch (err) {
    log.warn(`[agentStore] 变更回调失败（${agentId}）：${err.message}`)
  }
}

export function createSpec({ id, name, description, icon, aliases, runtime, systemPrompt, modelRole, knowledge, structuredInput, greeting, suggestions, sortOrder }) {
  if (!AGENT_ID_RE.test(String(id ?? ''))) {
    throw new Error('智能体 ID 无效：仅允许字母数字下划线连字符，1~32 位，且以字母或数字开头')
  }
  if (findSpec(id)) throw new Error(`智能体 ${id} 已存在`)
  if (!name && name !== '') throw new Error('名称必填')
  const fields = validateSpecFields({
    name: name ?? '', description: '', icon: icon ?? 'bot', aliases: aliases ?? [],
    runtime: runtime ?? 'chat', systemPrompt: systemPrompt ?? '', modelRole: '',
    knowledge: knowledge ?? {}, structuredInput: structuredInput ?? false,
    greeting: greeting ?? '', suggestions: suggestions ?? [], sortOrder,
  })
  assertAliasesFree(JSON.parse(fields.aliases), null)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO agents
      (agent_id, name, description, icon, aliases, enabled, built_in, hidden, runtime, builtin_ref,
       system_prompt, model_role, knowledge, structured_input, greeting, suggestions, sort_order,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fields.name, fields.description, fields.icon, fields.aliases, fields.runtime,
    fields.system_prompt, fields.model_role, fields.knowledge, fields.structured_input,
    fields.greeting, fields.suggestions, fields.sort_order ?? 100, now, now,
  )
  log.info(`[agentStore] 新建智能体：${id}（runtime=${fields.runtime}）`)
  emitSpecChange(id)
  return findSpec(id)
}

export function updateSpec(agentId, patch) {
  const cur = findSpec(agentId)
  if (!cur) throw new Error(`智能体 ${agentId} 不存在`)
  // 内置保护：仅允许展示层字段（名称/描述/图标/别名/启停/排序），身份与执行通道锁定
  if (cur.builtIn) {
    const allowed = ['name', 'description', 'icon', 'aliases', 'enabled', 'sortOrder']
    const blocked = Object.keys(patch ?? {}).filter((k) => !allowed.includes(k))
    if (blocked.length) throw new Error(`内置智能体不可修改字段：${blocked.join(', ')}`)
  }
  const fields = validateSpecFields(patch)
  const keys = Object.keys(fields)
  if (!keys.length) return findSpec(agentId)
  if (fields.aliases) assertAliasesFree(JSON.parse(fields.aliases), agentId)
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  db.prepare(`UPDATE agents SET ${sets}, updated_at = ? WHERE agent_id = ?`).run(
    ...keys.map((k) => fields[k]), new Date().toISOString(), agentId,
  )
  log.info(`[agentStore] 更新智能体：${agentId}（${keys.join(',')}）`)
  emitSpecChange(agentId)
  return findSpec(agentId)
}

/**
 * 删除自定义智能体。有会话历史的软删（停用并隐藏），无历史的物理删除。
 * @returns {{ mode: 'deleted'|'disabled' }}
 */
export function deleteSpec(agentId) {
  const cur = findSpec(agentId)
  if (!cur) throw new Error(`智能体 ${agentId} 不存在`)
  if (cur.builtIn) throw new Error(`内置智能体 ${agentId} 不可删除，可停用`)
  const now = new Date().toISOString()
  db.prepare('UPDATE agents SET enabled = 0, updated_at = ? WHERE agent_id = ?').run(now, agentId)
  log.info(`[agentStore] 智能体 ${agentId} 已停用（软删，保留历史会话）`)
  emitSpecChange(agentId)
  return { mode: 'disabled' }
}
