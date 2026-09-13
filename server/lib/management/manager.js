import { Router } from 'express'
import { toolRegistry, workflowRegistry } from './registry.js'
import { agentRegistry } from '../agents/agentRegistry.js'
import {
  appendAudit,
  listAudit,
  isAuditEnabled,
  setAuditEnabled,
  currentActor,
} from './audit.js'
import * as auditBrowse from './audit.js'
import { listTunables, setTunable, resetTunables } from '../tunables.js'
import { usageOf } from '../quota.js'
import * as principal from '../principal.js'
import { childLogger } from '../logger.js'
import * as agentStore from '../agents/agentStore.js'
import { requirePerm } from '../security.js'
import * as esStore from '../esStore.js'
import { listAllChunks } from '../milvusStore.js'
import * as anchors from '../anchorStore.js'
import * as files from '../fileStore.js'
import * as vindex from '../vectorIndexV3.js'
import * as sessionStore from '../sessionStore.js'
import * as accountsStore from '../auth/accounts.js'
import {
  listAccounts,
  setAccountStatus,
  setAccountRole,
  resetAccountPassword,
  unlockAccount,
  countAdmins,
  createAccountByAdmin,
  deleteAccount,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  findRole,
  findAccount,
} from '../auth/accounts.js'
import { PERM_CATALOG } from '../auth/perms.js'

/**
 * manager —— 管理模块的 REST 服务（/api/management/*）
 *
 * 模块分层（L8）：依赖 L5 注册表（registry/audit）与 L1 存储层。
 * 端点：
 *  - GET   /api/management/overview        总览（工具+工作流+统计+依赖提示）
 *  - GET   /api/management/usage           各用户用量与配额（v3）
 *  - GET   /api/management/vector/graph    知识网络图（切片相似网络）
 *  - GET/PATCH /api/management/audit       操作审计与开关
 *  - GET/POST/DELETE /api/management/users 用户令牌管理（M5a）
 */

const router = Router()

/* ---------- RBAC 权限段挂载（用户模块 v2.3）----------
 * /api/management 全局已有 authRequired（index.js：disabled 全放行 / jwt 有效登录 / ADMIN_TOKEN），
 * 此处按子路径再挂细粒度权限；admin 角色恒全权，其余角色按 role_perms 实时判定。
 * overview / usage 等只读统计仅要求登录，不挂权限。 */
router.use('/auth/users', requirePerm('mgmt.users'))
router.use('/auth/roles', requirePerm('mgmt.roles'))
router.use('/db', requirePerm('db'))
// 向量结构探查（collections/documents/rows）属管理 DB 检查 → db 权限；
// /vector/graph 是知识网络图，用户面功能（独立页 + 仪表盘卡片消费），登录即可 → 显式豁免
router.use('/vector', (req, res, next) => {
  if (req.path === '/graph') return next()
  return requirePerm('db')(req, res, next)
})
router.use('/tunables', requirePerm('mgmt.params'))
router.use('/es', requirePerm('mgmt.params'))
router.use('/wiki', requirePerm('graph'))
router.use('/memory', requirePerm('mgmt.params'))
router.use('/storage', requirePerm('mgmt.params'))
router.use('/audit', requirePerm('mgmt.audit'))
router.use('/models', requirePerm('mgmt.models'))
router.use('/tools', requirePerm('mgmt.tools'))
router.use('/workflows', requirePerm('mgmt.workflows'))
router.use('/agents', requirePerm('mgmt.agents'))
router.use('/users', requirePerm('mgmt.params')) // 旧 M5a 用户令牌管理（参数管理页 UI）
router.use('/reset', requirePerm('mgmt.workflows', 'mgmt.tools'))

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
    if (item.enabled && item.dependsOn?.includes(name))
      out.push({ kind: 'tool', name: item.name, label: item.label })
  }
  for (const item of workflowRegistry.list()) {
    if (item.enabled && item.dependsOn?.includes(name))
      out.push({ kind: 'workflow', name: item.name, label: item.label })
  }
  return out
}

function listNamespace(registry) {
  return registry
    .list()
    .map((item) => serialize({ ...item, dependents: dependentsOf(item.name) }))
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
    workflows: {
      items: listNamespace(workflowRegistry),
      ...stats(workflowRegistry),
    },
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
  res.json({
    item: serialize({ ...r.item, dependents: dependentsOf(r.item.name) }),
  })
})

/* ---------- 工作流 ---------- */
router.get('/workflows', (_req, res) => {
  res.json({
    items: listNamespace(workflowRegistry),
    ...stats(workflowRegistry),
  })
})

router.patch('/workflows/:name', (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '请求体需要 { enabled: boolean }' })
  }
  const r = workflowRegistry.setEnabled(req.params.name, enabled)
  if (!r.ok) return res.status(404).json({ error: r.error })
  res.json({
    item: serialize({ ...r.item, dependents: dependentsOf(r.item.name) }),
  })
})

