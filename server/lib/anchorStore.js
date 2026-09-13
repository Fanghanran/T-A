import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { childLogger } from './logger.js'

/**
 * anchorStore —— 锚点层（L1）
 *
 * 三级存储模型（docs/向量库重构设计书.md）里的「锚点层」：
 *   documents      文档元数据（原件在文件系统的位置、分类标签、状态机）
 *   chunk_catalog  切片目录（★ 用户定义的核心表）：编号 / 锚点 span / 向量引用
 *
 * 设计约束：
 *  - **不存正文**。正文唯一住在 data/files/（见 fileStore）；此处只有指针。
 *    取文路径：锚点 (doc_id, idx) → span → fileStore.readSpan()
 *  - span 为**字符偏移**（与 fileStore.readSpan 同一语义）
 *  - 独立库（data/knowledge/kb.db），与 sessionStore 的会话库分域，备份/迁移互不牵连
 *  - schema_version 幂等迁移：user_version 记录版本，升级只加不删
 *
 * 依赖：better-sqlite3（原生模块）→ 运行时必须 Node 24（ABI 137），见项目 MEMORY。
 */

const log = childLogger('anchorStore')

const __dirname = dirname(fileURLToPath(import.meta.url))

const DB_FILE = (process.env.KB_DB_FILE ?? '').trim()
  ? resolve(process.cwd(), process.env.KB_DB_FILE.trim())
  : join(__dirname, '..', 'data', 'knowledge', 'kb.db')

mkdirSync(dirname(DB_FILE), { recursive: true })

const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/** 标注：与 sessionStore 的只读降级同理，库不可写时不该拖垮服务 */
try {
  db.pragma('wal_autocheckpoint = 256')
} catch (err) {
  log.warn(`wal_autocheckpoint 设置失败（${err.message}），已忽略`)
}

// ============ schema 迁移（幂等） ============

const SCHEMA_VERSION = 1

