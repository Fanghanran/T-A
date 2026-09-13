import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import Database from 'better-sqlite3'
import { childLogger } from '../logger.js'
import { LOCAL_USER_ID } from '../principal.js'

/**
 * audit —— 管理操作审计日志（L5，仅被 registry / manager 引用）
 *
 * 职责：把启停工具/工作流、修改调优参数、恢复默认等管理动作追加写入
 * SQLite 库 data/management/audit.db（audit_log 表），回答「谁在什么时候改了什么」。
 *
 * M5b：审计条目带 ownerId。身份通过 AsyncLocalStorage 在请求链路透传，
 * 由中间件注入 —— 调用点无需逐个改动。
 * AUTH_MODE=disabled 时恒为 local，与 M5a 零回归要求一致。
 *
 * 存储（2026-09-12 由 audit.jsonl 迁移为 SQLite）：
 *  - audit_log(id PK / ts / action / owner_id / detail JSON)；detail 存动作详情
 *    （name / from / to / scope / value …），读取时与公共列重组为原 entry 形状，
 *    对消费方（管理页审计视图）完全透明
 *  - 旧版 audit.jsonl 若存在：首载自动全量导入（表空才导，防重复），原文件改名 .migrated
 *
 * 审计开关（audit.enabled，默认开启）：
 *  - 系统管理页「操作审计」单行开关控制；关闭后 appendAudit 直接跳过（不写库）
 *  - 持久化 data/management/audit-state.json；文件缺失/损坏 = 开启
 *  - 开关自身的切换不写审计（关的时候不该再产生记录；开的时候记录也无意义）
 *
 * 设计约束：
 *  - append-only，不做轮转（管理操作低频，增长可忽略）
 *  - 写失败只告警不影响主操作（审计不能反过来阻塞管理动作）
 *  - listAudit 返回时间倒序（最新在前），limit 截断
 */

const log = childLogger('audit')

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management')
const AUDIT_FILE = join(DIR, 'audit.jsonl') // 旧版文件（仅迁移用）
const STATE_FILE = join(DIR, 'audit-state.json')
const DB_FILE = join(DIR, 'audit.db')

mkdirSync(DIR, { recursive: true })

