#!/usr/bin/env node
/**
 * rebuild-index-v3 —— 索引层重建（v3 第 1 步）
 *
 * 按 docs/向量库重构设计书.md §4.3 建立瘦集合 kb_vectors 并搬运双向量：
 *   v2  kb_chunks：17 字段（含 text/heading/questions/pre_context/...）+ 双向量
 *   v3  kb_vectors：vec_id / owner_id / doc_id / idx / text_vector / question_vector
 *
 * 向量**原样搬运不重算**（新旧维度一致，均为 bge-m3 1024），搬运后回填锚点层的
 * vec_text / vec_quest / vec_model，使「目录 ↔ 向量」双向可定位。
 *
 * 用法（Node 24）：
 *   node --env-file-if-exists=.env scripts/rebuild-index-v3.mjs            # dry-run
 *   node --env-file-if-exists=.env scripts/rebuild-index-v3.mjs --apply    # 建集合 + 搬运
 *
 * 幂等：--apply 会先删同名集合再重建（索引层可丢弃，符合三级存储定性）。
 */

import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node'
import * as anchors from '../lib/anchorStore.js'

const APPLY = process.argv.includes('--apply')
const ADDRESS = process.env.MILVUS_ADDRESS || 'localhost:19530'
const CHUNK_COL = process.env.MILVUS_CHUNK_COLLECTION || 'kb_chunks'
const VEC_COL = process.env.MILVUS_VECTOR_COLLECTION || 'kb_vectors'

const log = (...a) => console.log(...a)

const LEN = { id: 128, owner: 64 }

let client

/** 探测 embedding 维度：从旧集合的向量字段读一条样本 */
async function probeDim() {
  const r = await client.query({
    collection_name: CHUNK_COL,
    filter: 'chunk_id != ""',
    output_fields: ['text_vector'],
    limit: 1,
    consistency_level: 'Strong',
  })
  const v = r?.data?.[0]?.text_vector
  if (!Array.isArray(v) || !v.length) throw new Error('无法探测向量维度（旧集合读不到 text_vector）')
  return v.length
}

async function hasCollection(name) {
  const r = await client.hasCollection({ collection_name: name })
  return !!(r?.value ?? r)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Milvus 的管理类操作（drop/create/index/load）在 proxy 侧是异步任务，
 * 默认 gRPC 超时较短，容易报 "TaskCondition context Done: context deadline exceeded"。
 * 统一加重试 + 退避，并把超时拉到 60s。
 */
async function withRetry(fn, label, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = String(err?.reason ?? err?.message ?? err).slice(0, 90)
      log(`  ${label} 第 ${i}/${attempts} 次失败：${msg}`)
      if (i === attempts) throw err
      await sleep(4000 * i)
    }
  }
}

async function createVectorCollection(dim) {
  await withRetry(
    () =>
      client.createCollection({
        collection_name: VEC_COL,
        timeout: 60000,
        fields: [
          { name: 'vec_id', data_type: DataType.VarChar, is_primary_key: true, max_length: LEN.id },
          { name: 'owner_id', data_type: DataType.VarChar, max_length: LEN.owner },
          { name: 'doc_id', data_type: DataType.VarChar, max_length: LEN.id },
          { name: 'idx', data_type: DataType.Int64 },
          { name: 'text_vector', data_type: DataType.FloatVector, dim },
          { name: 'question_vector', data_type: DataType.FloatVector, dim },
        ],
      }),
    'createCollection',
  )
  for (const field_name of ['text_vector', 'question_vector']) {
    await withRetry(
      () =>
        client.createIndex({
          collection_name: VEC_COL,
          field_name,
          index_type: 'HNSW',
          metric_type: 'COSINE',
          params: { M: 16, efConstruction: 200 },
          timeout: 120000,
        }),
      `createIndex(${field_name})`,
    )
  }
  for (const field_name of ['owner_id', 'doc_id']) {
    await withRetry(
      () =>
        client.createIndex({
          collection_name: VEC_COL,
          field_name,
          index_type: 'INVERTED',
          timeout: 60000,
        }),
      `createIndex(${field_name})`,
    )
  }
  await withRetry(
    () => client.loadCollection({ collection_name: VEC_COL, timeout: 120000 }),
    'loadCollection',
  )
}

/** 按 doc 分批读旧切片（含双向量）—— limit 上限 16384，按 doc 分片避免超限 */
async function readChunksWithVectors(docIds) {
  const out = []
  for (const docId of docIds) {
    const rows =
      (
        await client.query({
          collection_name: CHUNK_COL,
          filter: 'doc_id == ' + JSON.stringify(docId),
          output_fields: ['chunk_id', 'doc_id', 'owner_id', 'idx', 'text_vector', 'question_vector'],
          limit: 16000,
          consistency_level: 'Strong',
        })
      )?.data ?? []
    out.push(...rows)
  }
  return out
}

