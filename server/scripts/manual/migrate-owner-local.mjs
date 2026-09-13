/**
 * 一次性迁移：owner 'local'（前鉴权时代遗留）→ 'admin'
 *
 * 覆盖：Milvus kb_vectors（删插重写 owner）→ 锚点库 kb.db → 文件目录 data/files/local
 *      → ES kb_chunks_keyword（按 doc 删 + 重索引）→ 旧版 questions.json / wiki.json 归位 admin。
 * 幂等：无 'local' 数据时各步骤自动跳过，可安全重跑。
 *
 * 运行：先停后端，再在 server/ 下执行
 *   node scripts/manual/migrate-owner-local.mjs
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as anchors from '../../lib/anchorStore.js'
import * as vindex from '../../lib/vectorIndexV3.js'
import * as esStore from '../../lib/esStore.js'
import * as files from '../../lib/fileStore.js'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FROM = 'local'
const TO = 'admin'

const log = (msg) => console.log(`[migrate] ${msg}`)

/* ---------- 0. 账号参考信息 ---------- */
try {
  const db = new Database(join(SERVER_ROOT, 'data', 'management', 'accounts.db'), { readonly: true })
  const users = db.prepare('SELECT user_id, role FROM users').all()
  log(`账号清单：${users.map((u) => `${u.user_id}(${u.role})`).join(', ') || '(空)'}`)
  if (!users.some((u) => u.user_id === TO)) {
    log(`⚠️  账号库中不存在 ${TO}，迁移后数据将挂在不存在的 owner 名下（仍可后续手工改）`)
  }
  db.close()
} catch (err) {
  log(`账号库读取跳过：${err.message}`)
}

/* ---------- 1. 存量 'local' 文档清单 ---------- */
const docs = anchors.listDocuments(FROM, { pageSize: 200 }).items
log(`owner '${FROM}' 文档：${docs.length} 篇`)
if (docs.length === 0) {
  log('无存量数据，仅尝试旧版 questions/wiki 文件归位')
} else {
  /* ---------- 2. Milvus kb_vectors：读（local）→ 插（admin）→ 删（local） ---------- */
  let vecMoved = 0
  for (const d of docs) {
    const vecMap = await vindex.readVectorsByDoc(d.id, FROM)
    if (vecMap.size === 0) continue
    const idxById = new Map(anchors.listChunks(d.id, FROM).map((c) => [c.chunkId, c.idx]))
    const rows = [...vecMap.entries()].map(([vecId, v]) => ({
      vec_id: vecId,
      owner_id: TO,
      doc_id: d.id,
      idx: idxById.get(vecId) ?? 0,
      text_vector: v.text ?? [],
      question_vector: v.question ?? new Array((v.text ?? []).length).fill(0),
    }))
    await vindex.insertVectors(rows)
    await vindex.deleteVectorsOfDoc(d.id, FROM)
    vecMoved += rows.length
    log(`  向量重写：${d.id}（${rows.length} 条）`)
  }
  await vindex.flush()
  log(`Milvus 向量重写完成：${vecMoved} 条`)

  /* ---------- 3. 锚点库 owner 改写 ---------- */
  const kb = new Database(anchors.dbFile())
  const d1 = kb.prepare('UPDATE documents SET owner_id = ? WHERE owner_id = ?').run(TO, FROM)
  const d2 = kb.prepare('UPDATE chunk_catalog SET owner_id = ? WHERE owner_id = ?').run(TO, FROM)
  kb.close()
  log(`锚点库改写：documents ${d1.changes} 行 · chunk_catalog ${d2.changes} 行`)

  /* ---------- 4. 文件目录 data/files/local → data/files/admin ---------- */
  const srcDir = join(SERVER_ROOT, 'data', 'files', FROM)
  const dstDir = join(SERVER_ROOT, 'data', 'files', TO)
  if (existsSync(srcDir)) {
    mkdirSync(dstDir, { recursive: true })
    for (const name of readdirSync(srcDir)) {
      const src = join(srcDir, name)
      const dst = join(dstDir, name)
      if (existsSync(dst)) {
        log(`  ⚠️  目标已存在，跳过目录移动：${name}`)
        continue
      }
      renameSync(src, dst)
    }
    try { if (readdirSync(srcDir).length === 0) renameSync(srcDir, `${srcDir}.migrated`) } catch { /* ignore */ }
    log(`文件目录已迁移 → data/files/${TO}`)
  }

  /* ---------- 5. ES：按 doc 删除 + 以 admin 重索引 ---------- */
  if (esStore.isEnabled()) {
    let esN = 0
    for (const d of docs) {
      await esStore.deleteByDocId(d.id)
      const chunks = anchors.listChunks(d.id, TO)
      let full = ''
      try { full = files.readContent(TO, d.id) } catch { full = '' }
      const rows = chunks.map((c) => ({
        id: c.chunkId,
        docId: d.id,
        ownerId: TO,
        displayTitle: d.title,
        questions: c.questions,
        text: full.slice(c.spanStart ?? 0, c.spanEnd ?? 0),
        category: d.category,
        tags: d.tags,
      }))
      await esStore.indexChunks(rows)
      esN += rows.length
    }
    log(`ES 重索引完成：${esN} 条`)
  } else {
    log('ES 未启用，跳过（下次上传/回填时按新 owner 入索引）')
  }
}

/* ---------- 6. 旧版 questions.json → questions/admin.json ---------- */
const legacyQ = join(SERVER_ROOT, 'data', 'interview', 'questions.json')
const qDir = join(SERVER_ROOT, 'data', 'interview', 'questions')
const adminQ = join(qDir, 'admin.json')
if (existsSync(legacyQ) && !existsSync(adminQ)) {
  mkdirSync(qDir, { recursive: true })
  renameSync(legacyQ, adminQ)
  log('题库已迁移 → questions/admin.json')
}

/* ---------- 7. 旧版 wiki.json → wiki/admin.json ---------- */
const legacyW = join(SERVER_ROOT, 'data', 'knowledge', 'wiki.json')
const wDir = join(SERVER_ROOT, 'data', 'knowledge', 'wiki')
const adminW = join(wDir, 'admin.json')
if (existsSync(legacyW) && !existsSync(adminW)) {
  mkdirSync(wDir, { recursive: true })
  renameSync(legacyW, adminW)
  log('Wiki 已迁移 → wiki/admin.json')
}

/* ---------- 8. 终态对账 ---------- */
const owners = anchors.listOwnerIds()
log(`迁移完成。当前 owner 分布：${owners.map((o) => `${o}(${anchors.statsByOwner(o).documents} 篇/${anchors.statsByOwner(o).chunks} 切)`).join(', ')}`)
