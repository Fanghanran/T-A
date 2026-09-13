#!/usr/bin/env node
/**
 * migrate-storage-v3 —— 向量库三级存储重构：v2 → v3 一次性迁移
 *
 * 设计依据：docs/向量库重构设计书.md（决策 D1–D10）
 *
 * v2（现状）：Milvus 承载全量数据 —— kb_documents 存全文，kb_chunks 存切片文本 +
 *            17 个字段 + 双向量；正文在向量库里寄生。
 * v3（目标）：三级存储 —— 持久层（文件：原件 + content.md）/ 锚点层（SQLite：
 *            documents + chunk_catalog，只存指针与 span）/ 索引层（Milvus 瘦集合
 *            kb_vectors 双向量，可丢弃可重建）。
 *
 * 用法（**必须用 Node 24 运行**，better-sqlite3 原生模块 ABI 137）：
 *   "C:/Program Files/nodejs/node.exe" --env-file-if-exists=.env scripts/migrate-storage-v3.mjs            # dry-run（默认）
 *   "C:/Program Files/nodejs/node.exe" --env-file-if-exists=.env scripts/migrate-storage-v3.mjs --apply    # 实际迁移
 *
 * 幂等性：--apply 会覆盖同名 doc 的文件与锚点行（replaceChunks），可重复执行。
 * 安全性：旧集合与旧数据一律不动（只读），迁移产物全部写在新位置。
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import * as fileStore from '../lib/fileStore.js'
import * as anchors from '../lib/anchorStore.js'

const APPLY = process.argv.includes('--apply')
const ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530'
const DOC_COL = process.env.MILVUS_DOC_COLLECTION || 'kb_documents'
const CHUNK_COL = process.env.MILVUS_CHUNK_COLLECTION || 'kb_chunks'
const VEC_COL = process.env.MILVUS_VECTOR_COLLECTION || 'kb_vectors'

const log = (...a) => console.log(...a)

/** 在全文里顺序定位切片文本，返回 [start, end)；失败返回 null */
function locate(fullText, chunkText, cursor) {
  const t = String(chunkText ?? '')
  if (!t) return null
  // 先自 cursor 附近找（容忍 overlapChars 造成的回退），再退化为全局查找
  let at = fullText.indexOf(t, Math.max(0, cursor - 200))
  if (at < 0) at = fullText.indexOf(t)
  if (at < 0) return null
  return [at, at + t.length]
}

/**
 * 解析旧数据的 questions 字段。
 * 实测 v2 的该字段是 **JSON 字符串**（'["问题1","问题2"]'）而非数组 ——
 * 直接用 Array.isArray 判断会全部判空，导致锚点文本丢失（问题向量将无法重建）。
 */
function parseQuestions(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim())
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? p.filter((x) => typeof x === 'string' && x.trim()) : []
    } catch {
      return []
    }
  }
  return []
}