function migrate() {
  const current = Number(db.pragma('user_version', { simple: true })) || 0
  if (current >= SCHEMA_VERSION) return

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        doc_id      TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        title       TEXT NOT NULL,
        ext         TEXT NOT NULL DEFAULT '',
        size        INTEGER NOT NULL DEFAULT 0,
        path        TEXT NOT NULL DEFAULT '',
        category    TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        strategy    TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id, status);
      CREATE INDEX IF NOT EXISTS idx_documents_cat   ON documents(owner_id, category);

      CREATE TABLE IF NOT EXISTS chunk_catalog (
        chunk_id    TEXT PRIMARY KEY,
        doc_id      TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
        owner_id    TEXT NOT NULL,
        idx         INTEGER NOT NULL,
        span_start  INTEGER NOT NULL,
        span_end    INTEGER NOT NULL,
        heading     TEXT NOT NULL DEFAULT '',
        questions   TEXT,
        topic       TEXT,
        vec_text    TEXT,
        vec_quest   TEXT,
        vec_model   TEXT,
        updated_at  TEXT NOT NULL,
        UNIQUE(doc_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_doc   ON chunk_catalog(doc_id, idx);
      CREATE INDEX IF NOT EXISTS idx_catalog_owner ON chunk_catalog(owner_id);
    `)
    db.pragma(`user_version = 1`)
    log.info(`[anchorStore] schema 初始化完成 v1（${DB_FILE}）`)
  }
}

try {
  migrate()
} catch (err) {
  log.error({ details: err.message }, '[anchorStore] schema 迁移失败')
  throw err
}

// ============ 预编译语句 ============

const stmtInsertDoc = db.prepare(`
  INSERT INTO documents (doc_id, owner_id, title, ext, size, path, category, tags, strategy, status, created_at, updated_at)
  VALUES (@doc_id, @owner_id, @title, @ext, @size, @path, @category, @tags, @strategy, @status, @created_at, @updated_at)
`)
const stmtGetDoc = db.prepare('SELECT * FROM documents WHERE doc_id = ? AND owner_id = ?')
const stmtGetDocAnyOwner = db.prepare('SELECT * FROM documents WHERE doc_id = ?')
const stmtListDocs = db.prepare(`
  SELECT * FROM documents
  WHERE owner_id = @owner_id AND status != 'deleted'
    AND (@category = '' OR category = @category)
  ORDER BY created_at DESC
  LIMIT @limit OFFSET @offset
`)
// '*'（admin 聚合视图）：跨 owner 全量
const stmtListDocsAll = db.prepare(`
  SELECT * FROM documents
  WHERE status != 'deleted'
    AND (@category = '' OR category = @category)
  ORDER BY created_at DESC
  LIMIT @limit OFFSET @offset
`)
const stmtCountDocs = db.prepare(`
  SELECT COUNT(*) c FROM documents
  WHERE owner_id = @owner_id AND status != 'deleted'
    AND (@category = '' OR category = @category)
`)
const stmtCountDocsAll = db.prepare(`
  SELECT COUNT(*) c FROM documents
  WHERE status != 'deleted'
    AND (@category = '' OR category = @category)
`)
const stmtSetStatus = db.prepare(
  'UPDATE documents SET status = @status, error = @error, updated_at = @now WHERE doc_id = @doc_id AND owner_id = @owner_id',
)
const stmtPatchDoc = db.prepare(
  'UPDATE documents SET title = @title, category = @category, tags = @tags, strategy = @strategy, updated_at = @now WHERE doc_id = @doc_id AND owner_id = @owner_id',
)
const stmtSetDocPath = db.prepare(
  'UPDATE documents SET path = @path, ext = @ext, size = @size, updated_at = @now WHERE doc_id = @doc_id',
)
const stmtDeleteDoc = db.prepare('DELETE FROM documents WHERE doc_id = ? AND owner_id = ?')
const stmtDeleteChunksOfDoc = db.prepare('DELETE FROM chunk_catalog WHERE doc_id = ?')

const stmtInsertChunk = db.prepare(`
  INSERT INTO chunk_catalog
    (chunk_id, doc_id, owner_id, idx, span_start, span_end, heading, questions, topic, vec_text, vec_quest, vec_model, updated_at)
  VALUES
    (@chunk_id, @doc_id, @owner_id, @idx, @span_start, @span_end, @heading, @questions, @topic, @vec_text, @vec_quest, @vec_model, @updated_at)
`)
const stmtListChunks = db.prepare('SELECT * FROM chunk_catalog WHERE doc_id = ? AND owner_id = ? ORDER BY idx ASC')
const stmtListChunksByDoc = db.prepare('SELECT * FROM chunk_catalog WHERE doc_id = ? ORDER BY idx ASC')
const stmtGetChunk = db.prepare('SELECT * FROM chunk_catalog WHERE doc_id = ? AND idx = ? AND owner_id = ?')
const stmtGetChunkAnyOwner = db.prepare('SELECT * FROM chunk_catalog WHERE doc_id = ? AND idx = ?')
const stmtCountChunksOfDoc = db.prepare('SELECT COUNT(*) c FROM chunk_catalog WHERE doc_id = ?')
const stmtSetVecRefs = db.prepare(`
  UPDATE chunk_catalog SET vec_text = @vec_text, vec_quest = @vec_quest, vec_model = @vec_model, updated_at = @now
  WHERE doc_id = @doc_id AND idx = @idx
`)
const stmtStatsByOwner = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM documents WHERE owner_id = ? AND status != 'deleted') AS documents,
    (SELECT COUNT(*) FROM chunk_catalog WHERE owner_id = ?) AS chunks
`)
const stmtCountAll = db.prepare(
  "SELECT (SELECT COUNT(*) FROM documents WHERE status != 'deleted') AS documents, (SELECT COUNT(*) FROM chunk_catalog) AS chunks",
)

const now = () => new Date().toISOString()

function rowToDoc(r) {
  if (!r) return null
  return {
    id: r.doc_id,
    docId: r.doc_id,
    ownerId: r.owner_id,
    title: r.title,
    ext: r.ext,
    size: r.size,
    path: r.path,
    category: r.category,
    tags: safeJson(r.tags, []),
    strategy: r.strategy ? safeJson(r.strategy, null) : null,
    status: r.status,
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToChunk(r) {
  if (!r) return null
  return {
    chunkId: r.chunk_id,
    docId: r.doc_id,
    ownerId: r.owner_id,
    idx: r.idx,
    spanStart: r.span_start,
    spanEnd: r.span_end,
    heading: r.heading ?? '',
    questions: r.questions ? safeJson(r.questions, []) : [],
    topic: r.topic ?? null,
    vecText: r.vec_text ?? null,
    vecQuest: r.vec_quest ?? null,
    vecModel: r.vec_model ?? null,
    updatedAt: r.updated_at,
  }
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 库是否可写（供上层在受限环境下给出明确提示，而非静默失败） */
export function isWritable() {
  return !!db?.open
}

/* ============ documents ============ */

export function createDocument({
  docId,
  ownerId,
  title,
  ext = '',
  size = 0,
  path = '',
  category = '',
  tags = [],
  strategy = null,
  status = 'pending',
}) {
  const ts = now()
  stmtInsertDoc.run({
    doc_id: docId,
    owner_id: ownerId,
    title,
    ext,
    size,
    path,
    category,
    tags: JSON.stringify(tags ?? []),
    strategy: strategy ? JSON.stringify(strategy) : null,
    status,
    created_at: ts,
    updated_at: ts,
  })
  return getDocument(docId, ownerId)
}

export function getDocument(docId, ownerId) {
  // '*'（admin 聚合）：跨 owner 查找
  if (ownerId === '*') return rowToDoc(stmtGetDocAnyOwner.get(docId))
  return rowToDoc(stmtGetDoc.get(docId, ownerId))
}

/** 跨 owner 取（仅供系统级对账/迁移使用） */
export function getDocumentAnyOwner(docId) {
  return rowToDoc(stmtGetDocAnyOwner.get(docId))
}

export function listDocuments(ownerId, { category = '', page = 1, pageSize = 20 } = {}) {
  const limit = Math.max(1, Math.min(200, Number(pageSize) || 20))
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit)
  // '*'（admin 聚合视图）：跨 owner 全量
  const stmts = ownerId === '*' ? { list: stmtListDocsAll, count: stmtCountDocsAll } : { list: stmtListDocs, count: stmtCountDocs }
  const items = stmts.list.all({ owner_id: ownerId, category, limit, offset }).map(rowToDoc)
  const total = stmts.count.get({ owner_id: ownerId, category }).c
  return { items, total, page: Number(page) || 1, pageSize: limit }
}

/** 全部 owner 清单（去重；admin 聚合/迁移用） */
export function listOwnerIds() {
  return db.prepare("SELECT DISTINCT owner_id FROM documents WHERE status != 'deleted' ORDER BY owner_id").all().map((r) => r.owner_id)
}

export function setDocumentStatus(docId, ownerId, status, error = null) {
  stmtSetStatus.run({ doc_id: docId, owner_id: ownerId, status, error, now: now() })
  return getDocument(docId, ownerId)
}

export function patchDocument(docId, ownerId, { title, category, tags, strategy } = {}) {
  const cur = getDocument(docId, ownerId)
  if (!cur) return null
  stmtPatchDoc.run({
    doc_id: docId,
    owner_id: ownerId,
    title: title ?? cur.title,
    category: category ?? cur.category,
    tags: JSON.stringify(tags ?? cur.tags),
    strategy: (strategy ?? cur.strategy) ? JSON.stringify(strategy ?? cur.strategy) : null,
    now: now(),
  })
  return getDocument(docId, ownerId)
}

/** 回填原件落盘信息（fileStore 写入后调用） */
export function setDocumentFileInfo(docId, { path, ext, size }) {
  stmtSetDocPath.run({ doc_id: docId, path, ext, size, now: now() })
}

/** 物理删除文档行 + 其切片目录（fileStore 的物理删除由上层编排） */
export function deleteDocument(docId, ownerId) {
  const tx = db.transaction(() => {
    stmtDeleteChunksOfDoc.run(docId)
    stmtDeleteDoc.run(docId, ownerId)
  })
  tx()
}

/* ============ chunk_catalog ============ */

/**
 * 批量写入切片目录（覆盖同 doc 旧行）。
 * @param {string} docId
 * @param {string} ownerId
 * @param {Array<{chunkId, idx, spanStart, spanEnd, heading?, questions?, topic?, vecText?, vecQuest?, vecModel?}>} chunks
 */
export function replaceChunks(docId, ownerId, chunks = []) {
  const ts = now()
  const tx = db.transaction(() => {
    stmtDeleteChunksOfDoc.run(docId)
    for (const c of chunks) {
      stmtInsertChunk.run({
        chunk_id: c.chunkId,
        doc_id: docId,
        owner_id: ownerId,
        idx: c.idx,
        span_start: c.spanStart ?? 0,
        span_end: c.spanEnd ?? 0,
        heading: c.heading ?? '',
        questions: c.questions?.length ? JSON.stringify(c.questions) : null,
        topic: c.topic ?? null,
        vec_text: c.vecText ?? null,
        vec_quest: c.vecQuest ?? null,
        vec_model: c.vecModel ?? null,
        updated_at: ts,
      })
    }
  })
  tx()
  return chunks.length
}

export function listChunks(docId, ownerId) {
  if (ownerId === '*') return stmtListChunksByDoc.all(docId).map(rowToChunk)
  return stmtListChunks.all(docId, ownerId).map(rowToChunk)
}

export function getChunk(docId, idx, ownerId) {
  if (ownerId === '*') return rowToChunk(stmtGetChunkAnyOwner.get(docId, idx))
  return rowToChunk(stmtGetChunk.get(docId, idx, ownerId))
}

export function countChunksOfDoc(docId) {
  return stmtCountChunksOfDoc.get(docId).c
}

/** 回填向量引用（向量写入 Milvus 后调用） */
export function setVectorRefs(docId, idx, { vecText, vecQuest, vecModel }) {
  stmtSetVecRefs.run({
    doc_id: docId,
    idx,
    vec_text: vecText ?? null,
    vec_quest: vecQuest ?? null,
    vec_model: vecModel ?? null,
    now: now(),
  })
}

/* ============ 统计 ============ */

export function statsByOwner(ownerId) {
  if (ownerId === '*') return stats()
  const r = stmtStatsByOwner.get(ownerId, ownerId)
  return { documents: r?.documents ?? 0, chunks: r?.chunks ?? 0 }
}

export function stats() {
  const r = stmtCountAll.get()
  return { documents: r?.documents ?? 0, chunks: r?.chunks ?? 0 }
}

export function dbFile() {
  return DB_FILE
}

/* ============ 生命周期 ============ */

export function checkpointWal(mode = 'PASSIVE') {
  try {
    return db.pragma(`wal_checkpoint(${mode})`)
  } catch (err) {
    log.warn({ details: err.message }, `[anchorStore] WAL 检查点失败（${mode}）`)
    return null
  }
}

const gracefulClose = () => {
  try {
    checkpointWal('TRUNCATE')
  } catch {
    /* ignore */
  }
  try {
    db.close()
  } catch {
    /* ignore */
  }
}

try {
  process.on('exit', gracefulClose)
  process.on('SIGINT', () => {
    gracefulClose()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    gracefulClose()
    process.exit(143)
  })
} catch {
  /* 非 Node 环境忽略 */
}
