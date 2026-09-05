import { Router } from 'express'
import { toolRegistry, workflowRegistry } from './registry.js'
import { agentRegistry } from '../agents/agentRegistry.js'
import { appendAudit, listAudit, isAuditEnabled, setAuditEnabled } from './audit.js'
import { listTunables, setTunable, resetTunables } from '../tunables.js'
import { childLogger } from '../logger.js'

/**
 * manager —— 管理模块的 REST 服务（/api/management/*）
 *
 * 职责：工具与工作流的查询 / 启停管理、运行统计展示、调优参数在线修改、
 * 操作审计查询、恢复默认。数据来源：
 *  - registry.js 两个注册表（元数据 + 启停状态 + 进程内运行统计）
 *  - tunables.js（调优参数活对象，修改即热生效）
 *  - audit.js（append-only 审计日志）
 *
 * 端点：
 *  - GET   /api/management/overview        总览（工具+工作流+统计+依赖提示）
 *  - GET   /api/management/tools           工具列表（含启用状态/运行统计/dependents）
 *  - PATCH /api/management/tools/:name     { enabled: boolean } 启停工具
 *  - GET   /api/management/workflows       工作流列表（同上）
 *  - PATCH /api/management/workflows/:name { enabled: boolean } 启停工作流
 *  - POST  /api/management/reset           { scope: 'tools'|'workflows'|'all' } 恢复全部启用
 *  - GET   /api/management/audit           ?limit=50 最近管理操作（时间倒序）
 *  - PATCH /api/management/audit           { enabled: boolean } 审计功能总开关
 *  - GET   /api/management/tunables        调优参数全量（分组 + 当前值 + 默认值）
 *  - PATCH /api/management/tunables/:key   { value } 修改参数（校验范围，热生效）
 *  - POST  /api/management/tunables/reset  调优参数全部恢复默认
 *
 * 启停语义（谁消费）：
 *  - 工具禁用 → 工作流层 System Prompt 不再列出该工具（LLM 不可见），
 *    LLM 仍执意调用时被 resolveRunner 拦截并写回 observation 自纠
 *  - 工作流禁用 → index.js 的 doc-processor 分支回退 action 关键词路由（stub 同款）
 */

const log = childLogger('management')

const router = Router()

/** 序列化注册项：剥掉 run 函数（不可 JSON 化），保留元数据、启用状态与统计 */
function serialize(item) {
  if (!item) return null
  const { run, ...rest } = item
  return { ...rest, hasRunner: typeof run === 'function' }
}

/**
 * 计算 dependents：跨两个注册表扫描 dependsOn 声明，
 * 返回「启用中的、声明依赖该项」的注册项 [{ kind, name, label }]。
 * 前端在禁用该项时据此提示级联影响（如禁用 PreviewChunks → doc-react/doc-plan 降级）。
 */
function dependentsOf(name) {
  const out = []
  for (const item of toolRegistry.list()) {
    if (item.enabled && item.dependsOn?.includes(name)) out.push({ kind: 'tool', name: item.name, label: item.label })
  }
  for (const item of workflowRegistry.list()) {
    if (item.enabled && item.dependsOn?.includes(name)) out.push({ kind: 'workflow', name: item.name, label: item.label })
  }
  return out
}

function listNamespace(registry) {
  return registry.list().map((item) => serialize({ ...item, dependents: dependentsOf(item.name) }))
}

function stats(registry) {
  const items = registry.list()
  const enabled = items.filter((x) => x.enabled).length
  return { total: items.length, enabled, disabled: items.length - enabled }
}

/* ---------- 总览 ---------- */
router.get('/overview', (_req, res) => {
  res.json({
    tools: { items: listNamespace(toolRegistry), ...stats(toolRegistry) },
    workflows: { items: listNamespace(workflowRegistry), ...stats(workflowRegistry) },
    audit: { enabled: isAuditEnabled() },
  })
})

/* ---------- 工具 ---------- */
router.get('/tools', (_req, res) => {
  res.json({ items: listNamespace(toolRegistry), ...stats(toolRegistry) })
})

router.patch('/tools/:name', (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '请求体需要 { enabled: boolean }' })
  }
  const r = toolRegistry.setEnabled(req.params.name, enabled)
  if (!r.ok) return res.status(404).json({ error: r.error })
  res.json({ item: serialize({ ...r.item, dependents: dependentsOf(r.item.name) }) })
})

/* ---------- 工作流 ---------- */
router.get('/workflows', (_req, res) => {
  res.json({ items: listNamespace(workflowRegistry), ...stats(workflowRegistry) })
})

router.patch('/workflows/:name', (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '请求体需要 { enabled: boolean }' })
  }
  const r = workflowRegistry.setEnabled(req.params.name, enabled)
  if (!r.ok) return res.status(404).json({ error: r.error })
  res.json({ item: serialize({ ...r.item, dependents: dependentsOf(r.item.name) }) })
})

/* ---------- 恢复默认（启停状态） ---------- */
router.post('/reset', (req, res) => {
  const scope = req.body?.scope ?? 'all'
  const result = {}
  if (scope === 'tools' || scope === 'all') result.tools = toolRegistry.resetAll()
  if (scope === 'workflows' || scope === 'all') result.workflows = workflowRegistry.resetAll()
  if (!result.tools && !result.workflows) {
    return res.status(400).json({ error: 'scope 非法，可选：tools / workflows / all' })
  }
  log.info(`[management] 恢复默认（scope=${scope}）`)
  res.json({ ok: true, scope, ...result })
})

