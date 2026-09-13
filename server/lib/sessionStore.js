import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { childLogger } from './logger.js'
import { ServiceUnavailableError } from './errors.js'

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
    CREATE TABLE IF NOT EXISTS session_memory (
      session_id TEXT PRIMARY KEY,
      summary TEXT,
      summary_until_seq INTEGER,
      extract_until_seq INTEGER,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reflection_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      question TEXT,
      score INTEGER,
      action TEXT,
      issues TEXT,
      top1_score REAL,
      citations INTEGER,
      answer_chars INTEGER,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
  `)
  // M5a（ADR-008）：幂等 schema 迁移。owner_id 过滤是越权防线，
  // 存量数据一律归属 local 单一用户，disabled 模式下行为与历史完全一致。
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  const currentVersion = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0
  if (currentVersion < 1) {
    const cols = db.pragma('table_info(sessions)').map((c) => c.name)
    const tx = db.transaction(() => {
      if (!cols.includes('owner_id')) {
        db.exec("ALTER TABLE sessions ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local'")
        log.info('[sessionStore] schema v1：sessions 增加 owner_id（存量数据归属 local）')
      }
      db.prepare('INSERT OR REPLACE INTO schema_version(version, applied_at) VALUES(1, ?)')
        .run(new Date().toISOString())
    })
    tx()
  }
  if (currentVersion < 2) {
    // v2（隔离加固）：① owner 过滤 + 排序走复合索引；② session_memory / reflection_log
    // 重建并挂外键级联——旧表无外键，删除会话后靠应用层记得清理（漏删即孤儿）；
    // ③ 清理指向已删除会话的孤儿行。数据操作前已备份会话库。
    const snapshot = {
      sessions: db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c,
      messages: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
      memory: db.prepare('SELECT COUNT(*) AS c FROM session_memory').get().c,
      reflection: db.prepare('SELECT COUNT(*) AS c FROM reflection_log').get().c,
    }
    const tx = db.transaction(() => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_owner_updated ON sessions(owner_id, updated_at)')
      // 孤儿清理：外键重建前先移除指向已删除会话的行（FK 开启状态下无法通过插入检查）
      db.exec('DELETE FROM session_memory WHERE session_id NOT IN (SELECT id FROM sessions)')
      db.exec('DELETE FROM reflection_log WHERE session_id NOT IN (SELECT id FROM sessions)')
      db.exec(`CREATE TABLE session_memory_v2 (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        summary TEXT,
        summary_until_seq INTEGER,
        extract_until_seq INTEGER,
        updated_at TEXT
      )`)
      db.exec('INSERT INTO session_memory_v2 SELECT session_id, summary, summary_until_seq, extract_until_seq, updated_at FROM session_memory')
      db.exec('DROP TABLE session_memory')
      db.exec('ALTER TABLE session_memory_v2 RENAME TO session_memory')
      db.exec(`CREATE TABLE reflection_log_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        question TEXT,
        score INTEGER,
        action TEXT,
        issues TEXT,
        top1_score REAL,
        citations INTEGER,
        answer_chars INTEGER,
        created_at TEXT
      )`)
      db.exec('INSERT INTO reflection_log_v2 SELECT id, session_id, question, score, action, issues, top1_score, citations, answer_chars, created_at FROM reflection_log')
      db.exec('DROP TABLE reflection_log')
      db.exec('ALTER TABLE reflection_log_v2 RENAME TO reflection_log')
      // 反思表索引必须在重建之后建——建在旧表上会随 DROP 一起消失（实测踩坑）
      db.exec('CREATE INDEX IF NOT EXISTS idx_reflection_session ON reflection_log(session_id)')
      db.prepare('INSERT OR REPLACE INTO schema_version(version, applied_at) VALUES(2, ?)')
        .run(new Date().toISOString())
    })
    tx()
    const after = {
      sessions: db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c,
      messages: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
      memory: db.prepare('SELECT COUNT(*) AS c FROM session_memory').get().c,
      reflection: db.prepare('SELECT COUNT(*) AS c FROM reflection_log').get().c,
    }
    log.info(
      { before: snapshot, after },
      '[sessionStore] schema v2：owner 复合索引 + 摘要/反思表外键级联（孤儿行已清理）',
    )
  }
}

const prepare = (sql) => db
  ? db.prepare(sql)
  : {
      get: () => undefined,
      all: () => [],
      run: () => { throw Object.assign(new Error('会话数据库不可用'), { code: 'SESSION_DB_UNAVAILABLE', statusCode: 503 }) },
    }
const requireWritable = () => {
  // Fail-Fast（ADR-009）：只读/不可用一律显式 503，禁止"内存假会话"静默不落盘
  if (!db) {
    throw new ServiceUnavailableError('会话数据库不可用，会话功能关闭', 'SESSION_DB_UNAVAILABLE')
  }
  if (!dbWritable) {
    throw new ServiceUnavailableError(
      '会话数据库为只读，无法写入（历史会话仍可查看）。请检查文件权限后重启后端。',
      'SESSION_DB_READONLY',
    )
  }
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
  WHERE s.owner_id = ?
  ORDER BY s.updated_at DESC
`)
const stmtListSessionsByAgent = prepare(`
  SELECT s.id AS id, s.title AS title, s.agentName AS agentName,
         s.created_at AS createdAt, s.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
  FROM sessions s
  WHERE s.agentName = ? AND s.owner_id = ?
  ORDER BY s.updated_at DESC
`)
const stmtSessionExists = prepare('SELECT 1 FROM sessions WHERE id = ? AND owner_id = ?')
const stmtGetSession = prepare(`
  SELECT s.id AS id, s.title AS title, s.agentName AS agentName,
         s.created_at AS createdAt, s.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
  FROM sessions s
  WHERE s.id = ? AND s.owner_id = ?
`)
const stmtGetMessages = prepare(`
  SELECT m.id AS id, m.role AS role, m.content AS content, m.created_at AS createdAt,
         a.data AS annotationsJson
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  LEFT JOIN annotations a ON a.message_id = m.id
  WHERE m.session_id = ? AND s.owner_id = ?
  ORDER BY m.created_at ASC, m.rowid ASC
`)
const stmtInsertSession = prepare(
  `INSERT INTO sessions(id, title, agentName, owner_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)`,
)
const stmtInsertMessage = prepare(
  `INSERT INTO messages(id, session_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)`,
)
const stmtInsertAnnotation = prepare(
  `INSERT INTO annotations(message_id, data) VALUES(?, ?)`,
)
const stmtUpdateSessionOnAppend = prepare(
  `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
)
const stmtUpdateSessionTitle = prepare(
  `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
)
const stmtDeleteSession = prepare(`DELETE FROM sessions WHERE id = ? AND owner_id = ?`)

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
          'local',
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
export function listSessions({ agentName, ownerId } = {}) {
  if (!ownerId) throw new Error('listSessions 需要 ownerId（越权防护）')
  const rows = agentName
    ? stmtListSessionsByAgent.all(agentName, ownerId)
    : stmtListSessionsAll.all(ownerId)
  return rows.map((r) => ({ ...r }))
}

