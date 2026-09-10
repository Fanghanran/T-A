import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, embedMany } from 'ai'
import { llmConfig, embeddingConfig } from './config.js'
import { ServiceUnavailableError } from './errors.js'
import { childLogger } from './logger.js'

const log = childLogger('models')

/**
 * models —— 模型注册表（L0 基础设施，ADR-006）
 *
 * 职责：模型 profile（多模型描述条目）与路由（agent/role → profile 绑定）的
 * 存取、解析与 provider 缓存。供全部 LLM/Embedding 调用点统一选模。
 *
 * 三级解析优先级：请求覆盖 > agent 绑定 > role 绑定 > kind 默认 > 内置 default。
 * 零迁移：首次加载时从 env（LLM_* 与 EMBED_*）播种 default-chat / default-embed，
 * 未做任何配置时行为与单模型时代完全一致。
 *
 * Fail-Fast（ADR-009）：解析出的 profile 无可用 apiKey → 抛 LLM_NOT_CONFIGURED /
 * EMBED_UNAVAILABLE（绝不静默降级为假实现）。
 *
 * 持久化：data/management/models.json（profiles + routes 全量，管理页在线修改热生效）。
 * 密钥：apiKeyRef（环境变量名，推荐）或 apiKeyInline（管理页录入，读取时脱敏）。
 */

const MODELS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'management',
  'models.json',
)

/**
 * 容器部署地址改写：docker-compose 场景下 data 目录与本地 dev 共享，models.json 里
 * 指向 localhost/127.0.0.1 的服务地址在容器内不可达（localhost = 容器自身），需改写为
 * host.docker.internal（Docker Desktop 提供的宿主机别名）。由环境变量
 * MODELS_REMAP_LOCALHOST=1 显式开启（仅 compose 容器传入），本地 dev 不受影响。
 * 只在「读取消费」时改写，persist 仍存原值，避免容器把改写结果写回共享文件污染本地配置。
 */
const REMAP_LOCALHOST = /^(1|true|yes|on)$/i.test(
  String(process.env.MODELS_REMAP_LOCALHOST || '').trim(),
)
function remapBaseUrl(url) {
  if (!REMAP_LOCALHOST || typeof url !== 'string') return url
  return url.replace(
    /^(https?:\/\/)(?:localhost|127\.0\.0\.1)(?=[/:]|$)/,
    '$1host.docker.internal',
  )
}

/** 用途角色清单（chat.* 为 LLM 推理角色；embed.* 本期仅展示、绑定走 defaults.embedding） */
export const ROLES = Object.freeze([
  { key: 'chat.general', kind: 'chat', label: '通用对话' },
  { key: 'chat.rag', kind: 'chat', label: '知识库问答' },
  { key: 'chat.interview', kind: 'chat', label: '面试题检索' },
  { key: 'chat.interview.qa', kind: 'chat', label: '模拟面试问答' },
  { key: 'chat.interview.scorecard', kind: 'chat', label: '面试评分报告' },
  { key: 'chat.resume', kind: 'chat', label: '简历分析' },
  { key: 'chat.doc.analyze', kind: 'chat', label: '文档分析' },
  { key: 'chat.doc.react', kind: 'chat', label: '文档 ReAct 工作流' },
  { key: 'chat.doc.plan', kind: 'chat', label: '文档计划工作流' },
  { key: 'chat.rewrite', kind: 'chat', label: '查询改写' },
  { key: 'chat.annotations', kind: 'chat', label: '切片标注' },
  { key: 'chat.wiki', kind: 'chat', label: 'Wiki 词条生成' },
  { key: 'embed.index', kind: 'embedding', label: '向量入库', bindable: false },
  {
    key: 'embed.query',
    kind: 'embedding',
    label: '检索向量化',
    bindable: false,
  },
])

const SEED_IDS = ['default-chat', 'default-embed']

