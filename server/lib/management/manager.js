import { Router } from 'express'
import { toolRegistry, workflowRegistry } from './registry.js'
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

export default router
