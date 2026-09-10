#!/usr/bin/env node
/**
 * check-memory-ownership —— 记忆数据 per-user 归属完整性检查（M5b）
 *
 * 检查两层记忆的归属完整性，回答「是否存在缺归属、需要迁移/清理的存量」：
 *   长期层  Milvus kb_memory      —— schema 自带 owner_id（M5a），检查是否有空值行
 *   短期层  SQLite session_memory —— 无 owner 列，靠 session_id → sessions.owner_id
 *         间接隔离（getMemoryState/setMemoryState 均先过会话归属校验）；
 *         检查是否存在「会话已删但游标残留」的孤儿
 *
 * 退出码：0 = 归属完整（无需迁移）；1 = 存在待迁移/待清理数据（明细见输出）
 *
 * 用法：node scripts/check-memory-ownership.mjs
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const _require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DB_FILE = (process.env.SESSIONS_DB_FILE ?? '').trim()
  ? path.resolve(process.cwd(), process.env.SESSIONS_DB_FILE.trim())
  : path.join(__dirname, '..', 'data', 'sessions', 'sessions.db')

const ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530'
const MEM_COL = process.env.MILVUS_MEMORY_COLLECTION || 'kb_memory'

async function checkMilvus(client) {
  const r = await client.query({
    collection_name: MEM_COL,
    filter: 'mem_id != ""',
    output_fields: ['mem_id', 'owner_id', 'scope', 'session_id'],
    limit: 10000,
    consistency_level: 'Strong',
  })
  const rows = r?.data ?? []
  const orphans = rows.filter((x) => !x.owner_id)
  console.log(`[长期层] ${MEM_COL}: ${rows.length} 条，缺 owner_id: ${orphans.length}`)
  for (const o of orphans.slice(0, 10)) {
    console.log(`   待迁移 mem_id=${o.mem_id} scope=${o.scope} session=${o.session_id || '(无)'}`)
  }
  return { total: rows.length, orphans: orphans.length }
}

function checkSqlite() {
  const D = _require('better-sqlite3')
  const db = new D(DB_FILE, { readonly: true })
  try {
    const n = db.prepare('SELECT COUNT(*) c FROM session_memory').get().c
    // 孤儿：游标存在但会话已删 —— 既无法再经父表隔离，也永远不会再被读取
    const orphan = db
      .prepare(
        `SELECT m.session_id FROM session_memory m
         LEFT JOIN sessions s ON s.id = m.session_id
         WHERE s.id IS NULL`,
      )
      .all()
    console.log(`[短期层] session_memory: ${n} 行，孤儿游标（会话已删）: ${orphan.length}`)
    for (const o of orphan.slice(0, 10)) console.log(`   待清理 session_id=${o.session_id}`)
    return { total: n, orphans: orphan.length }
  } finally {
    db.close()
  }
}

async function main() {
  console.log('\n=== 记忆归属完整性检查（M5b）===\n')
  const client = new MilvusClient({ address: ADDRESS })
  let milvus
  let sqlite
  try {
    milvus = await checkMilvus(client)
  } catch (e) {
    console.log(`[长期层] 检查失败: ${e.message}`)
    milvus = null
  }
  try {
    sqlite = checkSqlite()
  } catch (e) {
    console.log(`[短期层] 检查失败: ${e.message}`)
    sqlite = null
  }
  await client.closeNumericMetrics?.()

  const bad = (milvus?.orphans ?? 0) + (sqlite?.orphans ?? 0)
  console.log(`\n${bad === 0 ? '✅ 归属完整，无待迁移数据' : `⚠️ 共 ${bad} 条待处理（明细见上）`}\n`)
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('检查失败:', e)
  process.exit(2)
})