/** env 播种的默认 profile（保证零配置可用） */
function seedProfiles() {
  const out = []
  out.push({
    id: 'default-chat',
    kind: 'chat',
    label: '默认对话模型',
    baseUrl: llmConfig.baseUrl || '',
    apiKeyRef: 'LLM_API_KEY',
    model: llmConfig.model,
    params: {},
    enabled: true,
    seeded: true,
  })
  out.push({
    id: 'default-embed',
    kind: 'embedding',
    label: '默认向量模型',
    baseUrl: embeddingConfig.baseUrl || '',
    apiKeyRef: process.env.EMBED_API_KEY ? 'EMBED_API_KEY' : 'LLM_API_KEY',
    model: embeddingConfig.model,
    params: {},
    enabled: true,
    seeded: true,
  })
  return out
}

/* ---------- 活状态（profile 表 + 路由表） ---------- */

/** @type {Map<string, object>} profileId -> profile（含 apiKeyRef/apiKeyInline） */
const profiles = new Map()
/** @type {{roles: object, agents: object, defaults: object}} */
const routes = {
  roles: {},
  agents: {},
  defaults: { chat: 'default-chat', embedding: 'default-embed' },
}
/**
 * 运行时设置（随 models.json 持久化）：
 *  - thinking：qwen3 系列思考模式（默认 true 开启；关闭后注入 /no_think 软开关，
 *    跳过思维链直接出答案，RAG/HyDE 等延迟敏感链路明显提速）
 */
const settings = { thinking: true }

function load() {
  // 1) env 播种默认 profile（保证零配置可用）
  for (const p of seedProfiles()) profiles.set(p.id, { ...p })
  // 2) 合并 models.json（存在则覆盖同 id profile + 路由 + 设置）
  try {
    if (existsSync(MODELS_FILE)) {
      const raw = JSON.parse(readFileSync(MODELS_FILE, 'utf8'))
      for (const p of Array.isArray(raw?.profiles) ? raw.profiles : []) {
        if (p?.id && isValidProfile(p)) profiles.set(p.id, { ...p })
      }
      if (raw?.routes?.roles && typeof raw.routes.roles === 'object')
        routes.roles = { ...raw.routes.roles }
      if (raw?.routes?.agents && typeof raw.routes.agents === 'object')
        routes.agents = { ...raw.routes.agents }
      if (raw?.routes?.defaults && typeof raw.routes.defaults === 'object')
        routes.defaults = { ...routes.defaults, ...raw.routes.defaults }
      if (
        raw?.settings &&
        typeof raw.settings === 'object' &&
        typeof raw.settings.thinking === 'boolean'
      ) {
        settings.thinking = raw.settings.thinking
      }
    }
  } catch (err) {
    log.warn(
      `[models] 读取 ${MODELS_FILE} 失败（${err.message}），按内置默认处理`,
    )
  }
  persist()
}

function persist() {
  try {
    mkdirSync(dirname(MODELS_FILE), { recursive: true })
    writeFileSync(
      MODELS_FILE,
      JSON.stringify(
        { profiles: [...profiles.values()], routes, settings },
        null,
        2,
      ),
      'utf8',
    )
  } catch (err) {
    log.error(
      `[models] 写入 ${MODELS_FILE} 失败：${err.message}（修改仅本次进程生效）`,
    )
  }
}

function isValidProfile(p) {
  return (
    p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id) &&
    (p.kind === 'chat' || p.kind === 'embedding') &&
    typeof p.model === 'string' &&
    p.model.trim() &&
    (p.apiKeyRef === undefined || typeof p.apiKeyRef === 'string') &&
    (p.apiKeyInline === undefined || typeof p.apiKeyInline === 'string')
  )
}

load()

/* ---------- provider 缓存（profileId → 模型实例） ---------- */

const chatProviderCache = new Map()
const embedProviderCache = new Map()

/** 解析 profile 的 apiKey：apiKeyRef（环境变量名）优先，其次 inline 明文 */
function resolveApiKey(p) {
  if (p.apiKeyRef) return process.env[p.apiKeyRef] || ''
  if (p.apiKeyInline) return p.apiKeyInline
  return ''
}