/** 会话是否存在 */
export function sessionExists(id, ownerId) {
  return !!stmtSessionExists.get(id, ownerId)
}

/** 获取会话元数据（不存在返回 null） */
export function getSession(id, ownerId) {
  if (!ownerId) throw new Error('getSession 需要 ownerId（越权防护）')
  const r = stmtGetSession.get(id, ownerId)
  return r ? { ...r } : null
}

/** 获取会话消息（浅拷贝；annotations 通过 LEFT JOIN 一并取回并 parse） */
/* ---------- 会话记忆状态（M2：滚动摘要 / 事实提炼游标，ADR-007） ---------- */

const stmtGetMemoryState = prepare('SELECT summary, summary_until_seq, extract_until_seq FROM session_memory WHERE session_id = ?')
const stmtDeleteMemoryState = prepare('DELETE FROM session_memory WHERE session_id = ?')
const stmtUpsertMemoryState = prepare(`
  INSERT INTO session_memory(session_id, summary, summary_until_seq, extract_until_seq, updated_at)
  VALUES(?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    summary = excluded.summary,
    summary_until_seq = excluded.summary_until_seq,
    extract_until_seq = excluded.extract_until_seq,
    updated_at = excluded.updated_at
`)

/**
 * 读取会话记忆游标状态。
 * @param {string} sessionId
 * @returns {{summary: string, summaryUntilSeq: number, extractUntilSeq: number}}
 */