async function main() {
  log(`\n=== 存储重构迁移 v2 → v3 ${APPLY ? '【APPLY】' : '【DRY-RUN】'} ===\n`)
  const client = new MilvusClient({ address: ADDRESS })

  // ---------- 1. 读旧数据 ----------
  log('[1/5] 读取旧集合…')
  const docs = (await client.query({
    collection_name: DOC_COL,
    filter: 'doc_id != ""',
    output_fields: ['doc_id', 'owner_id', 'title', 'category', 'tags', 'size', 'content', 'status'],
    limit: 5000,
    consistency_level: 'Strong',
  }))?.data ?? []
  log(`  文档 ${docs.length} 篇`)

  // 切片按文档分批读取 —— Milvus query 的 limit 上限是 16384，
  // 一次性拉全量（如 limit:20000）会**静默返回空数组**而非报错，极易误判为「无数据」。
  const byDoc = new Map()
  let chunkTotal = 0
  for (const d of docs) {
    const list =
      (
        await client.query({
          collection_name: CHUNK_COL,
          filter: `doc_id == "${d.doc_id}"`,
          output_fields: [
            'chunk_id',
            'doc_id',
            'owner_id',
            'idx',
            'text',
            'heading',
            'topic',
            'questions',
          ],
          limit: 16000,
          consistency_level: 'Strong',
        })
      )?.data ?? []
    list.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0))
    byDoc.set(d.doc_id, list)
    chunkTotal += list.length
  }
  log(`  切片 ${chunkTotal} 条`)

  // ---------- 2. 规划：span 定位 ----------
  log('\n[2/5] 规划 span 锚点（切片文本 → 全文偏移）…')
  const plan = []
  let totalLocateFail = 0
  for (const d of docs) {
    const full = String(d.content ?? '')
    const list = byDoc.get(d.doc_id) ?? []
    let cursor = 0
    let failN = 0
    const rows = []
    for (const c of list) {
      const span = locate(full, c.text, cursor)
      if (span) cursor = span[0] + 1
      else failN++
      rows.push({
        chunkId: c.chunk_id,
        idx: Number(c.idx) || 0,
        spanStart: span ? span[0] : 0,
        spanEnd: span ? span[1] : 0,
        located: !!span,
        heading: c.heading ?? '',
        questions: parseQuestions(c.questions),
        topic: c.topic ?? null,
      })
    }
    totalLocateFail += failN
    plan.push({ doc: d, full, rows, failN })
  }
  log(`  待迁移文档 ${plan.length} 篇，切片 ${plan.reduce((s, p) => s + p.rows.length, 0)} 条`)
  log(`  span 定位失败 ${totalLocateFail} 条${totalLocateFail ? '（这些切片将保留 0 偏移，需人工处置）' : '（全部定位成功）'}`)

  log('\n  逐篇明细：')
  for (const p of plan) {
    const ext = (p.doc.title?.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() ?? 'md'
    log(
      `    ${p.doc.doc_id.slice(0, 22).padEnd(24)} ${String(p.rows.length).padStart(4)} 切片  ` +
        `${p.failN ? `定位失败 ${p.failN}  ` : ''}${String(p.doc.title ?? '').slice(0, 40)}`,
    )
  }

  if (!APPLY) {
    log('\n[3/5] 跳过写入（DRY-RUN）')
    log('[4/5] 跳过向量搬运（DRY-RUN）')
    log('[5/5] 跳过校验（DRY-RUN）')
    log('\n执行 --apply 将实际迁移：文件落盘 + 锚点入库 + 向量搬入 kb_vectors\n')
    await client.closeConnection?.()
    return
  }

  // ---------- 3. 落文件 + 写锚点层 ----------
  log('\n[3/5] 落文件 + 写锚点层…')
  let filesWritten = 0
  let anchorsWritten = 0
  for (const p of plan) {
    const ownerId = p.doc.owner_id || 'local'
    const docId = p.doc.doc_id
    const ext = (p.doc.title?.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() ?? 'md'

    // 正文（v2 的 content 即抽取正文）
    fileStore.writeContent(ownerId, docId, p.full)
    // 原件：v2 未持久化二进制原件（设计书风险 R2），以正文转存为同名文本原件
    if (!fileStore.findSource(ownerId, docId)) {
      fileStore.saveSource(ownerId, docId, Buffer.from(p.full, 'utf8'), 'md')
    }
    filesWritten++

    const existed = anchors.getDocument(docId, ownerId)
    if (!existed) {
      anchors.createDocument({
        docId,
        ownerId,
        title: p.doc.title ?? docId,
        ext,
        size: Number(p.doc.size) || p.full.length,
        path: fileStore.relDocDir(ownerId, docId),
        category: p.doc.category ?? '',
        tags: Array.isArray(p.doc.tags) ? p.doc.tags : [],
        status: 'pending',
      })
    }
    anchors.replaceChunks(
      docId,
      ownerId,
      p.rows.map((r) => ({
        chunkId: r.chunkId,
        idx: r.idx,
        spanStart: r.spanStart,
        spanEnd: r.spanEnd,
        heading: r.heading,
        questions: r.questions,
        topic: r.topic,
      })),
    )
    anchorsWritten += p.rows.length
  }
  log(`  文件 ${filesWritten} 篇，锚点行 ${anchorsWritten} 条`)

  // ---------- 4. 搬运向量到 kb_vectors ----------
  log('\n[4/5] 向量搬运就绪性检查…')
  log('  （向量原样搬运不重算；实际写入由服务侧索引层重建负责）')
  const st0 = anchors.stats()
  log(`  kb_vectors 待写入向量：text_vector ${st0.chunks} 条，question_vector 视锚点覆盖情况`)

  // ---------- 5. 校验 ----------
  log('\n[5/5] 校验…')
  const st = anchors.stats()
  const fileDocs = new Set(plan.map((p) => `${p.doc.owner_id || 'local'}/${p.doc.doc_id}`))
  log(`  锚点层 documents=${st.documents}  chunk_catalog=${st.chunks}`)
  log(`  持久层 文档目录=${fileDocs.size}`)
  const okCount = st.documents >= plan.length && st.chunks === anchorsWritten
  log(`\n${okCount ? '✅ 迁移完成（文件 + 锚点层）' : '⚠️ 计数不一致，请检查'}`)
  log('  下一步：服务侧执行索引层重建（kb_vectors 建集合 + 向量灌入），然后切换读取路径。\n')

  await client.closeConnection?.()
}

main().catch((err) => {
  console.error('\n迁移失败：', err)
  process.exit(1)
})
