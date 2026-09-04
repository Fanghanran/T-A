import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from '../logger.js'
import { appendAudit } from './audit.js'

/**
 * registry —— 工具 / 工作流注册表（管理模块的存储基础）
 *
 * 职责：
 *  1. 注册（register）：工具/工作流在各自模块里声明元数据（名称、中文标签、描述、
 *     参数说明、类别、dependsOn 依赖声明），元数据跟随代码走，不加持久化
 *  2. 启停（setEnabled / isEnabled）：管理端可禁用某个工具或工作流；
 *     启用为默认态，只持久化「禁用项」覆盖（overrides），文件缺失/损坏 = 全部启用；
 *     每次启停写审计日志（management/audit.js）
 *  3. 查询（list / get）：给管理 REST API 与工作流引擎（System Prompt 动态生成、
 *     工具调用拦截）提供统一视图
 *  4. 运行统计（_stats）：resolveRunner 返回包装后的 run，自动记录调用次数 /
 *     累计耗时 / 失败次数 / 最近错误 —— 管理页健康度展示的数据来源
 *  5. 恢复默认（resetAll）：清空本命名空间的禁用覆盖（全部回到启用态）
 *
 * 持久化：server/data/management/registry.json
 *   { "tools": { "CommitToStore": false }, "workflows": { "doc-react": false } }
 *
 * 设计约束：register 是同步的（模块加载期执行），setEnabled 同步写文件
 * （管理操作低频，无需异步队列）；读文件失败静默回退全启用，不阻塞启动。
 * 统计为进程内存态（重启清零），不持久化 —— 展示「本次运行」的健康度即可。
 */

const log = childLogger('registry')

const REGISTRY_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management', 'registry.json')

/** 读取启停覆盖（tools/workflows 两个命名空间）；失败回退空对象 */
function loadOverrides() {
  try {
    if (!existsSync(REGISTRY_FILE)) return { tools: {}, workflows: {} }
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
    return {
      tools: raw?.tools && typeof raw.tools === 'object' ? raw.tools : {},
      workflows: raw?.workflows && typeof raw.workflows === 'object' ? raw.workflows : {},
    }
  } catch (err) {
    log.warn(`[registry] 读取 ${REGISTRY_FILE} 失败（${err.message}），全部按启用处理`)
    return { tools: {}, workflows: {} }
  }
}

const _overrides = loadOverrides()

function persistOverrides() {
  try {
    mkdirSync(dirname(REGISTRY_FILE), { recursive: true })
    writeFileSync(REGISTRY_FILE, JSON.stringify(_overrides, null, 2), 'utf8')
  } catch (err) {
    log.error(`[registry] 写入 ${REGISTRY_FILE} 失败：${err.message}（启停仅本次进程生效）`)
  }
}

class Registry {
  /** @param {'tools'|'workflows'} namespace 覆盖文件里的命名空间 */
  constructor(namespace) {
    this.namespace = namespace
    this.items = new Map()
    /** 运行统计（进程内存态，重启清零）：name → { calls, failures, totalMs, lastMs, lastUsedAt, lastError } */
    this._stats = new Map()
  }

  /**
   * 注册一项。同名重复注册视为更新（HMR/测试场景友好）。
   * dependsOn：声明本项依赖的其他注册项名（如工具依赖前置工具、工作流依赖全部工具），
   * 管理端据此计算 dependents 并在禁用时给出级联影响提示。
   * @param {{ name:string, label:string, description:string, category?:string, params?:string, dependsOn?:string[], meta?:object, run?:Function }} meta
   */
  register(meta) {
    const name = String(meta?.name || '').trim()
    if (!name) throw new Error(`[registry:${this.namespace}] 注册项缺少 name`)
    this.items.set(name, { dependsOn: [], ...meta, name })
    return this.get(name)
  }

  /** 完整元数据 + 运行时启用状态 + 运行统计快照；未注册返回 null */
  get(name) {
    const item = this.items.get(String(name || '').trim())
    if (!item) return null
    return { ...item, enabled: this.isEnabled(name), stats: this.getStats(item.name) }
  }