const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    action   TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`)

const stmtInsert = db.prepare(
  'INSERT INTO audit_log (ts, action, owner_id, detail) VALUES (@ts, @action, @owner_id, @detail)',
)
const stmtList = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT @limit')
const stmtCount = db.prepare('SELECT COUNT(*) c FROM audit_log')

// ---------- 旧版 JSONL 一次性导入（表空才导；成功后原文件改名保留） ----------

function migrateLegacyJsonl() {
  try {
    if (!existsSync(AUDIT_FILE)) return
    if (stmtCount.get().c > 0) {
      // 库里已有数据（上次导入成功但改名失败）→ 只做改名收尾
      try { renameSync(AUDIT_FILE, `${AUDIT_FILE}.migrated`) } catch { /* ignore */ }
      return
    }
    const lines = readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
    const insertMany = db.transaction((rows) => {
      for (const e of rows) stmtInsert.run(e)
    })
    const rows = []
    for (const line of lines) {
      try {
        const raw = JSON.parse(line)
        const { ts, action, ownerId, ...rest } = raw ?? {}
        rows.push({
          ts: typeof ts === 'string' ? ts : new Date().toISOString(),
          action: String(action ?? 'unknown'),
          owner_id: String(ownerId ?? LOCAL_USER_ID),
          detail: JSON.stringify(rest ?? {}),
        })
      } catch {
        /* 跳过损坏行 */
      }
    }
    insertMany(rows)
    renameSync(AUDIT_FILE, `${AUDIT_FILE}.migrated`)
    log.info(`[audit] 旧版 audit.jsonl 已导入 SQLite：${rows.length} 条（原文件保留为 .migrated）`)
  } catch (err) {
    log.warn(`[audit] 旧版 JSONL 迁移失败（${err.message}），SQLite 从空库开始；原文件保留`)
  }
}
migrateLegacyJsonl()

const gracefulClose = () => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
  } catch {
    /* ignore */
  }
}
try {
  process.on('exit', gracefulClose)
  process.on('SIGINT', () => { gracefulClose(); process.exit(130) })
  process.on('SIGTERM', () => { gracefulClose(); process.exit(143) })
} catch {
  /* 非 Node 环境忽略 */
}

// ---------- 操作者上下文（M5b：审计带 userId） ----------

const actorStore = new AsyncLocalStorage()

/**
 * 在指定身份上下文中执行 fn —— 供 Express 中间件包裹后续链路，
 * 使链路中任意深度的 appendAudit 都能拿到当前操作者。
 * @param {{userId:string}|null} actor
 * @param {() => any} fn
 */
export function runWithActor(actor, fn) {
  return actorStore.run(actor ?? null, fn)
}

/** 当前链路的操作者；不在请求上下文中（如启动自愈）返回 null */
export function currentActor() {
  return actorStore.getStore() ?? null
}

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
 * @param {string} action 动作标识：tool.enable / tool.disable / workflow.enable / workflow.disable / tunable.set / tunable.reset / registry.reset / agent.create …
 * @param {object} detail 动作详情（name / from / to / scope / value …）
 */
export function appendAudit(action, detail = {}) {
  // 身份：显式传入的 detail.ownerId 优先，其次取链路上下文，最后回落 local。
  // 回落保证 disabled 模式与「系统内部调用」都有可解释的归属。
  const actor = currentActor()
  const ownerId = detail?.ownerId ?? actor?.userId ?? LOCAL_USER_ID
  const entry = { ts: new Date().toISOString(), action, ...detail, ownerId }
  if (!_enabled) return entry
  try {
    const { ts: _, action: __, ownerId: ___, ...rest } = entry
    stmtInsert.run({
      ts: entry.ts,
      action: entry.action,
      owner_id: ownerId,
      detail: JSON.stringify(rest ?? {}),
    })
  } catch (err) {
    log.warn(`[audit] 写入失败（${err.message}），本条记录丢失：${JSON.stringify(entry)}`)
  }
  return entry
}

/**
 * 读取最近的审计记录（时间倒序）。
 * @param {number} limit 最多返回条数（默认 50）
 * @returns {Array<object>} 与旧版 JSONL 条目形状一致：{ ts, action, ...detail, ownerId }
 */
export function listAudit(limit = 50) {
  try {
    const rows = stmtList.all({ limit: Math.max(1, Math.min(1000, Number(limit) || 50)) })
    return rows.map((r) => {
      let rest = {}
      try { rest = JSON.parse(r.detail) ?? {} } catch { /* 损坏 detail 按空处理 */ }
      return { ts: r.ts, action: r.action, ...rest, ownerId: r.owner_id }
    })
  } catch (err) {
    log.warn(`[audit] 读取失败（${err.message}）`)
    return []
  }
}

// ---------- 数据库目录浏览（数据库 → 审计库 · 只读，与 session/base 同形状） ----------

const BROWSE_META = { audit_log: { order: 10, desc: '管理操作审计（谁在什么时候改了什么）' } }

function browseUserTables() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
}

function describeTable(name) {
  if (!browseUserTables().includes(name)) return null
  const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all()
  const indexes = db.prepare(`PRAGMA index_list(${JSON.stringify(name)})`).all().map((i) => i.name)
  return { columns: columns.map((c) => c.name), indexes }
}

/** 表清单（供「数据库 → 审计库 · 数据结构」） */
export function browseTables() {
  const names = browseUserTables().sort((a, b) => {
    const oa = BROWSE_META[a]?.order ?? 50
    const ob = BROWSE_META[b]?.order ?? 50
    return oa - ob || a.localeCompare(b)
  })
  const items = []
  for (const name of names) {
    try {
      const d = describeTable(name)
      if (!d) continue
      const rowCount = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(name)}`).get()?.n ?? 0
      items.push({
        name,
        kind: 'sqlite',
        desc: BROWSE_META[name]?.desc ?? '',
        rowCount,
        columns: d.columns,
        indexes: d.indexes,
      })
    } catch (err) {
      log.warn(`[audit] 浏览表 ${name} 失败（${err.message}），已跳过`)
    }
  }
  return { file: DB_FILE, writable: true, items }
}

/**
 * 分页读取某表的行（按 id 倒序=最新在前），供「数据库 → 审计库 · 数据明细」。
 * 表名经 sqlite_master 存在性校验后以双引号转义拼接，杜绝注入。
 */
export function browseRows(name, limit = 200, offset = 0) {
  const t = String(name ?? '')
  if (!browseUserTables().includes(t)) throw new Error(`未知表：${t}`)
  const columns = describeTable(t)?.columns ?? []
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t)}`).get()?.n ?? 0
  const rows = db
    .prepare(`SELECT * FROM ${JSON.stringify(t)} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(Math.max(1, Math.min(500, Number(limit) || 200)), Math.max(0, Number(offset) || 0))
  return { name: t, kind: 'sqlite', columns, total, rows }
}
