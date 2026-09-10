import { Router } from 'express'
import { toolRegistry, workflowRegistry } from './registry.js'
import { agentRegistry } from '../agents/agentRegistry.js'
import {
  appendAudit,
  listAudit,
  isAuditEnabled,
  setAuditEnabled,
} from './audit.js'
import { listTunables, setTunable, resetTunables } from '../tunables.js'
import { usageOf } from '../quota.js'
import * as principal from '../principal.js'
import { childLogger } from '../logger.js'
import * as esStore from '../esStore.js'
import { listAllChunks } from '../milvusStore.js'
import * as wikiStore from '../wikiStore.js'
import {
  startWikiJob,
  getWikiJob,
  cancelWikiJob,
  getRunningWikiJob,
  buildWikiGraphPart,
} from '../wikiBuilder.js'

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
 *  - GET   /api/management/vector/overview            向量库总览（连接信息 + 集合结构/行数/索引）
 *  - GET   /api/management/vector/documents           向量库文档浏览列表（?q= 过滤，含每篇切片数）
 *  - GET   /api/management/vector/documents/:id/chunks 切片明细（含 text/question 双向量预览）
 *  - GET   /api/management/vector/graph               知识网络图（切片相似网络，?threshold=&topK=&includeWiki=）
 *  - POST  /api/management/wiki/generate              触发 Wiki 词条生成后台任务（202/409）
 *  - GET   /api/management/wiki/jobs/:id              生成任务进度（stage + progress + result）
 *  - POST  /api/management/wiki/jobs/:id/cancel       取消生成任务（进行中标记，已结束幂等）
 *  - GET   /api/management/wiki/status                Wiki 状态（当前任务 + 词条统计）
 *  - DELETE /api/management/wiki                      清空全部 Wiki 数据（进行中 409 拒绝）
 *  - GET   /api/management/es/status    ES 关键词索引状态（启用/条数/与 Milvus 偏差）
 *  - POST  /api/management/es/sync      全量回填（Milvus → ES，幂等，先清后建）
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
  listDocRowsLite,
  countChunksByDoc,
  listChunkRowsOfDocWithVectors,
  buildChunkGraph,
} from '../milvusStore.js'

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

/** 文档浏览列表：GET /api/management/vector/documents（?q= 按标题/分类/ID 过滤，含每篇切片数） */
router.get('/vector/documents', async (req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪' })
  }
  try {
    const [docs, chunkCounts] = await Promise.all([
      listDocRowsLite(),
      countChunksByDoc(),
    ])
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
    const items = docs
      .map((d) => ({ ...d, chunkCount: chunkCounts.get(d.id) ?? 0 }))
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

/** 文档切片明细：GET /api/management/vector/documents/:docId/chunks（含双向量预览） */
router.get('/vector/documents/:docId/chunks', async (req, res) => {
  if (!milvusReady()) {
    return res.status(503).json({ error: 'Milvus 未就绪' })
  }
  try {
    const r = await listChunkRowsOfDocWithVectors(req.params.docId)
    res.json({ docId: req.params.docId, ...r })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

/** 知识网络图缓存：key 为 `threshold|topK`，TTL 5 分钟（仪表盘反复加载不打 Milvus） */
const graphCache = new Map()
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
  if (!Number.isFinite(threshold) || threshold < 0.3 || threshold > 0.95) {
    return res.status(400).json({ error: 'threshold 需在 0.3 ~ 0.95 之间' })
  }
  if (!Number.isFinite(topK) || topK < 1 || topK > 20) {
    return res.status(400).json({ error: 'topK 需在 1 ~ 20 之间' })
  }
  const includeWiki = req.query.includeWiki === '1' || req.query.includeWiki === 'true'
  /** 应答前叠加 wiki 词条节点与提及边（实时读取，不进切片图缓存） */
  const respond = (data, extra = {}) => {
    if (!includeWiki) return res.json({ ...data, ...extra })
    const part = buildWikiGraphPart(new Set((data.nodes ?? []).map((n) => n.id)))
    res.json({
      ...data,
      ...extra,
      nodes: [...(data.nodes ?? []), ...part.nodes],
      edges: [...(data.edges ?? []), ...part.edges],
    })
  }
  const key = `${threshold.toFixed(2)}|${topK}`
  const hit = graphCache.get(key)
  const fresh = hit && Date.now() - hit.ts < GRAPH_TTL_MS
  if (hit) {
    if (fresh) return respond(hit.data, { cached: true })
    // 过期：先返回旧值，无进行中重建时后台刷新
    if (!hit.rebuilding) {
      hit.rebuilding = true
      buildChunkGraph({ threshold, topK })
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
    const data = await buildChunkGraph({ threshold, topK })
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

/* ---------- LLM Wiki（知识网络图词条：生成任务与状态） ---------- */

/**
 * 触发生成：POST /api/management/wiki/generate
 * 后台三阶段任务（实体抽取 → 归一合并 → 词条摘要），202 返回 jobId；
 * 已有进行中任务时 409 返回该任务（幂等触发）；LLM 未配置 503。
 */
router.post('/wiki/generate', (_req, res) => {
  try {
    const { jobId, alreadyRunning } = startWikiJob()
    appendAudit({
      action: 'wiki-generate',
      detail: `Wiki 词条生成任务 ${jobId}${alreadyRunning ? '（已有进行中任务，复用）' : ' 启动'}`,
    })
    res.status(alreadyRunning ? 409 : 202).json({ jobId, alreadyRunning })
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code })
    res.status(500).json({ error: err.message })
  }
})

/** 任务进度：GET /api/management/wiki/jobs/:id（stage: extracting/normalizing/summarizing） */
router.get('/wiki/jobs/:id', (req, res) => {
  const job = getWikiJob(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已过期（保留 10 分钟）' })
  res.json(job)
})

/** 取消任务：POST /api/management/wiki/jobs/:id/cancel（进行中标记取消，已结束幂等返回） */
router.post('/wiki/jobs/:id/cancel', (req, res) => {
  const job = cancelWikiJob(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' })
  appendAudit({ action: 'wiki-cancel', detail: `Wiki 生成任务 ${job.id} 取消` })
  res.json(job)
})

/** Wiki 状态：GET /api/management/wiki/status（当前任务 + 词条统计，挂载恢复轮询用） */
router.get('/wiki/status', (_req, res) => {
  res.json({ current: getRunningWikiJob(), stats: wikiStore.stats() })
})

/** 清空全部 Wiki 数据：DELETE /api/management/wiki（有进行中任务时 409 拒绝） */
router.delete('/wiki', (_req, res) => {
  const running = getRunningWikiJob()
  if (running) {
    return res.status(409).json({ error: `任务 ${running.id} 进行中，请先取消或等待完成` })
  }
  wikiStore.clearWiki()
  appendAudit({ action: 'wiki-clear', detail: '清空全部 LLM Wiki 词条数据' })
  res.json({ ok: true })
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
