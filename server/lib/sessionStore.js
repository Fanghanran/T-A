import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { childLogger } from './logger.js'

const log = childLogger('sessionStore')

/**
 * sessionStore —— 会话 + 历史消息持久化（SQLite，better-sqlite3 同步 API）
 *
 * 设计目标（取代旧 JSON 文件方案）：
 *  - 单文件持久化（sessions.db），备份/迁移方便
 *  - ACID 事务，并发写不丢数据；同步 API 避免异步地狱
 *  - sessions / messages / annotations 分表存储，annotations 按需 JOIN，
 *    列表页只查 sessions 表，消息主体保持轻量
 *  - 启动自动迁移旧 JSON 文件（index.json + messages/*.json），
 *    迁移后保留原文件作为备份，新写入只走 SQLite
 *
 * 目录结构：
 *   server/data/sessions/
 *     ├── sessions.db            # SQLite 主库
 *     ├── sessions.db-wal        # WAL 日志（自动维护）
 *     ├── sessions.db-shm        # 共享内存（自动维护）
 *     ├── index.json            # 旧版 JSON（迁移后保留作备份，不再写入）
 *     └── messages/              # 旧版消息文件（迁移后保留作备份）
 *         └── ${sessionId}.json
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'sessions')
// 可用 SESSIONS_DB_FILE 覆盖。
// 提供这个开关的原因：WAL 一旦膨胀到无法 checkpoint 的状态（强杀进程 + 自动检查点
// 阈值过高），SQLite 会把库判为只读，此后任何写入都报
// "attempt to write a readonly database"，而原文件在本环境又删不掉/改不了名。
// 这时可以用 `VACUUM INTO` 生成干净副本，再通过此变量切换过去。
const DB_FILE = (process.env.SESSIONS_DB_FILE ?? '').trim()
  ? path.resolve(process.cwd(), process.env.SESSIONS_DB_FILE.trim())
  : path.join(DATA_DIR, 'sessions.db')
const INDEX_FILE = path.join(DATA_DIR, 'index.json')
const MESSAGES_DIR = path.join(DATA_DIR, 'messages')

// ============ 文件系统工具（仅迁移时用） ============
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (err) {
    log.warn(
      `[sessionStore] 读取旧 JSON 文件失败，跳过该文件 (${path.basename(file)}): ${err.message}`,
    )
    try { fs.renameSync(file, `${file}.corrupt.${Date.now()}`) } catch { /* ignore */ }
    return fallback
  }
}

ensureDir()

// ============ DB 初始化 ============
// 可写模式优先；打不开（目录无写权限 / WAL 损坏被 SQLite 保护性降级为只读）时
// 退化为只读连接 —— 历史数据仍可查，服务照常提供检索与问答，只是会话不落盘。
// 此前这里直接抛异常，导致整个后端起不来，属于过度脆弱。
let db
let dbWritable = false
try {
  db = new Database(DB_FILE)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  dbWritable = true
} catch (err) {
  log.error(
    { details: err.message, file: DB_FILE },
    '[sessionStore] 数据库无法以可写方式打开，降级为只读（会话将不持久化）',
  )
  try {
    db = new Database(DB_FILE, { readonly: true })
    db.pragma('foreign_keys = ON')
  } catch (err2) {
    log.error({ details: err2.message }, '[sessionStore] 数据库完全不可用，会话功能关闭')
    db = null
  }
}

/** 数据库是否可写。上层可据此提示用户「会话不会被保存」。 */
export function isWritable() {
  return dbWritable && !!db
}

// WAL 自动检查点阈值：默认 1000 页（约 4MB）才触发，本项目数据量小，WAL 长期够不到
// 这个阈值。叠加进程被强杀（taskkill /F）时 db.close() 不执行、检查点不做，WAL 会
// 持续膨胀 —— 实测堆积到 902KB，导致下次启动重放耗时 20s+。
// 设为 256 页（约 1MB）并启动时主动做一次，让 WAL 常态保持精简。
// 注意：只读连接下这条 pragma 会抛 SQLITE_READONLY，必须跳过。
if (dbWritable && db) {
  try {
    db.pragma('wal_autocheckpoint = 256')
  } catch (err) {
    log.warn({ details: err.message }, '[sessionStore] 设置 wal_autocheckpoint 失败，已忽略')
  }
}

/**
 * 主动执行 WAL 检查点，把 WAL 内容合并回主库。
 * 任何失败都只 warn 不抛 —— 检查点失败不该影响服务可用性。
 * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode]
 */
export function checkpointWal(mode = 'PASSIVE') {
  if (!db) return null
  try {
    const r = db.pragma(`wal_checkpoint(${mode})`)
    return Array.isArray(r) ? r[0] : r
  } catch (err) {
    // 目录不可写 / 有其它连接占用时会失败，属可接受的降级
    log.warn({ details: err.message }, `[sessionStore] WAL 检查点失败（${mode}），已忽略`)
    return null
  }
}

