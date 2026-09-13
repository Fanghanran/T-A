import { childLogger } from './logger.js'

/**
 * sqliteBrowse —— 数据库目录「表结构 + 行明细」只读浏览的通用实现
 *
 * 从 sessionStore 的 browseTables/browseRows 模式抽象而来，供多个 SQLite 库复用
 * （会话库留在 sessionStore 原实现不动；基础库 accounts.db 等接入本模块）。
 *
 * 特性与会话库浏览一致：
 *   - sqlite_master 动态枚举用户表（排除 sqlite_% 内部表），新表自动出现
 *   - TABLE_META 只提供说明文案与排序优先级，不是白名单
 *   - 表名经 sqlite_master 存在性校验后以 JSON.stringify（双引号标识符）转义，杜绝注入
 *   - rowTransform 可选钩子：行级脱敏（如 users 表的 password_hash/salt）
 */

const log = childLogger('sqlite-browse')

/**
 * @param {object} p
 * @param {import('better-sqlite3').Database} p.db 已打开的 better-sqlite3 连接
 * @param {string} p.file 库文件路径（前端展示用）
 * @param {() => boolean} [p.isWritable] 库可写状态（默认按连接推断，返回 true）
 * @param {Record<string, {desc:string, order?:number}>} [p.tableMeta] 已知表说明与排序
 * @param {string} [p.label] 日志前缀（默认 sqlite-browse）
 * @param {(name: string, row: object) => object} [p.rowTransform] 行级变换（脱敏等）
 */
export function makeSqliteBrowser({ db, file, isWritable, tableMeta = {}, label = 'sqlite-browse', rowTransform }) {
  if (!db) {
    return {
      browseTables: () => ({ file, writable: false, items: [] }),
      browseRows: () => {
        throw new Error(`${label} 数据库不可用`)
      },
    }
  }

  function listUserTables() {
    try {
      return db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
    } catch (err) {
      log.warn(`[${label}] 枚举用户表失败（${err.message}）`)
      return []
    }
  }

  function describeTable(name) {
    const columns = db
      .pragma(`table_info(${JSON.stringify(name)})`)
      .map((c) => ({ name: c.name, type: c.type || '', pk: !!c.pk, notnull: !!c.notnull }))
    if (!columns.length) return null
    let indexes = []
    try {
      indexes = db
        .pragma(`index_list(${JSON.stringify(name)})`)
        .filter((ix) => !ix.origin || ix.origin === 'c')
        .map((ix) => ({
          name: ix.name,
          unique: !!ix.unique,
          columns: db.pragma(`index_info(${JSON.stringify(ix.name)})`).map((c) => c.name),
        }))
    } catch {
      /* 索引信息缺失不阻塞结构展示 */
    }
    return { columns, indexes }
  }

  function browseTables() {
    const names = listUserTables().sort((a, b) => {
      const oa = tableMeta[a]?.order ?? 50
      const ob = tableMeta[b]?.order ?? 50
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
          desc: tableMeta[name]?.desc ?? '',
          rowCount,
          columns: d.columns,
          indexes: d.indexes,
        })
      } catch (err) {
        log.warn(`[${label}] 浏览表 ${name} 失败（${err.message}），已跳过`)
      }
    }
    return { file, writable: isWritable ? isWritable() : true, items }
  }

  function browseRows(name, limit = 200, offset = 0) {
    const t = String(name ?? '')
    const exists = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(t)
    if (!exists) throw new Error(`未知表：${t}`)
    const safe = JSON.stringify(t) // 双引号 SQL 标识符转义
    const columns = db.pragma(`table_info(${safe})`).map((c) => c.name)
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${safe}`).get()?.n ?? 0
    let rows = db
      .prepare(`SELECT * FROM ${safe} ORDER BY rowid LIMIT ? OFFSET ?`)
      .all(Math.min(500, Math.max(1, limit | 0)), Math.max(0, offset | 0))
    if (rowTransform) rows = rows.map((r) => rowTransform(t, r))
    return { name: t, kind: 'sqlite', desc: tableMeta[t]?.desc ?? '', columns, total, rows }
  }

  return { browseTables, browseRows }
}

/**
 * 通用敏感列脱敏：命中 SENSITIVE_RE 的列值替换为固定掩码（保留长度信息）。
 * 供用户表（password_hash/salt 等）等基础库敏感字段在数据明细中隐藏。
 */
const SENSITIVE_RE = /pass|salt|secret|token|hash/i
export function maskSensitiveRow(_name, row) {
  const out = { ...row }
  for (const k of Object.keys(out)) {
    if (SENSITIVE_RE.test(k) && out[k] != null && out[k] !== '') out[k] = '••••••'
  }
  return out
}