/**
 * 三级解析：agents[agentId] > roles[role] > defaults[kind] > 内置 default。
 * 停用的 profile 视为不存在，顺延到下一级。全部落空 → 显式 503。
 */
function resolveProfile({ kind = 'chat', role, agentId } = {}) {
  const chain = []
  if (agentId) chain.push(routes.agents[agentId])
  if (role) chain.push(routes.roles[role])
  chain.push(routes.defaults[kind])
  chain.push(kind === 'embedding' ? 'default-embed' : 'default-chat')

  for (const id of chain) {
    if (!id) continue
    const p = profiles.get(id)
    if (p && p.enabled && p.kind === kind) return p
  }
  throw new ServiceUnavailableError(
    kind === 'embedding'
      ? 'Embedding 模型不可用：没有已启用的向量模型 profile。请在管理页配置。'
      : '对话模型不可用：没有已启用的 chat 模型 profile。请在管理页配置。',
    kind === 'embedding' ? 'EMBED_UNAVAILABLE' : 'LLM_NOT_CONFIGURED',
  )
}

/* ---------- 对外 API ---------- */

/**
 * 思考模式感知的 fetch（qwen3 专用）：关闭思考时往 /chat/completions 请求体注入
 * OpenAI 标准 reasoning_effort:'none'。实测 Ollama 0.30 OpenAI 兼容端点支持该参数
 * （reasoning 直接归零）；qwen3 官方 /no_think 软开关在该端点基本无效（实测仅缩短
 * 不消除思维链），故弃用。标志在请求时读取（settings 热改无需重建 provider 缓存）。
 */
function thinkingAwareFetch(input, init) {
  // 思考开启（默认）→ 原样透传，不碰请求
  if (settings.thinking !== false) return globalThis.fetch(input, init)
  const url = typeof input === 'string' ? input : (input?.url ?? '')
  if (!/\/chat\/completions$/.test(url) || typeof init?.body !== 'string') {
    return globalThis.fetch(input, init)
  }
  const body = JSON.parse(init.body)
  body.reasoning_effort = 'none'
  return globalThis.fetch(input, { ...init, body: JSON.stringify(body) })
}

/**
 * 获取 chat model（Fail-Fast：profile 无可用 apiKey → LLM_NOT_CONFIGURED）。
 * qwen3 系列模型挂思考模式开关 fetch（运行时热生效）。
 * @param {{role?: string, agentId?: string}} [sel]
 */
export function getChatModel(sel = {}) {
  const p = resolveProfile({
    kind: 'chat',
    role: sel?.role,
    agentId: sel?.agentId,
  })
  const key = resolveApiKey(p)
  if (!key) {
    throw new ServiceUnavailableError(
      `模型未连接：profile「${p.label || p.id}」没有可用的 API Key（${p.apiKeyRef ? `环境变量 ${p.apiKeyRef}` : 'inline 密钥'} 为空）。`,
      'LLM_NOT_CONFIGURED',
    )
  }
  let m = chatProviderCache.get(p.id)
  if (!m) {
    const opts = { apiKey: key }
    if (p.baseUrl) opts.baseURL = remapBaseUrl(p.baseUrl)
    // qwen3 系列才挂思考开关（reasoning_effort 对其他模型可能是非法参数导致 400）
    if (/qwen3/i.test(p.model)) opts.fetch = thinkingAwareFetch
    m = createOpenAI(opts).chat(p.model)
    chatProviderCache.set(p.id, m)
  }
  return m
}

/**
 * 获取 embedding model（Fail-Fast 同上）。
 * 注意：切换不同维度的 embedding 模型需重建向量集合（见 ADR-006 阶段 2）。
 */