if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      agentName TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS annotations (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
  `)
}

const prepare = (sql) => db
  ? db.prepare(sql)
  : {
      get: () => undefined,
      all: () => [],
      run: () => { throw Object.assign(new Error('会话数据库不可用'), { code: 'SESSION_DB_UNAVAILABLE', statusCode: 503 }) },
    }
const requireWritable = () => {
  if (!isWritable()) throw Object.assign(new Error('会话数据库为只读或不可用，无法写入'), { code: 'SESSION_DB_READONLY', statusCode: 503 })
}
const stmtSessionCount = prepare('SELECT COUNT(*) AS c FROM sessions')
const stmtMessageCountAll = prepare('SELECT COUNT(*) AS c FROM messages')
const stmtGetSeq = prepare('SELECT value FROM meta WHERE key = ?')
const stmtSetSeq = prepare(
  'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
)
const stmtListSessionsAll = prepare(`
  SELECT s.id AS id, s.title AS title, s.agentName AS agentName,
         s.created_at AS createdAt, s.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
  FROM sessions s
  ORDER BY s.updated_at DESC
`)
const stmtListSessionsByAgent = prepare(`
  SELECT s.id AS id, s.title AS title, s.agentName AS agentName,
         s.created_at AS createdAt, s.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
  FROM sessions s
  WHERE s.agentName = ?
  ORDER BY s.updated_at DESC
`)
const stmtSessionExists = prepare('SELECT 1 FROM sessions WHERE id = ?')
const stmtGetSession = prepare(`
  SELECT s.id AS id, s.title AS title, s.agentName AS agentName,
         s.created_at AS createdAt, s.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
  FROM sessions s
  WHERE s.id = ?
`)
const stmtGetMessages = prepare(`
  SELECT m.id AS id, m.role AS role, m.content AS content, m.created_at AS createdAt,
         a.data AS annotationsJson
  FROM messages m
  LEFT JOIN annotations a ON a.message_id = m.id
  WHERE m.session_id = ?
  ORDER BY m.created_at ASC, m.rowid ASC
`)
const stmtInsertSession = prepare(
  `INSERT INTO sessions(id, title, agentName, created_at, updated_at) VALUES(?, ?, ?, ?, ?)`,
)
const stmtInsertMessage = prepare(
  `INSERT INTO messages(id, session_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)`,
)
const stmtInsertAnnotation = prepare(
  `INSERT INTO annotations(message_id, data) VALUES(?, ?)`,
)
const stmtUpdateSessionOnAppend = prepare(
  `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
)
const stmtUpdateSessionTitle = prepare(
  `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
)
const stmtDeleteSession = prepare(`DELETE FROM sessions WHERE id = ?`)

// ============ 序号管理（meta 表存单调递增计数，等价于旧 index.json 的 sessSeq/msgSeq） ============
function getSeq(name) {
  const row = stmtGetSeq.get(`${name}_seq`)
  return row ? Number(row.value) || 0 : 0
}
function setSeq(name, val) {
  stmtSetSeq.run(`${name}_seq`, String(val))
}

let sessSeq = 0
let msgSeq = 0
let _loaded = false

// ============ 从旧 JSON 迁移（仅当 DB 为空且存在旧 index.json 时执行） ============
function migrateFromJsonIfNeeded() {
  try {
    const existing = stmtSessionCount.get().c
    if (existing > 0) return false  // DB 已有数据，跳过迁移

    if (!fs.existsSync(INDEX_FILE)) return false  // 无 JSON 可迁移

    const idx = readJsonSafe(INDEX_FILE, { sessSeq: 0, msgSeq: 0, sessions: [] })
    if (!Array.isArray(idx.sessions) || idx.sessions.length === 0) {
      // 旧 index 为空，但仍记录了 seq，把它同步到 meta
      setSeq('sess', Number(idx.sessSeq) || 0)
      setSeq('msg', Number(idx.msgSeq) || 0)
      return false
    }

    log.info(
      `[sessionStore] 检测到旧 JSON 数据，开始迁移到 SQLite（${idx.sessions.length} 个会话）...`,
    )
    const migrateTx = db.transaction(() => {
      for (const s of idx.sessions) {
        stmtInsertSession.run(
          s.id,
          s.title ?? '',
          s.agentName ?? '',
          s.createdAt ?? new Date().toISOString(),
          s.updatedAt ?? new Date().toISOString(),
        )
        const msgFile = path.join(MESSAGES_DIR, `${s.id}.json`)
        const msgs = readJsonSafe(msgFile, [])
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            stmtInsertMessage.run(
              m.id,
              s.id,
              m.role === 'assistant' ? 'assistant' : 'user',
              typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
              m.createdAt ?? new Date().toISOString(),
            )
            if (Array.isArray(m.annotations) && m.annotations.length) {
              stmtInsertAnnotation.run(m.id, JSON.stringify(m.annotations))
            }
          }
        }
      }
      setSeq('sess', Number(idx.sessSeq) || 0)
      setSeq('msg', Number(idx.msgSeq) || 0)
    })
    migrateTx()
    log.info(`[sessionStore] JSON → SQLite 迁移完成（旧文件保留作备份）`)
    return true
  } catch (err) {
    // 迁移失败：事务回滚，DB 保持空；下次启动会重试。旧 JSON 文件未改动。
    log.error(
      `[sessionStore] JSON 迁移失败，将以空 SQLite 启动（旧文件未改动）：${err.message}`,
    )
    return false
  }
}

// ============ 启动加载 ============
export function load() {
  if (_loaded) return stats()
  if (!db) return { totalSessions: 0, totalMessages: 0 }
  // 启动时先把历史 WAL 合并回主库：若上次是强杀退出，WAL 可能已堆积几百 KB，
  // 不清理的话每次启动都要重放（实测 20s+）
  checkpointWal('TRUNCATE')
  migrateFromJsonIfNeeded()
  sessSeq = getSeq('sess')
  msgSeq = getSeq('msg')
  _loaded = true
  const s = stats()
  log.info(
    `[sessionStore] 已加载 SQLite：${s.totalSessions} 个会话，${s.totalMessages} 条消息（DB：${DB_FILE}）`,
  )
  return s
}

export function stats() {
  return {
    totalSessions: db ? stmtSessionCount.get().c : 0,
    totalMessages: db ? stmtMessageCountAll.get().c : 0,
  }
}

/**
 * 同步刷盘：SQLite 事务自带 ACID，此处仅做 WAL checkpoint 以释放 WAL 文件。
 * 保留导出是为了兼容 index.js 可能的显式调用与进程退出钩子。
 */
export function flushSync() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* 非 WAL 模式或无 WAL 文件时忽略 */
  }
}

// ============ 对外 API（签名与 JSON 版本完全一致） ============

/**
 * 列出会话（按 updatedAt 倒序，可选 agentName 过滤）
 * @param {{agentName?:string}} opts
 */
export function listSessions({ agentName } = {}) {
  const rows = agentName ? stmtListSessionsByAgent.all(agentName) : stmtListSessionsAll.all()
  return rows.map((r) => ({ ...r }))
}

/** 会话是否存在 */
export function sessionExists(id) {
  return !!stmtSessionExists.get(id)
}

/** 获取会话元数据（不存在返回 null） */
export function getSession(id) {
  const r = stmtGetSession.get(id)
  return r ? { ...r } : null
}

/** 获取会话消息（浅拷贝；annotations 通过 LEFT JOIN 一并取回并 parse） */
export function getMessages(id) {
  const rows = stmtGetMessages.all(id)
  return rows.map((r) => {
    const m = { id: r.id, role: r.role, content: r.content, createdAt: r.createdAt }
    if (r.annotationsJson != null && r.annotationsJson !== '') {
      try { m.annotations = JSON.parse(r.annotationsJson) } catch { /* 损坏的 annotations 忽略 */ }
    }
    return m
  })
}

/**
 * 创建会话
 * @param {{agentName:string, title?:string}} opts
 * @returns {SessionMeta}
 */
export function createSession({ agentName, title }) {
  requireWritable()
  const id = `sess_${++sessSeq}`
  const now = new Date().toISOString()
  const safeTitle = typeof title === 'string' && title.trim()
    ? title.trim().slice(0, 100)
    : '新对话'
  const meta = {
    id,
    title: safeTitle,
    agentName: String(agentName ?? ''),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }
  // 只读模式：仍然返回可用的会话对象，只是不落盘。
  // 这样前端能正常开始对话（检索/问答不受影响），代价是刷新后会话丢失。
  if (!isWritable()) {
    log.warn('[sessionStore] 数据库只读，会话仅存在于内存：' + id)
    return { ...meta, _ephemeral: true }
  }
  const tx = db.transaction(() => {
    stmtInsertSession.run(id, safeTitle, meta.agentName, now, now)
    setSeq('sess', sessSeq)
  })
  tx()
  return { ...meta }
}

/**
 * 重命名会话
 * @param {string} id
 * @param {string} newTitle
 * @returns {SessionMeta|null}
 */
export function renameSession(id, newTitle) {
  requireWritable()
  const existing = stmtGetSession.get(id)
  if (!existing) return null
  const safe = typeof newTitle === 'string' && newTitle.trim()
    ? newTitle.trim().slice(0, 100)
    : existing.title
  const now = new Date().toISOString()
  stmtUpdateSessionTitle.run(safe, now, id)
  return { ...existing, title: safe, updatedAt: now }
}

/**
 * 删除会话（元数据 + 消息 + annotations，外键 CASCADE 自动级联）
 * @param {string} id
 * @returns {boolean}
 */
export function deleteSession(id) {
  requireWritable()
  const info = stmtDeleteSession.run(id)
  return info.changes > 0
}

/**
 * 追加一条消息到会话（会自动 touch updatedAt + messageCount，首条 user 自动取标题）
 *
 * @param {string} sessionId
 * @param {{role:'user'|'assistant'|'system', content:string, annotations?:any[]}} msg
 * @returns {{id:string, role:string, content:string, createdAt:string, annotations?:any[]}|null}
 */
export function appendMessage(sessionId, msg) {
  requireWritable()
  const meta = stmtGetSession.get(sessionId)
  if (!meta) return null
  const id = `msg_${++msgSeq}`
  const now = new Date().toISOString()
  const role = msg.role === 'assistant' ? 'assistant' : 'user'
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')

  // 首次用户消息 → 自动用前 40 字符做标题（避免一直显示"新对话"）
  let newTitle = meta.title
  if (role === 'user' && (!meta.title || meta.title === '新对话')) {
    const text = content.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (text) newTitle = text
  }

  const row = { id, role, content, createdAt: now }
  if (Array.isArray(msg.annotations) && msg.annotations.length) {
    row.annotations = msg.annotations
  }

  // 只读模式：消息不落盘，但仍返回完整对象，保证本轮对话与流式响应正常
  if (!isWritable()) {
    log.debug(`[sessionStore] 数据库只读，消息未持久化：${id}`)
    return { ...row, _ephemeral: true }
  }

  const tx = db.transaction(() => {
    stmtInsertMessage.run(id, sessionId, role, content, now)
    if (row.annotations) {
      stmtInsertAnnotation.run(id, JSON.stringify(msg.annotations))
    }
    stmtUpdateSessionOnAppend.run(newTitle, now, sessionId)
    setSeq('msg', msgSeq)
  })
  tx()

  return { ...row }
}

/**
 * 获取会话的"上下文窗口"历史消息（用于 LLM prompt 拼历史）。
 *
 * 策略：最近 N 轮（每轮 = user + assistant 一对），总字符数做兜底裁剪，
 *       避免 prompt 爆 token。最后一条一定是刚发的 user 消息。
 *
 * @param {string} sessionId
 * @param {{maxTurns?:number, maxChars?:number}} [opts]
 * @returns {Array<{role:'user'|'assistant', content:string}>}
 */
export function getContextWindow(sessionId, opts = {}) {
  const maxTurns = Math.max(1, Number(opts.maxTurns) || 6)
  const maxChars = Math.max(500, Number(opts.maxChars) || 6000)

  const rows = stmtGetMessages.all(sessionId)
  // 倒着找：最多 maxTurns 轮（= 最多 maxTurns*2 条消息）
  let userCount = 0
  let i = rows.length - 1
  for (; i >= 0 && userCount < maxTurns; i--) {
    if (rows[i].role === 'user') userCount++
  }
  // i 停在"窗口起始位置的前一个"
  const slice = rows.slice(i + 1)
  // 字符裁剪：从尾往回截，保证最后一条 user 完整
  let chars = 0
  let startIdx = slice.length - 1
  for (; startIdx >= 0; startIdx--) {
    const c = slice[startIdx].content
    chars += typeof c === 'string' ? c.length : 0
    if (chars > maxChars && startIdx < slice.length - 1) {
      startIdx++ // 保留刚超限的这条（因为它是倒数第二条之后的，需要能带上最后 user）
      break
    }
  }
  if (startIdx < 0) startIdx = 0
  const window = slice.slice(startIdx).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
  }))
  // 保证窗口首条是 user（否则前面半截 assistant 上下文对不齐）
  while (window.length && window[0].role !== 'user') window.shift()
  return window
}

// 模块加载即同步加载（SQLite 同步打开 + 迁移，与 vectorStore 的异步 Promise 口径区分开）
try {
  load()
} catch (err) {
  log.error({ details: err.message }, '[sessionStore] 启动加载失败')
}

// 进程退出前关闭 DB（better-sqlite3 close 会自动 flush WAL）
try {
  // 优雅退出：先做检查点再关库，避免 WAL 残留膨胀
  const gracefulClose = () => {
    try { checkpointWal('TRUNCATE') } catch { /* ignore */ }
    try { db.close() } catch { /* ignore */ }
  }
  process.on('exit', gracefulClose)
  process.on('SIGINT', () => { gracefulClose(); process.exit(130) })
  process.on('SIGTERM', () => { gracefulClose(); process.exit(143) })
} catch {
  /* 非 Node 环境忽略 */
}
