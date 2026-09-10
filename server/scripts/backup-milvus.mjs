/**
 * Milvus 数据备份 / 恢复脚本
 *
 * 用法：
 *   npm --prefix server run backup                      # 导出快照到 server/data/backups/
 *   npm --prefix server run backup -- --out <目录>       # 指定输出目录
 *   npm --prefix server run backup:restore -- <文件>     # 恢复（合并模式：快照数据 upsert 回库）
 *   npm --prefix server run backup:restore -- <文件> -- --prune   # 精确恢复（删除快照外的文档与切片）
 *
 * 快照内容：
 *   - kb_documents 全量（含 title_vector）
 *   - kb_chunks 全量原始行（含 text_vector + question_vector，恢复时零 embedding 成本）
 *   - 切片策略持久化文件（data/knowledge/doc-strategies.json）
 *
 * 设计要点：
 *   - 导出只读不初始化集合（getClient 惰性建连，直接 query）
 *   - 恢复用「零向量探测」初始化集合维度（快照自带 dim，不依赖 Embedding 服务在线）
 *   - 恢复后主动 flush（把 growing 段刷盘，防止容器硬杀丢数据 —— 与入库链路同口径）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  init,
  flush,
  getDim,
  listAllDocuments,
  upsertDocument,
  deleteDoc,
  deleteChunksOfDoc,
  rawQueryAll,
  rawReplaceAll,
} from '../lib/milvusStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const BACKUP_DIR = path.join(SERVER_ROOT, 'data', 'backups')
const STRATEGY_FILE = path.join(SERVER_ROOT, 'data', 'knowledge', 'doc-strategies.json')

/** 快照中的全部切片字段（行级原样往返，含双向量） */
const CHUNK_FIELDS = [
  'chunk_id', 'owner_id', 'doc_id', 'idx', 'text',
  'text_vector', 'question_vector',
  'heading', 'topic', 'questions', 'display_title',
  'pre_context', 'post_context', 'category', 'tags', 'status', 'indexed_at',
]

function timestamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 导出快照 */
async function doExport(outDir) {
  const docs = await listAllDocuments()
  const chunkRows = await rawQueryAll(CHUNK_FIELDS)
  if (!docs.length && !chunkRows.length) {
    console.error('[backup] 库内无文档与切片，跳过导出（空备份无意义）')
    process.exitCode = 1
    return
  }
  const dim = docs.find((d) => Array.isArray(d._titleVector))?._titleVector?.length
    ?? chunkRows.find((r) => Array.isArray(r.text_vector))?.text_vector?.length
    ?? null

  let strategies = null
  try {
    strategies = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf8'))
  } catch {
    strategies = null // 未配置策略的干净环境
  }

  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    dim,
    docCount: docs.length,
    chunkCount: chunkRows.length,
    documents: docs,
    chunkRows,
    strategies,
  }

  const dir = outDir || BACKUP_DIR
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `milvus-${timestamp()}.json`)
  fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8')
  const size = fs.statSync(file).size
  console.log(`[backup] 导出完成：${file}`)
  console.log(`[backup] 文档 ${docs.length} 篇 / 切片 ${chunkRows.length} 块 / dim=${dim} / ${fmtBytes(size)}`)
}

/** 恢复快照（合并 upsert；--prune 时删除快照外数据） */
async function doRestore(file, prune) {
  if (!file || !fs.existsSync(file)) {
    console.error(`[backup] 快照文件不存在：${file}`)
    process.exitCode = 1
    return
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(snap.documents) || !Array.isArray(snap.chunkRows)) {
    console.error('[backup] 快照格式非法（缺 documents / chunkRows）')
    process.exitCode = 1
    return
  }
  const dim = Number(snap.dim)
  if (!Number.isFinite(dim) || dim <= 0) {
    console.error('[backup] 快照缺少有效 dim，无法初始化集合')
    process.exitCode = 1
    return
  }

  // 用零向量探测初始化（快照自带 dim，不依赖 Embedding 服务在线；
  // 既有集合维度不一致时 init 内部 verifyDim 会 fail-fast）
  await init(async (texts) => texts.map(() => new Array(dim).fill(0)))

  // 精确恢复：先删快照外的文档与切片
  if (prune) {
    const keep = new Set(snap.documents.map((d) => d.id))
    const keepChunks = new Set(snap.chunkRows.map((r) => r.chunk_id))
    const existing = await listAllDocuments()
    let prunedDocs = 0
    for (const d of existing) {
      if (keep.has(d.id)) continue
      await deleteChunksOfDoc(d.id, d.ownerId)
      await deleteDoc(d.id, d.ownerId)
      prunedDocs++
    }
    const orphanIds = (await rawQueryAll(['chunk_id'])).map((r) => r.chunk_id).filter((id) => !keepChunks.has(id))
    if (orphanIds.length) await deleteChunksByIdSafe(orphanIds)
    console.log(`[backup] --prune：删除快照外文档 ${prunedDocs} 篇 / 孤儿切片 ${orphanIds.length} 块`)
  }

  // 恢复文档（upsertDocument 删旧插新，_titleVector 原样带回）
  let docOk = 0
  for (const d of snap.documents) {
    await upsertDocument(d)
    docOk++
  }
  // 恢复切片（rawReplaceAll：按 chunk_id 删旧插新，双向量原样回插，零 embedding）
  await rawReplaceAll(snap.chunkRows)

  // 恢复切片策略持久化文件
  if (snap.strategies && Object.keys(snap.strategies).length) {
    fs.mkdirSync(path.dirname(STRATEGY_FILE), { recursive: true })
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify(snap.strategies, null, 2), 'utf8')
    console.log(`[backup] 已恢复切片策略：${Object.keys(snap.strategies).length} 条`)
  }

  await flush()
  console.log(
    `[backup] 恢复完成：文档 ${docOk}/${snap.documents.length} 篇 / 切片 ${snap.chunkRows.length} 块` +
      `（当前集合 dim=${getDim()}）`,
  )
}

/** 按切片 id 批量删除（rawReplaceAll 同款分批口径） */
async function deleteChunksByIdSafe(ids) {
  // 复用 milvusStore 的 deleteChunksById（已导出，分批 100）
  const { deleteChunksById } = await import('../lib/milvusStore.js')
  await deleteChunksById(ids)
}

/* ===================== CLI 入口 ===================== */

const [cmd, ...rest] = process.argv.slice(2)
const args = rest.filter((x) => !x.startsWith('--'))
const flags = rest.filter((x) => x.startsWith('--'))

try {
  if (cmd === 'export') {
    const outIdx = rest.indexOf('--out')
    await doExport(outIdx >= 0 ? rest[outIdx + 1] : null)
  } else if (cmd === 'restore') {
    await doRestore(args[0], flags.includes('--prune'))
  } else {
    console.log('用法：node scripts/backup-milvus.mjs export [--out 目录] | restore <快照文件> [--prune]')
    process.exitCode = 1
  }
} catch (err) {
  console.error(`[backup] 失败：${err.message}`)
  process.exitCode = 1
}
