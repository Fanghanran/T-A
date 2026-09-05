import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from './logger.js'

/**
 * tunables —— 运行时可调参数的单一来源（L0 基础设施）
 *
 * 职责：把散落在 config.js / docProcessor.js 里的调优常量（切片参数、语义评分阈值、
 * 去重阈值、查询改写参数）收敛为「带元数据的可变对象」，供管理模块在线修改、热生效：
 *  - 消费方（chunker / docProcessor / queryRewriter）持有的是本模块导出的活对象引用，
 *    且均在调用时读属性 → setTunable 原地改值即刻生效，无需重启
 *  - 持久化 data/management/tunables.json（与 registry 同风格：只存被改过的项）
 *
 * 分层约束：本模块位于 L0，不感知任何上层消费方；REST 暴露由 management/manager.js（L8）
 * 完成，审计由调用方（manager / registry，L5+）写入 management/audit.js。
 */

const log = childLogger('tunables')

const TUNABLES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'management', 'tunables.json')

/**
 * 参数定义（分组）。type 决定校验方式：int / float / bool。
 * live 对象是导出给消费方的活引用 —— 键必须与定义一一对应。
 */
const GROUPS = [
  {
    key: 'chunker',
    label: '切片参数',
    description: '结构化递归切片与语义细切的核心参数（chunker.js）',
    defaults: {
      maxChars: 1000,
      hardMaxChars: 2000,
      absoluteMaxChars: 2500,
      minChars: 100,
      semanticStdK: 1,
      semanticMinSimilarity: 0.5,
      contextSentences: 2,
      questionsPerChunk: 3,
    },
  },
  {
    key: 'scoring',
    label: '切片评分（语义信号）',
    description: '混合评分的向量语义阈值与惩罚幅度（docProcessor.js）',
    defaults: {
      adjacentSim: 0.9,
      adjacentPenalty: 12,
      intraCoherence: 0.4,
      intraPenalty: 15,
      maxSentences: 400,
    },
  },
  {
    key: 'dedup',
    label: '文档去重阈值',
    description: '入库去重的余弦相似度阈值（docProcessor.js / docTools.js）',
    defaults: {
      withinBatch: 0.96,
      crossDoc: 0.985,
    },
  },
  {
    key: 'rewrite',
    label: '查询改写',
    description: '检索前的 query 改写参数（queryRewriter.js）',
    defaults: {
      rewriteTimeoutMs: 1200,
      rewriteEnabled: true,
      queriesPerRequest: 3,
      historyTurns: 3,
    },
  },
  {
    key: 'memory',
    label: '会话记忆',
    description: '两层记忆参数：短期滚动摘要 + 长期事实提炼（memoryService.js / ADR-007）',
    defaults: {
      enabled: true,
      summaryEveryTurns: 6,
      extractEveryTurns: 4,
      recallTopK: 4,
      summaryBudgetChars: 600,
      factBudgetChars: 800,
      maxFactsPerExtract: 5,
    },
  },
]

/** 每个参数的元数据（label / range / 说明），key 扁平化为 "group.key" */
const META = {
  'chunker.maxChars': { label: '目标字数', type: 'int', min: 200, max: 4000, description: '单个 chunk 的目标字数，超限触发语义细切' },
  'chunker.hardMaxChars': { label: '硬上限字数', type: 'int', min: 500, max: 8000, description: '兜底硬上限，防止代码块/表格撑爆上下文' },
  'chunker.absoluteMaxChars': { label: '绝对上限字数', type: 'int', min: 1000, max: 10000, description: '任何情况下不可超越的字数' },
  'chunker.minChars': { label: '最小字数', type: 'int', min: 20, max: 500, description: '低于此值自动向上合并，避免碎块' },
  'chunker.semanticStdK': { label: '语义断点 K', type: 'float', min: 0.2, max: 3, description: '断点阈值 = mean − K×std，K 越大断点越少' },
  'chunker.semanticMinSimilarity': { label: '断点相似度下限', type: 'float', min: 0.1, max: 0.9, description: '阈值兜底下限，低于此相似度一律视为断点' },
  'chunker.contextSentences': { label: '上下文句数', type: 'int', min: 0, max: 6, description: 'preContext/postContext 取前后各几句' },
  'chunker.questionsPerChunk': { label: '每块问题数', type: 'int', min: 1, max: 6, description: '入库时 LLM 为每个 chunk 预生成几个检索锚点问题' },
  'scoring.adjacentSim': { label: '相邻块重复阈值', type: 'float', min: 0.6, max: 0.99, description: '相邻块 cos ≥ 此值 → 疑似主题被切断/重复' },
  'scoring.adjacentPenalty': { label: '相邻重复扣分', type: 'int', min: 0, max: 40, description: '相邻块重复时两侧各扣的分值' },
  'scoring.intraCoherence': { label: '块内一致性阈值', type: 'float', min: 0.1, max: 0.8, description: '块内句子平均两两 cos < 此值 → 主题混杂' },
  'scoring.intraPenalty': { label: '主题混杂扣分', type: 'int', min: 0, max: 50, description: '块内语义混杂时扣的分值' },
  'scoring.maxSentences': { label: '一致性计算上限', type: 'int', min: 50, max: 2000, description: '句子总量超过此值跳过块内一致性计算（防卡顿）' },
  'dedup.withinBatch': { label: '批内去重阈值', type: 'float', min: 0.8, max: 1, description: '同文档内 cos ≥ 此值判重复，只保留首个' },
  'dedup.crossDoc': { label: '跨文档去重阈值', type: 'float', min: 0.8, max: 1, description: '与库中已有块 cos ≥ 此值跳过入库' },
  'rewrite.rewriteTimeoutMs': { label: '改写超时(ms)', type: 'int', min: 200, max: 30000, description: '改写 LLM 超时即降级为原始 query 检索' },
  'rewrite.rewriteEnabled': { label: '启用改写', type: 'bool', description: '总开关，关闭后走纯原始 query 检索' },
  'rewrite.queriesPerRequest': { label: '生成查询数', type: 'int', min: 1, max: 8, description: '每次检索生成几个查询（含主查询）' },
  'rewrite.historyTurns': { label: '历史轮数', type: 'int', min: 1, max: 10, description: '改写参考的对话历史窗口轮数' },
  'memory.enabled': { label: '启用记忆', type: 'bool', description: '总开关：关闭后不召回、不摘要、不提炼' },
  'memory.summaryEveryTurns': { label: '摘要触发轮数', type: 'int', min: 1, max: 30, description: '新增用户消息达到此轮数后滚动一次会话摘要' },
  'memory.extractEveryTurns': { label: '提炼触发轮数', type: 'int', min: 1, max: 30, description: '新增用户消息达到此轮数后提炼一次长期事实' },
  'memory.recallTopK': { label: '召回条数', type: 'int', min: 1, max: 10, description: '每轮检索召回的长期事实条数上限' },
  'memory.summaryBudgetChars': { label: '摘要字数上限', type: 'int', min: 100, max: 2000, description: '滚动摘要的最大字符数' },
  'memory.factBudgetChars': { label: '事实字数上限', type: 'int', min: 100, max: 2000, description: '单条长期事实注入 prompt 的最大字符数' },
}