export function getEmbedModel() {
  const p = getEmbedProfile()
  let m = embedProviderCache.get(p.id)
  if (!m) {
    const opts = { apiKey: p.apiKey }
    if (p.baseUrl) opts.baseURL = remapBaseUrl(p.baseUrl)
    m = createOpenAI(opts).embedding(p.model)
    embedProviderCache.set(p.id, m)
  }
  return m
}

/** 解析当前生效的 embedding profile（含已解析 apiKey；供 embed.js 熔断分片） */
export function getEmbedProfile() {
  const p = resolveProfile({ kind: 'embedding' })
  const apiKey = resolveApiKey(p)
  if (!apiKey) {
    throw new ServiceUnavailableError(
      `Embedding 未连接：profile「${p.label || p.id}」没有可用的 API Key。`,
      'EMBED_UNAVAILABLE',
    )
  }
  return {
    id: p.id,
    model: p.model,
    baseUrl: remapBaseUrl(p.baseUrl || ''),
    apiKey,
  }
}

/** 失效 provider 缓存（配置热改后调用；不传 id 清全部） */
export function resetProfileCache(id) {
  if (id) {
    chatProviderCache.delete(id)
    embedProviderCache.delete(id)
  } else {
    chatProviderCache.clear()
    embedProviderCache.clear()
  }
}

/* ---------- 管理视图（脱敏） ---------- */

function sanitize(p) {
  const { apiKeyInline, ...rest } = p
  return {
    ...rest,
    hasInlineKey: !!apiKeyInline,
    keyPreview: p.apiKeyRef
      ? `env:${p.apiKeyRef}`
      : apiKeyInline
        ? `inline••••(len=${apiKeyInline.length})`
        : '未设置',
  }
}

/** 全量管理视图：profiles（脱敏）+ 路由 + 设置 + 角色元数据 */
export function listModels() {
  return {
    profiles: [...profiles.values()].map(sanitize),
    routes: {
      roles: { ...routes.roles },
      agents: { ...routes.agents },
      defaults: { ...routes.defaults },
    },
    settings: { ...settings },
    roles: ROLES,
  }
}

/** 读取运行时设置（供健康检查/管理页展示） */
export function getModelSettings() {
  return { ...settings }
}

/** 更新运行时设置（思考模式等），持久化 + 热生效（无需重建 provider 缓存） */
export function setModelSettings(patch = {}) {
  if (patch && typeof patch.thinking === 'boolean')
    settings.thinking = patch.thinking
  persist()
  log.info(`[models] 运行时设置已更新：thinking=${settings.thinking}`)
  return { ...settings }
}

/**
 * 新增/更新 profile（管理页保存）。校验通过后重置对应 provider 缓存。
 * @param {object} def { id?, kind, label, baseUrl?, apiKeyRef?, apiKeyInline?, model, params?, enabled? }
 */
export function upsertModelProfile(def) {
  if (!def || typeof def !== 'object')
    throw new ServiceUnavailableError('profile 必须为对象', 'BAD_REQUEST')
  const id = String(def.id ?? '').trim() || `model-${Date.now().toString(36)}`
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    throw new ServiceUnavailableError(`profile id 非法：${id}`, 'BAD_REQUEST')
  if (def.kind !== 'chat' && def.kind !== 'embedding')
    throw new ServiceUnavailableError(
      'kind 必须为 chat 或 embedding',
      'BAD_REQUEST',
    )
  if (typeof def.model !== 'string' || !def.model.trim())
    throw new ServiceUnavailableError('model 必填', 'BAD_REQUEST')
  if (def.apiKeyRef !== undefined && typeof def.apiKeyRef !== 'string')
    throw new ServiceUnavailableError(
      'apiKeyRef 必须为字符串（环境变量名）',
      'BAD_REQUEST',
    )
  if (def.apiKeyInline !== undefined && typeof def.apiKeyInline !== 'string')
    throw new ServiceUnavailableError(
      'apiKeyInline 必须为字符串',
      'BAD_REQUEST',
    )

  const prev = profiles.get(id)
  const profile = {
    ...(prev || {}),
    id,
    kind: def.kind,
    label:
      typeof def.label === 'string' && def.label.trim() ? def.label.trim() : id,
    baseUrl:
      typeof def.baseUrl === 'string' ? def.baseUrl : (prev?.baseUrl ?? ''),
    apiKeyRef:
      typeof def.apiKeyRef === 'string' && def.apiKeyRef
        ? def.apiKeyRef
        : (prev?.apiKeyRef ?? ''),
    ...(def.apiKeyInline ? { apiKeyInline: def.apiKeyInline } : {}),
    model: def.model.trim(),
    params:
      def.params && typeof def.params === 'object'
        ? { ...def.params }
        : (prev?.params ?? {}),
    enabled: def.enabled !== false,
    seeded: !!prev?.seeded,
  }
  profiles.set(id, profile)
  persist()
  resetProfileCache(id)
  log.info(
    `[models] profile 已保存：${id} (${profile.kind} → ${profile.model})`,
  )
  return sanitize(profile)
}