/* ---------- 恢复默认（启停状态） ---------- */
router.post('/reset', (req, res) => {
  const scope = req.body?.scope ?? 'all'
  const result = {}
  if (scope === 'tools' || scope === 'all')
    result.tools = toolRegistry.resetAll()
  if (scope === 'workflows' || scope === 'all')
    result.workflows = workflowRegistry.resetAll()
  if (!result.tools && !result.workflows) {
    return res
      .status(400)
      .json({ error: 'scope 非法，可选：tools / workflows / all' })
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

/* ---------- 数据库目录：审计库（audit.db 只读浏览，与 session/base 同形状） ---------- */
router.get('/db/audit/tables', (_req, res) => {
  try {
    res.json(auditBrowse.browseTables())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

router.get('/db/audit/tables/:name/rows', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  try {
    res.json(auditBrowse.browseRows(req.params.name, limit, offset))
  } catch (err) {
    const status = err.message.startsWith('未知表') ? 404 : 503
    res.status(status).json({ error: err.message })
  }
})

/* ---------- 用量视图（M5b：各 user 的文档/切片用量与配额上限） ---------- */
router.get('/usage', (_req, res) => {
  // disabled 模式只有 local 一个身份；user-token 模式把已签发的用户一并列出。
  // 未签发过任何 token 时 listUsers() 为空，local 始终兜底出现。
  const known = new Set([principal.LOCAL_USER_ID])
  for (const u of principal.listUsers()) known.add(u.userId)
  const items = [...known].map((userId) => ({ userId, ...usageOf(userId) }))
  res.json({ enabled: true, items })
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
  appendAudit('tunable.set', {
    key: r.item.key,
    from: r.from,
    to: r.item.value,
    label: r.item.label,
  })
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
  setModelSettings,
  testModelProfile,
  discoverServiceModels,
} from '../models.js'

/** 模型管理端点总览：GET /api/management/models（脱敏） */
router.get('/models', (_req, res) => {
  const view = listModels()
  res.json({
    profiles: view.profiles,
    routes: view.routes,
    settings: view.settings,
    roles: view.roles,
    agents: agentRegistry.listAgents().map((a) => ({ id: a.id, name: a.name })),
  })
})

/** 新增/更新 profile（id 相同即覆盖；apiKeyInline 只进不出） */
router.post('/models', (req, res) => {
  try {
    const saved = upsertModelProfile(req.body ?? {})
    appendAudit('model.profile.save', {
      id: saved.id,
      kind: saved.kind,
      model: saved.model,
    })
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

/** 更新模型运行时设置（qwen3 思考模式开关等），热生效 */
router.put('/models/settings', (req, res) => {
  try {
    const r = setModelSettings(req.body ?? {})
    appendAudit('model.settings.update', r)
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

/**
 * 服务模型发现：从已启用 profile 的 baseUrl 拉取全部可用模型
 * （Ollama /api/tags 优先，OpenAI 兼容 /v1/models 回落）。
 * 供模型管理页下拉「检索所有对话模型」；单源失败记入 errors 显式返回。
 */
router.get('/models/discover', async (_req, res) => {
  try {
    const r = await discoverServiceModels()
    res.json(r)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/* ---------- ES 关键词索引 ---------- */

/** ES 索引状态：启用开关、索引条数、与 Milvus 切片总数的偏差（不自动同步，显式操作） */
router.get('/es/status', async (_req, res) => {
  if (!esStore.isEnabled()) {
    return res.json({ enabled: false, esCount: -1, milvusCount: -1, drift: 0 })
  }
  try {
    const [esCount, all] = await Promise.all([esStore.countChunks(), listAllChunks()])
    res.json({
      enabled: true,
      esCount,
      milvusCount: all.length,
      drift: all.length - esCount,
    })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/** 全量回填：Milvus → ES（幂等，先清后建；回填完成写审计） */
router.post('/es/sync', async (_req, res) => {
  if (!esStore.isEnabled()) {
    return res.status(400).json({ error: 'ES_ENABLED=off，关键词索引未启用' })
  }
  try {
    const all = await listAllChunks()
    const { indexed } = await esStore.rebuildIndex(all)
    appendAudit({
      action: 'es-sync',
      detail: `ES 关键词索引全量回填：${indexed} 块（Milvus 共 ${all.length} 块）`,
    })
    res.json({ indexed, milvusCount: all.length })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/* ---------- 会话记忆管理（M2 / ADR-007：长期层事实库） ---------- */
import {
  isReady as milvusReady,
  getCollections,
  countMemoriesAll,
  listMemories,
  deleteMemoriesByFilter,
  ownerSchemaStatus,
  ownerRebuild,
  flush,
  describeStoreInfo,
  listBrowseCollections,
  describeCollectionInfo,
  listDocRowsLite,
  countChunksByDoc,
  listChunkRowsOfDocWithVectors,
} from '../milvusStore.js'
// 知识网络图走 v3 数据源（锚点层节点 + kb_vectors 精确余弦），不再读旧集合 kb_chunks
import { buildChunkGraph } from '../vectorStoreV3.js'

/* ---------- 数据库目录（/db/:store：SQLite 库的表结构与行明细，只读） ---------- */
// store 键：session（会话库）/ memory（记忆库：Milvus kb_memory + SQLite session_memory）/ base（账号库）/ audit（审计库）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const AUDIT_DB_FILE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management', 'audit.db',
)
const auditBrowser = makeSqliteBrowser({
  db: new Database(AUDIT_DB_FILE, { readonly: true, fileMustExist: true }),
  file: AUDIT_DB_FILE,
  tableMeta: { audit_log: { desc: '操作审计日志', order: 0 } },
  label: 'audit-db',
})

const DB_BROWSERS = {
  session: {
    tables: () => sessionStore.browseTables(),
    rows: (name, limit, offset) => sessionStore.browseRows(name, limit, offset),
  },
  base: {
    tables: () => browseBaseTables(),
    rows: (name, limit, offset) => browseBaseRows(name, limit, offset),
  },
  audit: {
    tables: () => auditBrowser.browseTables(),
    rows: (name, limit, offset) => auditBrowser.browseRows(name, limit, offset),
  },
  memory: {
    // 记忆库 = Milvus kb_memory（长期事实）+ SQLite session_memory（滚动摘要）的合并目录
    async tables() {
      const kbCount = milvusReady() ? await countMemoriesAll() : 0
      const sm = sessionStore.browseTables().items.find((t) => t.name === 'session_memory')
      return {
        file: 'Milvus kb_memory + SQLite session_memory',
        writable: false,
        items: [
          {
            name: 'kb_memory',
            kind: 'milvus',
            desc: '长期记忆事实（Milvus 集合，只读浏览）',
            rowCount: kbCount,
            columns: [
              { name: 'mem_id', kind: 'PK' }, { name: 'owner_id' }, { name: 'scope' },
              { name: 'session_id' }, { name: 'agent_name' }, { name: 'kind' },
              { name: 'text' }, { name: 'ts' },
            ],
            indexes: [],
          },
          ...(sm ? [{ ...sm, desc: '会话滚动摘要（SQLite）' }] : []),
        ],
      }
    },
    async rows(name, limit, offset) {
      if (name === 'kb_memory') {
        if (!milvusReady()) return { name, kind: 'milvus', columns: [], total: 0, rows: [] }
        const items = await listMemories({ limit, offset })
        return {
          name,
          kind: 'milvus',
          columns: ['owner_id', 'scope', 'session_id', 'agent_name', 'kind', 'text'],
          total: await countMemoriesAll(),
          rows: items.map((m) => ({
            owner_id: m.ownerId ?? 'admin',
            scope: m.scope,
            session_id: m.sessionId || '-',
            agent_name: m.agentName || '-',
            kind: m.kind ?? 'fact',
            text: m.text ?? '',
            ts: m.ts,
          })),
        }
      }
      return sessionStore.browseRows(name, limit, offset)
    },
  },
}

router.get('/db/:store/tables', async (req, res) => {
  const b = DB_BROWSERS[req.params.store]
  if (!b) return res.status(404).json({ error: `未知数据库：${req.params.store}` })
  try {
    res.json(await b.tables())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

router.get('/db/:store/tables/:name/rows', async (req, res) => {
  const b = DB_BROWSERS[req.params.store]
  if (!b) return res.status(404).json({ error: `未知数据库：${req.params.store}` })
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  try {
    res.json(await b.rows(req.params.name, limit, offset))
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/* ---------- LLM Wiki（知识网络页词条生成与查询，owner 隔离） ---------- */
// viewer 用具体身份（admin 也落自己的命名空间）；图端点的 '*' 聚合检索不受影响
const wikiViewer = (req) => (req.adminRole === 'admin' ? 'admin' : String(req.adminUserId ?? ''))

router.get('/wiki/status', (req, res) => {
  const viewer = wikiViewer(req)
  res.json({ stats: wikiStore.stats(viewer), running: getRunningWikiJob() })
})

router.post('/wiki/generate', (req, res) => {
  try {
    const viewer = wikiViewer(req)
    const job = startWikiJob(viewer)
    appendAudit('wiki.generate', { ownerId: viewer })
    res.json({ jobId: job.id })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/wiki/jobs/:id', (req, res) => {
  const job = getWikiJob(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已完成清理' })
  res.json(job)
})

router.post('/wiki/jobs/:id/cancel', (req, res) => {
  const job = cancelWikiJob(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已结束' })
  appendAudit('wiki.cancel', { jobId: req.params.id })
  res.json({ ok: true, status: job.status })
})

router.delete('/wiki', (req, res) => {
  try {
    const viewer = wikiViewer(req)
    wikiStore.clearWiki(viewer)
    invalidateGraphCache()
    appendAudit('wiki.clear', { ownerId: viewer })
    res.json({ ok: true })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** owner schema 状态与重建（M5a）：GET status / POST rebuild {dryRun?} */
router.get('/storage/owner-schema', async (_req, res) => {
  try {
    res.json(await ownerSchemaStatus())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

router.post('/storage/owner-rebuild', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false
    const r = await ownerRebuild({ dryRun })
    appendAudit('storage.ownerRebuild', { dryRun, result: r })
    res.json(r)
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 记忆统计：GET /api/management/memory/stats（总数 + 按 scope + 最近条目） */
router.get('/memory/stats', async (_req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪，记忆统计不可用' })
  }
  try {
    const [total, global, session] = await Promise.all([
      countMemoriesAll(),
      countMemoriesAll('scope == "global"'),
      countMemoriesAll('scope == "session"'),
    ])
    const recent = await listMemories({ limit: 50 })
    recent.sort((a, b) => b.ts - a.ts)
    res.json({
      collection: getCollections().memory,
      total,
      global,
      session,
      recent,
    })
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
  const sessionId =
    typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : ''
  if (!['all', 'global', 'session'].includes(scope)) {
    return res
      .status(400)
      .json({ error: `非法 scope：${scope}（允许 all / global / session）` })
  }
  if (scope === 'session') {
    if (!sessionId)
      return res.status(400).json({ error: 'scope=session 时 sessionId 必填' })
    // 会话 id 由服务端生成（字母数字下划线连字符），白名单校验后拼 filter，杜绝表达式注入
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'sessionId 含非法字符' })
    }
  }
  try {
    const filter =
      scope === 'global'
        ? 'scope == "global"'
        : scope === 'session'
          ? `session_id == "${sessionId}"`
          : 'mem_id != ""'
    await deleteMemoriesByFilter(filter)
    await flush([getCollections().memory])
    appendAudit('memory.clear', {
      scope,
      sessionId: scope === 'session' ? sessionId : undefined,
    })
    res.json({ ok: true, scope })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/* ---------- 数据库目录：会话库 / 记忆库（只读浏览，与向量库同模式） ---------- */

/**
 * 会话库（SQLite）表清单：GET /api/management/db/session/tables
 * 返回文件路径、可写状态与每张表的结构（PRAGMA table_info）+ 行数。
 */
router.get('/db/session/tables', (_req, res) => {
  try {
    res.json(sessionStore.browseTables())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 会话库表行明细：GET /api/management/db/session/tables/:name/rows?limit=&offset=（表名走白名单防注入） */
router.get('/db/session/tables/:name/rows', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  try {
    res.json(sessionStore.browseRows(req.params.name, limit, offset))
  } catch (err) {
    const status = err.message.startsWith('未知表') ? 404 : 503
    res.status(status).json({ error: err.message })
  }
})

/** 记忆库自动归类约定：集合/表名匹配 /memory/i 即纳入（新增记忆表无需登记） */
const MEMORY_NAME_RE = /memory/i

/* ---------- 数据库目录：基础库（与 RAG 无关的 SQLite 表：用户账号等） ---------- */

/** 基础库数据源（accounts.db 的浏览实现；敏感列在行明细中已掩码） */
const accountsBrowse = accountsStore

/* ---------- 权限管理（用户账号：角色 / 禁用 / 解锁 / 重置密码，Admin 专属） ---------- */

/** 端点内部错误 → 400/404，其余 503 */
const authErrStatus = (err) =>
  err.message.includes('不存在')
    ? 404
    : err.message.startsWith('非法') ||
        err.message.includes('过短') ||
        err.message.includes('无效') ||
        err.message.includes('已存在') ||
        err.message.includes('已被') ||
        err.message.includes('仍被') ||
        err.message.includes('不可')
      ? 400
      : 503

/**
 * 用户账号清单：GET /api/management/auth/users
 * 含角色 / 状态 / 登录时间与 IP（密码列不出现在任何响应中）。
 */
router.get('/auth/users', (_req, res) => {
  try {
    res.json({ items: listAccounts(), admins: countAdmins() })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/**
 * 设置角色：PATCH /api/management/auth/users/:userId/role  body: { role: 'admin'|'member' }
 * 保护：不能修改自己的角色；不能降级最后一个 active admin。
 */
router.patch('/auth/users/:userId/role', (req, res) => {
  const target = String(req.params.userId ?? '')
  const me = currentActor()?.userId
  try {
    if (target === me) return res.status(400).json({ error: '不能修改自己的角色（防止最后一个管理员失去权限）' })
    const role = String(req.body?.role ?? '')
    if (role === 'member') {
      const u = accountsStore.findAccount(target)
      if (!u) return res.status(404).json({ error: `用户 ${target} 不存在` })
      if (u.role === 'admin' && u.status === 'active' && countAdmins() <= 1) {
        return res.status(400).json({ error: '不能降级唯一的管理员' })
      }
    }
    const changed = setAccountRole(target, role)
    if (changed) appendAudit('auth.role.set', { target, role, ownerId: me ?? target })
    res.json({ ok: true, changed })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/**
 * 创建成员（管理员代建）：POST /api/management/auth/users  body: { userId, password, label?, role? }
 * 指定角色（可为核心/自定义角色），不走「空表首注册 admin」引导。
 */
router.post('/auth/users', (req, res) => {
  const me = currentActor()?.userId
  try {
    const r = createAccountByAdmin({
      userId: String(req.body?.userId ?? '').trim(),
      password: String(req.body?.password ?? ''),
      label: req.body?.label,
      role: String(req.body?.role ?? 'member'),
    })
    appendAudit('auth.user.create', { target: r.userId, role: r.role, ownerId: me ?? r.userId })
    res.json({ ok: true, ...r })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/**
 * 删除成员：DELETE /api/management/auth/users/:userId
 * 保护：不能删除自己；不能删除最后一个 active admin。仅删账号（业务数据保留待清理）。
 */
router.delete('/auth/users/:userId', (req, res) => {
  const target = String(req.params.userId ?? '')
  const me = currentActor()?.userId
  try {
    if (target === me) return res.status(400).json({ error: '不能删除自己' })
    deleteAccount(target)
    appendAudit('auth.user.delete', { target, ownerId: me ?? target })
    res.json({ ok: true })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/* ---------- 角色管理（RBAC：角色清单 / 增删改 / 权限矩阵） ---------- */

/** 角色清单（含权限集与成员引用数）+ 可勾选权限点目录：GET /api/management/auth/roles */
router.get('/auth/roles', (_req, res) => {
  try {
    res.json({ items: listRoles(), catalog: PERM_CATALOG })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 新建角色：POST /api/management/auth/roles  body: { roleId, name, description?, perms[] } */
router.post('/auth/roles', (req, res) => {
  const me = currentActor()?.userId
  try {
    const r = createRole({
      roleId: String(req.body?.roleId ?? '').trim(),
      name: String(req.body?.name ?? ''),
      description: req.body?.description,
      perms: req.body?.perms,
    })
    appendAudit('auth.role.create', { target: r.roleId, ownerId: me ?? r.roleId })
    res.json({ ok: true, ...r })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 更新角色（member 可调权限集；自定义角色可改名/描述）：PATCH /api/management/auth/roles/:roleId */
router.patch('/auth/roles/:roleId', (req, res) => {
  const roleId = String(req.params.roleId ?? '')
  const me = currentActor()?.userId
  try {
    const r = updateRole(roleId, { name: req.body?.name, description: req.body?.description, perms: req.body?.perms })
    appendAudit('auth.role.perms', { target: roleId, perms: r.perms, ownerId: me ?? roleId })
    res.json({ ok: true, ...r })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 删除角色：DELETE /api/management/auth/roles/:roleId（内置不可删；被引用不可删） */
router.delete('/auth/roles/:roleId', (req, res) => {
  const roleId = String(req.params.roleId ?? '')
  const me = currentActor()?.userId
  try {
    deleteRole(roleId)
    appendAudit('auth.role.delete', { target: roleId, ownerId: me ?? roleId })
    res.json({ ok: true })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 角色引用校验辅助（成员管理页角色下拉禁用判定用） */
router.get('/auth/roles/:roleId/exists', (req, res) => {
  const r = findRole(String(req.params.roleId ?? ''))
  res.json({ exists: Boolean(r), builtIn: Boolean(r?.built_in) })
})

/* ---------- 智能体管理（P1：Agent Spec CRUD） ---------- */

/** Spec 清单（全字段）：GET /api/management/agents */
router.get('/agents', (_req, res) => {
  try {
    res.json({ items: agentStore.listSpecs(), version: agentStore.version() })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 新建自定义智能体：POST /api/management/agents  body: Agent Spec（id/name/runtime 必填） */
router.post('/agents', (req, res) => {
  const me = currentActor()?.userId
  try {
    const spec = agentStore.createSpec({
      id: String(req.body?.id ?? '').trim(),
      name: req.body?.name,
      description: req.body?.description,
      icon: req.body?.icon,
      aliases: req.body?.aliases,
      runtime: req.body?.runtime,
      systemPrompt: req.body?.systemPrompt,
      modelRole: req.body?.modelRole,
      knowledge: req.body?.knowledge,
      structuredInput: req.body?.structuredInput,
      greeting: req.body?.greeting,
      suggestions: req.body?.suggestions,
      sortOrder: req.body?.sortOrder,
      tools: req.body?.tools,
    })
    appendAudit('agent.create', { target: spec.id, ownerId: me ?? spec.id })
    res.json({ ok: true, spec })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 更新：PATCH /api/management/agents/:id（内置仅允许展示层字段，store 内强校验） */
router.patch('/agents/:id', (req, res) => {
  const me = currentActor()?.userId
  try {
    const spec = agentStore.updateSpec(String(req.params.id ?? ''), req.body ?? {})
    appendAudit('agent.update', { target: spec.id, fields: Object.keys(req.body ?? {}), ownerId: me ?? spec.id })
    res.json({ ok: true, spec })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 删除：DELETE /api/management/agents/:id（内置 403；实际为停用软删，保留历史会话） */
router.delete('/agents/:id', (req, res) => {
  const me = currentActor()?.userId
  try {
    const r = agentStore.deleteSpec(String(req.params.id ?? ''))
    appendAudit('agent.delete', { target: req.params.id, mode: r.mode, ownerId: me ?? req.params.id })
    res.json({ ok: true, ...r })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 导出 Agent Spec：GET /api/management/agents/:id/export（spec 本身无密钥，直接下发） */
router.get('/agents/:id/export', (req, res) => {
  try {
    const spec = agentStore.findSpec(String(req.params.id ?? ''))
    if (!spec) return res.status(404).json({ error: '智能体不存在' })
    appendAudit('agent.export', { target: spec.id })
    res.json({ version: agentStore.version(), exportedAt: new Date().toISOString(), spec })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 导入 Agent Spec：POST /api/management/agents/import  body: {spec, overwrite?}
 *  overwrite=false（默认）：id 已存在时报 409；true：覆盖同 id 的自定义智能体（内置仍拒绝） */
router.post('/agents/import', (req, res) => {
  const me = currentActor()?.userId
  try {
    const spec = req.body?.spec
    if (!spec || typeof spec !== 'object' || !spec.id) {
      return res.status(400).json({ error: '缺少 spec（含 id）' })
    }
    const exists = agentStore.findSpec(String(spec.id))
    if (exists && req.body?.overwrite !== true) {
      return res.status(409).json({ error: `智能体 ${spec.id} 已存在；如需覆盖请携带 overwrite: true` })
    }
    const saved = exists
      ? agentStore.updateSpec(String(spec.id), { ...spec, id: String(spec.id) })
      : agentStore.createSpec({ ...spec })
    appendAudit('agent.import', { target: saved.id, overwrite: Boolean(exists), ownerId: me ?? saved.id })
    res.json({ ok: true, spec: saved, overwritten: Boolean(exists) })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/**
 * 禁用/启用：PATCH /api/management/auth/users/:userId/status  body: { status: 'active'|'disabled' }
 * 保护：不能禁用自己；不能禁用最后一个 active admin。禁用同时清锁定状态。
 */
router.patch('/auth/users/:userId/status', (req, res) => {
  const target = String(req.params.userId ?? '')
  const me = currentActor()?.userId
  try {
    const status = String(req.body?.status ?? '')
    if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: `非法状态：${status}` })
    if (target === me && status === 'disabled') return res.status(400).json({ error: '不能禁用自己' })
    if (status === 'disabled') {
      const u = accountsStore.findAccount(target)
      if (!u) return res.status(404).json({ error: `用户 ${target} 不存在` })
      if (u.role === 'admin' && countAdmins() <= 1) {
        return res.status(400).json({ error: '不能禁用唯一的管理员' })
      }
    }
    const changed = setAccountStatus(target, status)
    if (changed) appendAudit('auth.status.set', { target, status, ownerId: me ?? target })
    res.json({ ok: true, changed })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/** 解锁（清失败计数与锁定）：POST /api/management/auth/users/:userId/unlock */
router.post('/auth/users/:userId/unlock', (req, res) => {
  const target = String(req.params.userId ?? '')
  const me = currentActor()?.userId
  try {
    const changed = unlockAccount(target)
    if (changed) appendAudit('auth.unlock', { target, ownerId: me ?? target })
    res.json({ ok: true, changed })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/**
 * 重置密码：POST /api/management/auth/users/:userId/reset-password  body: { password }
 * 不验旧密码（凭 admin 权限）；同时清失败锁定。目标用户需重新登录获取新令牌。
 */
router.post('/auth/users/:userId/reset-password', (req, res) => {
  const target = String(req.params.userId ?? '')
  const me = currentActor()?.userId
  try {
    resetAccountPassword(target, String(req.body?.password ?? ''))
    appendAudit('auth.password.reset', { target, ownerId: me ?? target })
    res.json({ ok: true })
  } catch (err) {
    res.status(authErrStatus(err)).json({ error: err.message })
  }
})

/**
 * 基础库表清单：GET /api/management/db/base/tables
 * 数据源：accounts.db（用户账号）等基础 SQLite 库；新表自动发现无需登记。
 */
router.get('/db/base/tables', (_req, res) => {
  try {
    res.json(accountsBrowse.browseTables())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 基础库表行明细：GET /api/management/db/base/tables/:name/rows（敏感列自动掩码） */
router.get('/db/base/tables/:name/rows', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  try {
    res.json(accountsBrowse.browseRows(req.params.name, limit, offset))
  } catch (err) {
    const status = err.message.startsWith('未知表') ? 404 : 503
    res.status(status).json({ error: err.message })
  }
})

/** 记忆库表清单：GET /api/management/db/memory/tables —— Milvus memory 集合（自动枚举）+ SQLite memory 表（自动发现） */
router.get('/db/memory/tables', async (_req, res) => {
  const items = []
  // ① Milvus：listCollections 动态枚举，按命名约定归类（kb_memory 及未来的 memory_* 自动纳入）
  if (milvusReady()) {
    try {
      const names = (await listBrowseCollections()).filter((n) => MEMORY_NAME_RE.test(n))
      for (const name of names) {
        const col = await describeCollectionInfo(name)
        items.push({
          name: col.name,
          kind: 'milvus',
          desc: '长期记忆事实（跨会话提炼 / 显式写入，向量召回）',
          rowCount: col.rowCount,
          columns: col.fields.map((f) => ({
            name: f.name,
            type: f.type + (f.dim ? `(${f.dim})` : ''),
            pk: !!f.isPrimaryKey,
            notnull: false,
            vector: !!f.isVector,
          })),
          indexes: col.indexes,
          createdTime: col.createdTime,
        })
      }
    } catch (err) {
      // Milvus 未就绪/部分不可用时只给 SQLite 部分（显式降级，不静默）
      log.warn(`[manager] 记忆库浏览：Milvus 部分不可用（${err.message}）`)
    }
  }
  // ② SQLite：全部表自动发现，按命名约定归入记忆库（session_memory 及未来的 *_memory）
  try {
    const sessionTables = sessionStore.browseTables()
    for (const t of sessionTables.items) {
      if (MEMORY_NAME_RE.test(t.name)) items.push(t)
    }
  } catch (err) {
    log.warn(`[manager] 记忆库浏览：SQLite 部分不可用（${err.message}）`)
  }
  res.json({ items })
})

/** 记忆库表行明细：GET /api/management/db/memory/tables/:name/rows（向量字段以预览对象下发） */
router.get('/db/memory/tables/:name/rows', async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const pv = (v) => {
    if (!Array.isArray(v) || v.length === 0) return { dim: 0, norm: 0, preview: [] }
    return {
      dim: v.length,
      norm: Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
      preview: v.slice(0, 8),
    }
  }
  try {
    const isMilvusMemory =
      milvusReady() && (await listBrowseCollections()).some((n) => n === req.params.name && MEMORY_NAME_RE.test(n))
    if (isMilvusMemory) {
      // 动态集合：从 schema 取主键与全部字段，向量字段一律转 pv 预览
      const info = await describeCollectionInfo(req.params.name)
      const pk = info.fields.find((f) => f.isPrimaryKey)?.name ?? 'id'
      const outputFields = info.fields.map((f) => f.name)
      const vectorFields = new Set(info.fields.filter((f) => f.isVector).map((f) => f.name))
      const { readCollectionRows } = await import('../vectorIndexV3.js')
      const [raw, allRows] = await Promise.all([
        readCollectionRows(req.params.name, pk, outputFields, limit, offset),
        readCollectionRows(req.params.name, pk, [pk], 16000, 0),
      ])
      const rows = raw.map((row) => {
        const out = { ...row }
        for (const vf of vectorFields) out[vf] = pv(out[vf])
        return out
      })
      return res.json({
        name: req.params.name,
        kind: 'milvus',
        columns: outputFields,
        total: allRows.length,
        rows,
      })
    }
    if (MEMORY_NAME_RE.test(req.params.name)) {
      const r = sessionStore.browseRows(req.params.name, limit, offset)
      if (r) return res.json(r)
    }
    return res.status(404).json({ error: `未知表：${req.params.name}` })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/* ---------- 向量库浏览（只读：集合结构 + 文档/切片/向量明细，Admin 跨 owner 视角） ---------- */

/** 向量库总览：GET /api/management/vector/overview（连接信息 + 三个集合的结构与行数） */
router.get('/vector/overview', async (_req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪，向量库浏览不可用' })
  }
  try {
    res.json(await describeStoreInfo())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/* ---------- v3 集合浏览：有几张表就几个明细，字段 = 集合 schema（集合动态枚举，新集合自动纳入） ---------- */

/** 集合列表：GET /api/management/vector/collections（listCollections 自动发现，含 schema 主键与行数） */
router.get('/vector/collections', async (_req, res) => {
  if (!milvusReady()) return res.status(503).json({ error: 'Milvus 未就绪' })
  try {
    const items = []
    for (const name of await listBrowseCollections()) {
      const info = await describeCollectionInfo(name)
      const pk = info.fields.find((f) => f.isPrimaryKey)?.name ?? 'id'
      items.push({ name, pk, rowCount: info.rowCount })
    }
    res.json({ items })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 集合行明细：GET /api/management/vector/collections/:name/rows?limit=&offset=
 *  字段 = 集合 schema 原生字段（动态 describe，新集合无需登记）；向量字段以预览对象返回（dim/范数/前 8 维）。 */
router.get('/vector/collections/:name/rows', async (req, res) => {
  if (!milvusReady()) return res.status(503).json({ error: 'Milvus 未就绪' })
  try {
    const names = await listBrowseCollections()
    if (!names.includes(req.params.name)) {
      return res.status(404).json({ error: '未知集合' })
    }
    // 动态 schema：主键、字段清单、向量字段全部从 describe 取（零登记）
    const info = await describeCollectionInfo(req.params.name)
    const pk = info.fields.find((f) => f.isPrimaryKey)?.name ?? 'id'
    const outputFields = info.fields.map((f) => f.name)
    const vectorFields = new Set(info.fields.filter((f) => f.isVector).map((f) => f.name))
    const { readCollectionRows } = await import('../vectorIndexV3.js')
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const [raw, allRows] = await Promise.all([
      readCollectionRows(req.params.name, pk, outputFields, limit, offset),
      readCollectionRows(req.params.name, pk, [pk], 16000, 0),
    ])
    const pv = (v) => {
      if (!Array.isArray(v) || v.length === 0) return { dim: 0, norm: 0, preview: [] }
      return {
        dim: v.length,
        norm: Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
        preview: v.slice(0, 8),
      }
    }
    const rows = raw.map((row) => {
      const out = { ...row }
      for (const vf of vectorFields) out[vf] = pv(out[vf])
      return out
    })
    res.json({ name: req.params.name, offset, count: rows.length, total: allRows.length, columns: outputFields, rows })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 文档浏览列表：GET /api/management/vector/documents（v3：读锚点层，含每篇切片数；admin 聚合全部 owner） */
router.get('/vector/documents', async (req, res) => {
  try {
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
    // 主体口径与知识网络图端点一致：admin='*' 聚合，其他角色仅自己；
    // 旧实现写死 'local'，jwt 模式下 admin 的数据全部不可见（对不上数的根因）
    const viewerId = req.adminRole === 'admin' ? '*' : String(req.adminUserId ?? '')
    if (!viewerId) return res.status(401).json({ error: '需要登录' })
    const owners = viewerId === '*' ? anchors.listOwnerIds() : [viewerId]
    const docs = owners.flatMap((o) => anchors.listDocuments(o, { pageSize: 1000 }).items)
    const items = docs
      .map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        tags: d.tags,
        size: d.size,
        status: d.status,
        uploadedAt: d.createdAt,
        ownerId: d.ownerId,
        chunkCount: anchors.countChunksOfDoc(d.id),
      }))
      .filter(
        (d) =>
          !q ||
          d.title.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q),
      )
      .sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''))
    res.json({ total: items.length, items })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 文档切片明细：GET /api/management/vector/documents/:docId/chunks（v3 数据 + V2 兼容字段，向量预览读索引层） */
router.get('/vector/documents/:docId/chunks', async (req, res) => {
  // management 挂载无 req.principal；主体取 adminUserId/adminRole（同图端点）。
  // admin 可看任意 owner 的文档（按文档实际归属读取），其他角色仅限本人
  const viewerId = req.adminRole === 'admin' ? '*' : String(req.adminUserId ?? '')
  if (!viewerId) return res.status(401).json({ error: '需要登录' })
  const doc =
    viewerId === '*'
      ? anchors.getDocumentAnyOwner(req.params.docId)
      : anchors.getDocument(req.params.docId, viewerId)
  if (!doc) return res.status(404).json({ error: '文档不存在' })
  const ownerId = doc.ownerId || viewerId
  try {
    const rows = anchors.listChunks(doc.id, ownerId)
    let full = ''
    try {
      full = files.readContent(ownerId, doc.id)
    } catch {
      full = ''
    }
    // 向量预览（dim / 范数 / 前 8 维）：本体在索引层 kb_vectors，锚点层只有引用
    let vecMap = new Map()
    try {
      vecMap = await vindex.readVectorsByDoc(doc.id, ownerId)
    } catch (err) {
      log.warn(`向量预览读取失败：${err.message}`)
    }
    const preview = (v) => {
      if (!Array.isArray(v) || v.length === 0) return { dim: 0, norm: 0, preview: [] }
      return {
        dim: v.length,
        norm: Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
        preview: v.slice(0, 8),
      }
    }
    const items = rows.map((c) => ({
      // 字段名与 V2 对齐（前端 VectorDataPage 的 FIELDS 按这些名字渲染）
      id: c.chunkId,
      idx: c.idx,
      heading: c.heading ?? '',
      topic: c.topic ?? null,
      questions: c.questions ?? [],
      text: full.slice(c.spanStart, c.spanEnd),
      displayTitle: `${doc.title} § ${c.idx + 1}`,
      category: doc.category,
      tags: doc.tags,
      status: doc.status,
      indexedAt: c.updatedAt,
      ownerId,
      textVector: preview(vecMap.get(c.vecText)?.text),
      questionVector: preview(vecMap.get(c.vecQuest)?.question),
    }))
    res.json({ docId: doc.id, items, total: items.length })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 知识网络图缓存（共享模块：vectorStoreV3 数据变更时主动失效），TTL 5 分钟 */
import graphCache from '../graphCache.js'
import { startWikiJob, getWikiJob, cancelWikiJob, getRunningWikiJob } from '../wikiBuilder.js'
import * as wikiStore from '../wikiStore.js'
import { browseTables as browseBaseTables, browseRows as browseBaseRows } from '../auth/accounts.js'
import { makeSqliteBrowser } from '../sqliteBrowse.js'
import Database from 'better-sqlite3'
import { buildWikiGraphPart, buildGraphIdResolver } from '../wikiBuilder.js'
const GRAPH_TTL_MS = 5 * 60 * 1000

/**
 * 知识网络图：GET /api/management/vector/graph?threshold=0.55&topK=6&includeWiki=1
 * 节点 = 知识切片（按文档着色），边 = text_vector 余弦相似度 ≥ threshold
 * （每节点仅保留 topK 个最强邻居，无向去重）。只读，不触碰数据。
 * includeWiki=1 时叠加 LLM Wiki 词条节点与提及边（词条实时读取 wikiStore，
 * 不进缓存——生成完成即生效，mention 边 kind='mention' 不受阈值裁剪）。
 *
 * 缓存策略 stale-while-revalidate：过期条目立即返回旧值并后台异步重建，
 * 避免万级切片重建耗时（kNN 批量检索为秒级 IO）阻塞请求；
 * 重建失败保留旧值，仅无缓存的首个请求同步等待并直接返回错误。
 */
router.get('/vector/graph', async (req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪' })
  }
  const threshold = Number(req.query.threshold ?? 0.55)
  const topK = Number(req.query.topK ?? 6)
  // includeWiki：是否叠加 LLM Wiki 词条节点（默认含；仪表盘卡片显式传 0）。
  // 缓存只存不含词条的基础切片图，词条在缓存外每次实时叠加（生成完成即生效）
  const includeWiki = !/^(0|false|no|off)$/i.test(String(req.query.includeWiki ?? '1'))
  if (!Number.isFinite(threshold) || threshold < 0.3 || threshold > 0.95) {
    return res.status(400).json({ error: 'threshold 需在 0.3 ~ 0.95 之间' })
  }
  if (!Number.isFinite(topK) || topK < 1 || topK > 20) {
    return res.status(400).json({ error: 'topK 需在 1 ~ 20 之间' })
  }
  // 知识网络按用户隔离；admin = '*' 聚合全部 owner
  // （管理挂载点经 adminAuth，主体字段是 req.adminUserId / req.adminRole，见 security.js）
  const graphOwnerId = req.adminRole === 'admin' ? '*' : String(req.adminUserId ?? '')
  if (!graphOwnerId) return res.status(401).json({ error: '需要登录' })
  const respond = (data, extra = {}) => {
    if (includeWiki) {
      const part = buildWikiGraphPart(
        new Set((data.nodes ?? []).map((n) => n.id)),
        graphOwnerId,
        { resolver: buildGraphIdResolver(data.nodes ?? []) },
      )
      data = {
        ...data,
        nodes: [...(data.nodes ?? []), ...part.nodes],
        edges: [...(data.edges ?? []), ...part.edges],
      }
    }
    res.json({ ...data, ...extra })
  }
  const key = `${graphOwnerId}|${threshold.toFixed(2)}|${topK}`
  const hit = graphCache.get(key)
  const fresh = hit && Date.now() - hit.ts < GRAPH_TTL_MS
  if (hit) {
    if (fresh) return respond(hit.data, { cached: true })
    // 过期：先返回旧值，无进行中重建时后台刷新
    if (!hit.rebuilding) {
      hit.rebuilding = true
      buildChunkGraph({ threshold, topK, ownerId: graphOwnerId })
        .then((data) => {
          graphCache.set(key, { data, ts: Date.now() })
        })
        .catch((err) => {
          req.log?.warn?.(
            { err: err.message },
            '网络图后台重建失败，保留旧缓存',
          )
        })
    }
    return respond(hit.data, { cached: true })
  }
  try {
    const data = await buildChunkGraph({ threshold, topK, ownerId: graphOwnerId })
    graphCache.set(key, { data, ts: Date.now() })
    // 顺手清理过期项，避免缓存随参数组合无限增长
    for (const [k, v] of graphCache) {
      if (Date.now() - v.ts >= GRAPH_TTL_MS) graphCache.delete(k)
    }
    respond(data)
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/* ---------- 用户管理（M5a / ADR-008：user-token 档的签发与吊销） ---------- */
import {
  issueUserToken,
  listUsers,
  revokeUser,
  usersEnabled,
} from '../principal.js'

/** 用户列表：GET /api/management/users */
router.get('/users', (_req, res) => {
  res.json({
    mode: usersEnabled() ? 'user-token' : 'disabled',
    users: listUsers(),
  })
})

/** 签发用户令牌：POST /api/management/users {userId, label?}；明文 token 仅本次返回 */
router.post('/users', (req, res) => {
  try {
    const r = issueUserToken({
      userId: req.body?.userId,
      label: req.body?.label,
    })
    appendAudit('user.token.issue', { userId: r.userId })
    res.status(201).json(r)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/** 吊销用户：DELETE /api/management/users/:userId（数据保留，令牌立即失效） */
router.delete('/users/:userId', (req, res) => {
  try {
    const ok = revokeUser(req.params.userId)
    if (!ok) return res.status(404).json({ error: '用户不存在或已吊销' })
    appendAudit('user.token.revoke', { userId: req.params.userId })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router