// ---------- 活对象（导出给消费方，调用时读属性 → 原地改值热生效） ----------

export const tunables = Object.fromEntries(
  GROUPS.map((g) => [g.key, { ...g.defaults }]),
)

/** 扁平键 → 活对象引用 + 属性名 的索引 */
const SLOT_INDEX = new Map()
for (const g of GROUPS) {
  for (const k of Object.keys(g.defaults)) SLOT_INDEX.set(`${g.key}.${k}`, { obj: tunables[g.key], prop: k, group: g })
}

// ---------- 持久化（只存被改过的项，文件缺失/损坏 = 全默认） ----------

function loadOverrides() {
  try {
    if (!existsSync(TUNABLES_FILE)) return {}
    const raw = JSON.parse(readFileSync(TUNABLES_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (err) {
    log.warn(`[tunables] 读取 ${TUNABLES_FILE} 失败（${err.message}），全部按默认值处理`)
    return {}
  }
}

const _overrides = loadOverrides()
// 启动时把持久化的覆盖值套到活对象上（非法值静默忽略）
for (const [key, val] of Object.entries(_overrides)) {
  const slot = SLOT_INDEX.get(key)
  if (slot && isValid(key, val)) slot.obj[slot.prop] = val
}

function persistOverrides() {
  try {
    mkdirSync(dirname(TUNABLES_FILE), { recursive: true })
    writeFileSync(TUNABLES_FILE, JSON.stringify(_overrides, null, 2), 'utf8')
  } catch (err) {
    log.error(`[tunables] 写入 ${TUNABLES_FILE} 失败：${err.message}（修改仅本次进程生效）`)
  }
}

function isValid(key, value) {
  const meta = META[key]
  if (!meta) return false
  if (meta.type === 'bool') return typeof value === 'boolean'
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  if (meta.min !== undefined && n < meta.min) return false
  if (meta.max !== undefined && n > meta.max) return false
  return true
}

// ---------- 对外 API ----------

/**
 * 修改一个参数（原地改活对象 → 消费方即刻生效）并持久化。
 * @param {string} key 扁平键，如 "chunker.maxChars"
 * @param {*} value 新值
 * @returns {{ ok:boolean, error?:string, item?:object }}
 */
export function setTunable(key, value) {
  const slot = SLOT_INDEX.get(key)
  if (!slot) return { ok: false, error: `未定义的可调参数：${key}` }
  if (!isValid(key, value)) {
    const meta = META[key]
    return { ok: false, error: `值非法：${key} 需要 ${meta.type}${meta.min !== undefined ? `，范围 ${meta.min}~${meta.max}` : ''}` }
  }
  const v = META[key].type === 'bool' ? value : Number(value)
  const old = slot.obj[slot.prop]
  slot.obj[slot.prop] = v
  if (v === slot.group.defaults[slot.prop]) delete _overrides[key]
  else _overrides[key] = v
  persistOverrides()
  log.info(`[tunables] ${key}: ${old} → ${v}`)
  return { ok: true, from: old, item: getTunable(key) }
}

/** 恢复全部参数为默认值（清空覆盖文件） */
export function resetTunables() {
  for (const g of GROUPS) Object.assign(tunables[g.key], g.defaults)
  for (const k of Object.keys(_overrides)) delete _overrides[k]
  persistOverrides()
  log.info('[tunables] 已全部恢复默认值')
  return { ok: true }
}

function getTunable(key) {
  const slot = SLOT_INDEX.get(key)
  if (!slot) return null
  const meta = META[key]
  const value = slot.obj[slot.prop]
  const def = slot.group.defaults[slot.prop]
  return {
    key,
    group: slot.group.key,
    groupLabel: slot.group.label,
    label: meta.label,
    description: meta.description,
    type: meta.type,
    min: meta.min,
    max: meta.max,
    value,
    default: def,
    modified: value !== def,
  }
}

/** 全量列表（管理页展示）：按分组组织 */
export function listTunables() {
  const items = [...SLOT_INDEX.keys()].map(getTunable)
  const groups = GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    description: g.description,
    items: items.filter((x) => x.group === g.key),
  }))
  return { groups, items, total: items.length, modified: items.filter((x) => x.modified).length }
}