/** 删除 profile：被路由/默认引用或内置播种的禁止删除 */
export function deleteModelProfile(id) {
  if (SEED_IDS.includes(id))
    throw new ServiceUnavailableError(
      '内置默认模型不可删除（可编辑或停用）',
      'BAD_REQUEST',
    )
  const referenced =
    Object.entries(routes.roles).some(([, pid]) => pid === id) ||
    Object.values(routes.agents).includes(id) ||
    Object.values(routes.defaults).includes(id)
  if (referenced)
    throw new ServiceUnavailableError(
      '该 profile 正被路由引用，请先解除绑定',
      'BAD_REQUEST',
    )
  if (!profiles.has(id))
    throw new ServiceUnavailableError('profile 不存在', 'BAD_REQUEST')
  profiles.delete(id)
  persist()
  resetProfileCache(id)
  log.info(`[models] profile 已删除：${id}`)
  return { ok: true }
}

/**
 * 更新路由（agent/role/defaults 绑定）。绑定值必须是已存在且启用的 profile id。
 * @param {{roles?:object, agents?:object, defaults?:object}} partial
 */
export function setModelRoutes(partial = {}) {
  const apply = (table, patch) => {
    for (const [key, pid] of Object.entries(patch ?? {})) {
      if (pid === null || pid === '') {
        delete table[key]
        continue
      }
      const p = profiles.get(String(pid))
      if (!p || !p.enabled)
        throw new ServiceUnavailableError(
          `绑定目标不存在或已停用：${pid}`,
          'BAD_REQUEST',
        )
      table[key] = String(pid)
    }
  }
  if (partial.roles) apply(routes.roles, partial.roles)
  if (partial.agents) apply(routes.agents, partial.agents)
  if (partial.defaults) apply(routes.defaults, partial.defaults)
  persist()
  resetProfileCache()
  log.info('[models] 路由已更新', { routes })
  return {
    ok: true,
    routes: {
      roles: { ...routes.roles },
      agents: { ...routes.agents },
      defaults: { ...routes.defaults },
    },
  }
}

/**
 * 探活：对指定 profile 发一次最小请求，返回延迟与（embedding 的）维度。
 * 用于管理页「测试连通性」。
 */
export async function testModelProfile(id) {
  const p = profiles.get(id)
  if (!p) throw new ServiceUnavailableError('profile 不存在', 'BAD_REQUEST')
  const key = resolveApiKey(p)
  if (!key) return { ok: false, error: '未配置 API Key' }
  const t0 = performance.now()
  try {
    if (p.kind === 'chat') {
      await generateText({
        model: createOpenAI({
          apiKey: key,
          ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
        }).chat(p.model),
        prompt: '连通性测试，请只回复：OK',
        maxOutputTokens: 8,
      })
      return { ok: true, latencyMs: Math.round(performance.now() - t0) }
    }
    const { embeddings } = await embedMany({
      model: createOpenAI({
        apiKey: key,
        ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
      }).embedding(p.model),
      values: ['连通性测试'],
    })
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - t0),
      dim: embeddings[0]?.length ?? 0,
    }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - t0),
      error: err.message,
    }
  }
}