/* ---------- 审计日志 ---------- */
router.get('/audit', (req, res) => {
  const n = Number(req.query?.limit)
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 50
  res.json({ enabled: isAuditEnabled(), items: listAudit(limit), total: limit })
})

/** 审计功能总开关（系统管理页「操作审计」行开关）。切换本身不写审计记录。 */
router.patch('/audit', (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '请求体需要 { enabled: boolean }' })
  }
  const r = setAuditEnabled(enabled)
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ enabled: r.enabled })
})

/* ---------- 调优参数 ---------- */
router.get('/tunables', (_req, res) => {
  res.json(listTunables())
})

router.patch('/tunables/:key', (req, res) => {
  const value = req.body?.value
  // bool 参数必须显式传布尔，数值参数接受 number 或可转数值的字符串（表单输入）
  const r = setTunable(req.params.key, value)
  if (!r.ok) return res.status(400).json({ error: r.error })
  appendAudit('tunable.set', { key: r.item.key, from: r.from, to: r.item.value, label: r.item.label })
  res.json({ item: r.item })
})

router.post('/tunables/reset', (_req, res) => {
  const r = resetTunables()
  appendAudit('tunable.reset', {})
  res.json(r)
})

/* ---------- 模型管理（ADR-006：多模型路由 · 运行时热改） ---------- */
import {
  listModels,
  upsertModelProfile,
  deleteModelProfile,
  setModelRoutes,
  testModelProfile,
} from '../models.js'

/** 模型管理端点总览：GET /api/management/models（脱敏） */
router.get('/models', (_req, res) => {
  const view = listModels()
  res.json({
    profiles: view.profiles,
    routes: view.routes,
    roles: view.roles,
    agents: agentRegistry.listAgents().map((a) => ({ id: a.id, name: a.name })),
  })
})

/** 新增/更新 profile（id 相同即覆盖；apiKeyInline 只进不出） */
router.post('/models', (req, res) => {
  try {
    const saved = upsertModelProfile(req.body ?? {})
    appendAudit('model.profile.save', { id: saved.id, kind: saved.kind, model: saved.model })
    res.json({ profile: saved })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/** 删除 profile（被路由引用或内置播种的会被 400 拒绝） */
router.delete('/models/:id', (req, res) => {
  try {
    const r = deleteModelProfile(req.params.id)
    appendAudit('model.profile.delete', { id: req.params.id })
    res.json(r)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/** 更新路由绑定（roles / agents / defaults 三级），热生效 */
router.put('/models/routes', (req, res) => {
  try {
    const r = setModelRoutes(req.body ?? {})
    appendAudit('model.routes.update', { routes: r.routes })
    res.json(r)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/** 探活：对指定 profile 发最小请求（chat 回 1 token / embed 返回 dim） */
router.post('/models/test', async (req, res) => {
  try {
    const r = await testModelProfile(String(req.body?.id ?? ''))
    res.json(r)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/* ---------- 会话记忆管理（M2 / ADR-007：长期层事实库） ---------- */
import {
  isReady as milvusReady,
  getCollections,
  countMemories,
  listMemories,
  deleteMemoriesByFilter,
  flush,
} from '../milvusStore.js'

/** 记忆统计：GET /api/management/memory/stats（总数 + 按 scope + 最近条目） */
router.get('/memory/stats', async (_req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪，记忆统计不可用' })
  }
  try {
    const [total, global, session] = await Promise.all([
      countMemories(),
      countMemories('scope == "global"'),
      countMemories('scope == "session"'),
    ])
    const recent = await listMemories({ limit: 50 })
    recent.sort((a, b) => b.ts - a.ts)
    res.json({ collection: getCollections().memory, total, global, session, recent })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/**
 * 清空记忆：POST /api/management/memory/clear
 * Body: { scope?: 'all'|'global'|'session', sessionId? }
 * scope=session 时 sessionId 必填（只清该会话的私有事实）
 */
router.post('/memory/clear', async (req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪，记忆清理不可用' })
  }
  const scope = req.body?.scope ?? 'all'
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : ''
  if (!['all', 'global', 'session'].includes(scope)) {
    return res.status(400).json({ error: `非法 scope：${scope}（允许 all / global / session）` })
  }
  if (scope === 'session') {
    if (!sessionId) return res.status(400).json({ error: 'scope=session 时 sessionId 必填' })
    // 会话 id 由服务端生成（字母数字下划线连字符），白名单校验后拼 filter，杜绝表达式注入
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'sessionId 含非法字符' })
    }
  }
  try {
    const filter =
      scope === 'global' ? 'scope == "global"'
      : scope === 'session' ? `session_id == "${sessionId}"`
      : 'mem_id != ""'
    await deleteMemoriesByFilter(filter)
    await flush([getCollections().memory])
    appendAudit('memory.clear', { scope, sessionId: scope === 'session' ? sessionId : undefined })
    res.json({ ok: true, scope })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

export default router