  /** 全量列表（含启用状态与统计），按注册顺序 */
  list() {
    return [...this.items.values()].map((item) => ({
      ...item,
      enabled: this.isEnabled(item.name),
      stats: this.getStats(item.name),
    }))
  }

  /** 只列启用项（工作流引擎用：System Prompt 生成 / 意图映射） */
  listEnabled() {
    return this.list().filter((x) => x.enabled)
  }

  isEnabled(name) {
    const item = this.items.get(String(name || '').trim())
    if (!item) return false
    return _overrides[this.namespace]?.[item.name] !== false
  }

  /** 统计快照（无调用记录返回零值对象，前端免判空） */
  getStats(name) {
    const key = String(name || '').trim()
    const s = this._stats.get(key)
    return {
      calls: s?.calls ?? 0,
      failures: s?.failures ?? 0,
      totalMs: s?.totalMs ?? 0,
      lastMs: s?.lastMs ?? null,
      lastUsedAt: s?.lastUsedAt ?? null,
      lastError: s?.lastError ?? null,
      avgMs: s?.calls ? Math.round(s.totalMs / s.calls) : null,
    }
  }

  /** 内部：记录一次调用结果 */
  _record(name, ms, err) {
    const key = String(name).trim()
    const s =
      this._stats.get(key) ?? { calls: 0, failures: 0, totalMs: 0, lastMs: null, lastUsedAt: null, lastError: null }
    s.calls += 1
    s.totalMs += ms
    s.lastMs = ms
    s.lastUsedAt = new Date().toISOString()
    if (err) {
      s.failures += 1
      s.lastError = String(err?.message || err)
    }
    this._stats.set(key, s)
  }

  /**
   * 运行体（工具专用）；未注册或已禁用返回 null，调用方需自行处理。
   * 返回的 run 已包埋点：自动统计调用次数 / 耗时 / 失败（不影响原行为与异常抛出）。
   */
  resolveRunner(name) {
    const item = this.items.get(String(name || '').trim())
    if (!item || typeof item.run !== 'function' || !this.isEnabled(item.name)) return null
    const orig = item.run
    const registry = this
    return async function instrumented(ctx, args, extra) {
      const t0 = performance.now()
      try {
        const result = await orig(ctx, args, extra)
        registry._record(item.name, Math.round(performance.now() - t0), null)
        return result
      } catch (err) {
        registry._record(item.name, Math.round(performance.now() - t0), err)
        throw err
      }
    }
  }

  /**
   * 设置启用状态（管理 API 调用）。写审计日志。
   * @returns {{ ok:boolean, error?:string, item?:object }}
   */
  setEnabled(name, enabled) {
    const item = this.items.get(String(name || '').trim())
    if (!item) return { ok: false, error: `未注册：${name}` }
    _overrides[this.namespace] ??= {}
    if (enabled) delete _overrides[this.namespace][item.name]
    else _overrides[this.namespace][item.name] = false
    persistOverrides()
    appendAudit(`${this.namespace}.${enabled ? 'enable' : 'disable'}`, { name: item.name, label: item.label })
    log.info(`[registry:${this.namespace}] ${enabled ? '启用' : '禁用'} ${item.name}（${item.label}）`)
    return { ok: true, item: this.get(item.name) }
  }

  /** 恢复默认：清空本命名空间的全部禁用覆盖（所有项回到启用态）。写审计日志。 */
  resetAll() {
    const removed = Object.keys(_overrides[this.namespace] ?? {})
    _overrides[this.namespace] = {}
    persistOverrides()
    appendAudit('registry.reset', { scope: this.namespace, removed })
    log.info(`[registry:${this.namespace}] 恢复默认（清空 ${removed.length} 个禁用项）`)
    return { ok: true, removed }
  }
}

/** 工具注册表：智能体可调用的工具（AnalyzeDocument / PreviewChunks / …） */
export const toolRegistry = new Registry('tools')

/** 工作流注册表：智能体执行引擎（doc-react / …） */
export const workflowRegistry = new Registry('workflows')