export function getMemoryState(sessionId, ownerId) {
  if (!db) return { summary: '', summaryUntilSeq: 0, extractUntilSeq: 0 }
  if (!ownerId) throw new Error('getMemoryState 需要 ownerId（越权防护）')
  if (!getSession(sessionId, ownerId)) return { summary: '', summaryUntilSeq: 0, extractUntilSeq: 0 }
  try {
    const r = stmtGetMemoryState.get(sessionId)
    return r
      ? { summary: r.summary || '', summaryUntilSeq: Number(r.summary_until_seq) || 0, extractUntilSeq: Number(r.extract_until_seq) || 0 }
      : { summary: '', summaryUntilSeq: 0, extractUntilSeq: 0 }
  } catch (err) {
    log.warn({ details: err.message }, '[sessionStore] 记忆状态读取失败')
    return { summary: '', summaryUntilSeq: 0, extractUntilSeq: 0 }
  }
}

/**
 * 写入会话记忆游标状态（只读库会抛 SESSION_DB_READONLY，由调用方决定是否吞掉）。
 */
export function setMemoryState(sessionId, ownerId, { summary, summaryUntilSeq, extractUntilSeq } = {}) {
  requireWritable()
  if (!getSession(sessionId, ownerId)) throw new Error('会话不存在或无权访问')
  const now = new Date().toISOString()
  stmtUpsertMemoryState.run(sessionId, summary ?? '', summaryUntilSeq ?? 0, extractUntilSeq ?? 0, now)
}