/**
 * 服务模型发现：从所有已启用 profile 的 baseUrl 拉取可用模型列表。
 *
 * 探测顺序：先 Ollama 原生 GET {root}/api/tags（root 为去掉 /v1 后缀的服务根，
 * 响应带 capabilities 可区分向量/对话模型）；失败再试 OpenAI 兼容 GET {baseUrl}/models
 * （无 kind 信息，默认 chat）。
 *
 * Fail-Fast 口径（ADR-009）：单源失败不静默吞掉——显式记入 errors 返回给前端展示；
 * 全部失败时 items 为空数组 + errors 非空。模型发现是增强能力，服务列表拉不到
 * 不影响已注册 profile 的正常使用。
 *
 * @returns {Promise<{items: Array<{model:string, kind:'chat'|'embedding', baseUrl:string, apiKeyRef:string, source:'ollama'|'openai'}>, errors: Array<{baseUrl:string, error:string}>}>}
 */
export async function discoverServiceModels() {
  // 收集去重的服务源：remap 后的 baseUrl → 源 profile 的 apiKeyRef（供一键建档继承）
  const sources = new Map()
  for (const p of profiles.values()) {
    if (!p.enabled || !p.baseUrl) continue
    const url = remapBaseUrl(p.baseUrl)
    if (!sources.has(url)) sources.set(url, p.apiKeyRef || '')
  }

  const items = []
  const errors = []
  const seen = new Set() // `${baseUrl}|${model}` 去重

  const probe = async (url, apiKeyRef) => {
    const root = url.replace(/\/v1\/?$/, '')
    // 1) Ollama 原生 tags：带 capabilities，可区分 embedding
    try {
      const res = await fetch(`${root}/api/tags`, {
        signal: AbortSignal.timeout(6000),
      })
      const j = res.ok ? await res.json() : null
      if (Array.isArray(j?.models)) {
        for (const m of j.models) {
          const name = m?.name || m?.model
          if (!name) continue
          // capabilities 在 Ollama 响应顶层（部分旧版本在 details 里，双兼容）
          const caps = Array.isArray(m?.capabilities)
            ? m.capabilities
            : Array.isArray(m?.details?.capabilities)
              ? m.details.capabilities
              : []
          const key = `${url}|${name}`
          if (seen.has(key)) continue
          seen.add(key)
          items.push({
            model: name,
            kind: caps.includes('embedding') ? 'embedding' : 'chat',
            baseUrl: url,
            apiKeyRef,
            source: 'ollama',
          })
        }
        return
      }
      throw new Error(`ollama /api/tags 不可用（HTTP ${res.status}）`)
    } catch (err) {
      // 2) 回落 OpenAI 兼容 /v1/models（无 kind 信息，按 chat 处理）
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/models`, {
          signal: AbortSignal.timeout(6000),
        })
        const j = res.ok ? await res.json() : null
        if (!Array.isArray(j?.data))
          throw new Error(`openai /models 不可用（HTTP ${res.status}）`)
        for (const m of j.data) {
          if (!m?.id) continue
          const key = `${url}|${m.id}`
          if (seen.has(key)) continue
          seen.add(key)
          items.push({
            model: m.id,
            kind: 'chat',
            baseUrl: url,
            apiKeyRef,
            source: 'openai',
          })
        }
      } catch (err2) {
        errors.push({ baseUrl: url, error: `${err.message}；${err2.message}` })
      }
    }
  }

  await Promise.all(
    [...sources.entries()].map(([url, apiKeyRef]) => probe(url, apiKeyRef)),
  )
  log.info(
    `[models] 服务模型发现：${items.length} 个可用 / ${errors.length} 个失败源`,
  )
  return { items, errors }
}
