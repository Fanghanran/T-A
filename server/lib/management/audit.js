import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from '../logger.js'

/**
 * audit —— 管理操作审计日志（L5，仅被 registry / manager 引用）
 *
 * 职责：把启停工具/工作流、修改调优参数、恢复默认等管理动作追加写入
 * data/management/audit.jsonl（每行一条 JSON），回答「谁在什么时候改了什么」。
 *
 * 审计开关（audit.enabled，默认开启）：
 *  - 系统管理页「操作审计」单行开关控制；关闭后 appendAudit 直接跳过（不写文件）
 *  - 持久化 data/management/audit-state.json；文件缺失/损坏 = 开启
 *  - 开关自身的切换不写审计（关的时候不该再产生记录；开的时候记录也无意义）
 *
 * 设计约束：
 *  - append-only，不做轮转（管理操作低频，文件增长可忽略）
 *  - 写失败只告警不影响主操作（审计不能反过来阻塞管理动作）
 *  - listAudit 返回时间倒序（最新在前），limit 截断
 */

const log = childLogger('audit')

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management')
const AUDIT_FILE = join(DIR, 'audit.jsonl')
const STATE_FILE = join(DIR, 'audit-state.json')

// ---------- 启用状态（模块级缓存 + 文件持久化） ----------

let _enabled = loadEnabled()

function loadEnabled() {
  try {
    if (!existsSync(STATE_FILE)) return true
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return raw?.enabled !== false // 缺省 = 开启
  } catch {
    return true
  }
}

/** 审计是否启用（禁用时 appendAudit 跳过写入） */
export function isAuditEnabled() {
  return _enabled
}

/**
 * 设置审计开关（系统管理页调用）。持久化，立即生效。
 * @param {boolean} enabled
 * @returns {{ ok:boolean, error?:string, enabled?:boolean }}
 */
export function setAuditEnabled(enabled) {
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须为 boolean' }
  _enabled = enabled
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ enabled }, null, 2), 'utf8')
  } catch (err) {
    log.warn(`[audit] 状态写入失败（${err.message}），开关仅本次进程生效：enabled=${enabled}`)
  }
  log.info(`[audit] 审计${enabled ? '启用' : '禁用'}`)
  return { ok: true, enabled }
}

// ---------- 记录与查询 ----------

/**
 * 追加一条审计记录（审计被禁用时跳过）。
 * @param {string} action 动作标识：tool.enable / tool.disable / workflow.enable / workflow.disable / tunable.set / tunable.reset / registry.reset
 * @param {object} detail 动作详情（name / from / to / scope / value …）
 */
export function appendAudit(action, detail = {}) {
  const entry = { ts: new Date().toISOString(), action, ...detail }
  if (!_enabled) return entry
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    log.warn(`[audit] 写入失败（${err.message}），本条记录丢失：${JSON.stringify(entry)}`)
  }
  return entry
}

/**
 * 读取最近的审计记录（时间倒序）。
 * @param {number} limit 最多返回条数（默认 50）
 * @returns {Array<object>}
 */
export function listAudit(limit = 50) {
  try {
    if (!existsSync(AUDIT_FILE)) return []
    const lines = readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
    const items = []
    for (const line of lines.reverse()) {
      try {
        items.push(JSON.parse(line))
      } catch {
        /* 跳过损坏行 */
      }
      if (items.length >= limit) break
    }
    return items
  } catch (err) {
    log.warn(`[audit] 读取失败（${err.message}）`)
    return []
  }
}