export function getMessages(id, ownerId) {
  if (!ownerId) throw new Error('getMessages 需要 ownerId（越权防护）')
  const rows = stmtGetMessages.all(id, ownerId)
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
export function createSession({ agentName, title, ownerId }) {
  requireWritable()
  if (!ownerId) throw new Error('createSession 需要 ownerId（越权防护）')
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
  const tx = db.transaction(() => {
    stmtInsertSession.run(id, safeTitle, meta.agentName, ownerId, now, now)
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
export function renameSession(id, newTitle, ownerId) {
  requireWritable()
  if (!ownerId) throw new Error('renameSession 需要 ownerId（越权防护）')
  const existing = stmtGetSession.get(id, ownerId)
  if (!existing) return null
  const safe = typeof newTitle === 'string' && newTitle.trim()
    ? newTitle.trim().slice(0, 100)
    : existing.title
  const now = new Date().toISOString()
  stmtUpdateSessionTitle.run(safe, now, id, ownerId)
  return { ...existing, title: safe, updatedAt: now }
}

/**
 * 删除会话（元数据 + 消息 + annotations，外键 CASCADE 自动级联；
 * session_memory 无外键，需显式清理，防止孤儿摘要行累积）
 * @param {string} id
 * @returns {boolean}
 */
export function deleteSession(id, ownerId) {
  requireWritable()
  if (!ownerId) throw new Error('deleteSession 需要 ownerId（越权防护）')
  const info = stmtDeleteSession.run(id, ownerId)
  if (info.changes > 0) stmtDeleteMemoryState.run(id)
  return info.changes > 0
}

/**
 * 追加一条消息到会话（会自动 touch updatedAt + messageCount，首条 user 自动取标题）
 *
 * @param {string} sessionId
 * @param {{role:'user'|'assistant'|'system', content:string, annotations?:any[]}} msg
 * @returns {{id:string, role:string, content:string, createdAt:string, annotations?:any[]}|null}
 */
export function appendMessage(sessionId, msg, ownerId) {
  requireWritable()
  if (!ownerId) throw new Error('appendMessage 需要 ownerId（越权防护）')
  const meta = stmtGetSession.get(sessionId, ownerId)
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

  const tx = db.transaction(() => {
    stmtInsertMessage.run(id, sessionId, role, content, now)
    if (row.annotations) {
      stmtInsertAnnotation.run(id, JSON.stringify(msg.annotations))
    }
    stmtUpdateSessionOnAppend.run(newTitle, now, sessionId, ownerId)
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
export function getContextWindow(sessionId, opts = {}, ownerId) {
  if (!ownerId) throw new Error('getContextWindow 需要 ownerId（越权防护）')
  const maxTurns = Math.max(1, Number(opts.maxTurns) || 6)
  const maxChars = Math.max(500, Number(opts.maxChars) || 6000)

  const rows = stmtGetMessages.all(sessionId, ownerId)
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
/* ==================== P1 反思日志（reflection_log） ==================== */

const stmtAddReflection = prepare(`
  INSERT INTO reflection_log (session_id, question, score, action, issues, top1_score, citations, answer_chars, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

/**
 * 追加一条反思记录（P1 反思回路）。
 * @param {{sessionId?: string, question: string, score: number, action: string, issues?: string[],
 *          top1Score?: number|null, citations?: number, answerChars?: number}} r
 */
export function addReflection(r) {
  const info = stmtAddReflection.run(
    r.sessionId ?? '',
    String(r.question ?? '').slice(0, 500),
    Math.round(Number(r.score) || 0),
    String(r.action ?? ''),
    JSON.stringify(r.issues ?? []),
    r.top1Score == null ? null : Number(r.top1Score),
    Number.isFinite(r.citations) ? r.citations : null,
    Number.isFinite(r.answerChars) ? r.answerChars : null,
    new Date().toISOString(),
  )
  return info.lastInsertRowid
}

const stmtListReflections = prepare(`
  SELECT id, session_id AS sessionId, question, score, action, issues,
         top1_score AS top1Score, citations, answer_chars AS answerChars, created_at AS createdAt
  FROM reflection_log ORDER BY id DESC LIMIT ?
`)

/** 最近 N 条反思记录（管理页用），issues 已解析回数组 */
export function listReflections(limit = 50) {
  return stmtListReflections.all(Math.max(1, Math.min(200, Number(limit) || 50))).map((r) => {
    let issues = []
    try { issues = JSON.parse(r.issues ?? '[]') } catch { /* 历史脏数据按空处理 */ }
    return { ...r, issues }
  })
}

const stmtReflectionStats = prepare(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN score < 60 THEN 1 ELSE 0 END) AS lowCount,
         AVG(score) AS avgScore
  FROM reflection_log
`)

/** 反思统计总览（管理页用） */
export function reflectionStats() {
  const s = stmtReflectionStats.get()
  return {
    total: s.total ?? 0,
    lowCount: s.lowCount ?? 0,
    avgScore: s.avgScore == null ? null : Math.round(s.avgScore * 10) / 10,
  }
}

/* ============ 数据库目录浏览（管理端只读，"数据库"菜单的会话库数据源） ============ */

/**
 * 已知表的展示辅助（说明文案 + 排序优先级）—— 不是白名单。
 * 新建表（migration 里 CREATE TABLE）无需在此登记：browseTables 经 sqlite_master
 * 自动发现并追加在已知表之后，说明文案留空、行照常可浏览。
 */
const TABLE_META = {
  sessions: { desc: '会话列表（按智能体隔离）', order: 0 },
  messages: { desc: '聊天消息（SSE 全文落库）', order: 1 },
  annotations: { desc: '消息注解（引用卡片 / 工作流轨迹 JSON）', order: 2 },
  session_memory: { desc: '会话滚动摘要与记忆提炼游标', order: 3 },
  reflection_log: { desc: '反思评估记录（P1）', order: 4 },
  meta: { desc: '键值元数据', order: 9 },
  schema_version: { desc: 'schema 迁移版本', order: 10 },
}

/** 动态枚举全部用户表（sqlite_master，排除 sqlite_ 内部表）；失败返回空数组 */
function listUserTables() {
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
  } catch (err) {
    log.warn(`[sessionStore] 枚举用户表失败（${err.message}）`)
    return []
  }
}

/** 表结构（PRAGMA table_info）+ 索引（index_list/index_info）；表不存在返回 null */
function describeTable(name) {
  const columns = db
    .pragma(`table_info(${JSON.stringify(name)})`)
    .map((c) => ({ name: c.name, type: c.type || '', pk: !!c.pk, notnull: !!c.notnull }))
  if (!columns.length) return null
  let indexes = []
  try {
    indexes = db
      .pragma(`index_list(${JSON.stringify(name)})`)
      .filter((ix) => !ix.origin || ix.origin === 'c') // 只列显式创建的索引（sqlite_autoindex 为约束副产品）
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

/**
 * 列出全部表（结构 + 行数），供「数据库 → 会话库 · 数据结构」使用。
 * 自动发现：sqlite_master 动态枚举，新表自动出现，无需代码登记。
 * @returns {{ file: string, writable: boolean, items: Array<{name:string,kind:string,desc:string,rowCount:number,columns:Array<{name:string,type:string,pk:boolean,notnull:boolean}>,indexes:Array<{name:string,unique:boolean,columns:string[]}>}>}}
 */
export function browseTables() {
  if (!db) return { file: DB_FILE, writable: false, items: [] }
  // 排序：已知表按 TABLE_META 优先级在前，未知新表按字母序追加
  const names = listUserTables().sort((a, b) => {
    const oa = TABLE_META[a]?.order ?? 50
    const ob = TABLE_META[b]?.order ?? 50
    return oa - ob || a.localeCompare(b)
  })
  const items = []
  for (const name of names) {
    try {
      const d = describeTable(name)
      if (!d) continue // 表不存在（如被并发删除）则跳过
      const rowCount = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(name)}`).get()?.n ?? 0
      items.push({
        name,
        kind: 'sqlite',
        desc: TABLE_META[name]?.desc ?? '',
        rowCount,
        columns: d.columns,
        indexes: d.indexes,
      })
    } catch (err) {
      log.warn(`[sessionStore] 浏览表 ${name} 失败（${err.message}），已跳过`)
    }
  }
  return { file: DB_FILE, writable: isWritable(), items }
}

/**
 * 分页读取某表的行（按 rowid 排序），供「数据库 → 会话库 · 数据明细」使用。
 * 表名经 sqlite_master 存在性校验后以双引号转义拼接，杜绝注入。
 * @param {string} name 表名
 * @param {number} limit
 * @param {number} offset
 * @returns {{ name:string, kind:string, columns:string[], total:number, rows:Array<object> }}
 */
export function browseRows(name, limit = 200, offset = 0) {
  if (!db) throw new Error('会话数据库不可用')
  const t = String(name ?? '')
  const exists = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(t)
  if (!exists) throw new Error(`未知表：${t}`)
  const safe = JSON.stringify(t) // JSON.stringify 即带双引号的 SQL 标识符转义（表名无引号字符）
  const columns = db.pragma(`table_info(${safe})`).map((c) => c.name)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${safe}`).get()?.n ?? 0
  const rows = db
    .prepare(`SELECT * FROM ${safe} ORDER BY rowid LIMIT ? OFFSET ?`)
    .all(Math.min(500, Math.max(1, limit | 0)), Math.max(0, offset | 0))
  return { name: t, kind: 'sqlite', desc: TABLE_META[t]?.desc ?? '', columns, total, rows }
}

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