async function main() {
  log(`\n=== 索引层重建（v3） ${APPLY ? '【APPLY】' : '【DRY-RUN】'} ===\n`)
  client = new MilvusClient({ address: ADDRESS })

  // 1. 维度探测 + 待搬运清单
  log('[1/4] 探测维度与待搬运切片…')
  const dim = await probeDim()
  log(`  向量维度 dim=${dim}`)

  const docIds = [...new Set(anchors.listDocuments('local', { pageSize: 200 }).items.map((d) => d.id))]
  // 兜底：local 之外的历史 owner（多用户场景）
  const allDocIds = docIds.length ? docIds : []
  log(`  锚点层文档 ${allDocIds.length} 篇`)

  const chunks = await readChunksWithVectors(allDocIds)
  const withQ = chunks.filter((c) => Array.isArray(c.question_vector) && c.question_vector.length).length
  log(`  旧切片 ${chunks.length} 条（含问题向量 ${withQ} 条）`)

  if (!APPLY) {
    log('\n[2/4] 跳过建集合（DRY-RUN）')
    log('[3/4] 跳过搬运（DRY-RUN）')
    log('[4/4] 跳过回填（DRY-RUN）')
    log(`\n执行 --apply 将：重建 ${VEC_COL}（dim=${dim}）+ 搬运 ${chunks.length} 组双向量 + 回填锚点层\n`)
    return
  }

  // 2. 建集合（索引层可丢弃：存在即重建）
  log('\n[2/4] 建立瘦集合 ' + VEC_COL + '…')
  if (await hasCollection(VEC_COL)) {
    log('  已存在，先 drop 重建')
    await withRetry(
      () => client.dropCollection({ collection_name: VEC_COL, timeout: 60000 }),
      'dropCollection',
    )
    // Milvus 的 drop 是异步的，立刻 create 同名集合会撞上未完成的清理
    await sleep(5000)
  }
  await createVectorCollection(dim)
  log('  建集合 + 索引 + load 完成')

  // 3. 搬运向量
  log('\n[3/4] 搬运双向量…')
  // idx 为 Int64，但 Milvus 读出是 string → 必须 Number 化再写回
  const rows = chunks.map((c) => ({
    vec_id: c.chunk_id,
    owner_id: c.owner_id || 'local',
    doc_id: c.doc_id,
    idx: Number(c.idx) || 0,
    text_vector: c.text_vector,
    question_vector:
      Array.isArray(c.question_vector) && c.question_vector.length
        ? c.question_vector
        : new Array(dim).fill(0),
  }))
  const BATCH = 64
  let moved = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    await client.insert({ collection_name: VEC_COL, data: rows.slice(i, i + BATCH) })
    moved += Math.min(BATCH, rows.length - i)
  }
  // SDK v3 的 flush 参数是复数数组 collection_names（写 collection_name 会报 missing）
  await client.flush({ collection_names: [VEC_COL] })
  log(`  已写入 ${moved} 组双向量并 flush`)

  // 4. 回填锚点层向量引用
  log('\n[4/4] 回填锚点层 vec_text / vec_quest / vec_model…')
  let filled = 0
  for (const c of chunks) {
    const hasQuestion = Array.isArray(c.question_vector) && c.question_vector.length > 0
    anchors.setVectorRefs(c.doc_id, Number(c.idx) || 0, {
      vecText: c.chunk_id,
      vecQuest: hasQuestion ? c.chunk_id : null,
      vecModel: `bge-m3/${dim}`,
    })
    filled++
  }
  log(`  回填 ${filled} 行`)

  // 校验
  const st = anchors.stats()
  const cnt = await client.query({
    collection_name: VEC_COL,
    filter: 'vec_id != ""',
    output_fields: ['vec_id'],
    limit: 16000,
    consistency_level: 'Strong',
  })
  const vecCount = cnt?.data?.length ?? 0
  log(`\n  锚点层 chunks=${st.chunks}  |  kb_vectors 向量=${vecCount}`)
  log(`  ${vecCount === st.chunks ? '✅ 索引层重建完成，计数一致' : '⚠️ 计数不一致，需排查'}\n`)
}

main()
  .then(async () => {
    try {
      await client?.closeConnection?.()
    } catch {
      /* ignore */
    }
  })
  .catch(async (err) => {
    console.error('\n重建失败：', err)
    try {
      await client?.closeConnection?.()
    } catch {
      /* ignore */
    }
    process.exit(1)
  })
