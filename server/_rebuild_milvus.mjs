/**
 * Milvus 向量库重建脚本（换 embedding 模型后使用，如 nomic-embed-text → bge-m3）
 *
 * 流程：
 *  1. 读取现有 kb_documents 全量行（含 content 与元数据）
 *  2. dropAll() 删除两个集合（旧维度 768）
 *  3. init(embedTexts) 用新模型探测维度并重建集合（bge-m3 = 1024）
 *  4. 逐篇：重新嵌入 title_vector → insertDocument → 重新切片+嵌入切片 → addChunks
 *
 * 用法：node _rebuild_milvus.mjs
 * 注意：会真实 drop 集合，运行前确认 Milvus 容器与 Ollama bge-m3 均就绪。
 */
import './env.js'
import fs from 'node:fs'
import * as milvus from './lib/milvusStore.js'
import * as store from './lib/vectorStore.js'
import { embedTexts } from './lib/embed.js'
import { prepareDocChunksAndVectors } from './lib/docProcessor.js'

async function main() {
  // ① 从本地备份恢复（Milvus 已清空；备份由 _backup_milvus.mjs 在 drop 前导出）
  const raw = await fs.promises.readFile('_backup_docs.json', 'utf8')
  const docs = JSON.parse(raw).map((r) => ({
    id: r.doc_id,
    title: r.title ?? '',
    category: r.category ?? '',
    tags: JSON.parse(r.tags || '[]'),
    size: Number(r.size ?? 0),
    content: r.content ?? '',
    summary: r.summary ?? '',
    source: r.source ?? 'upload',
    status: r.status ?? 'indexed',
    indexError: null,
    uploadedAt: r.uploaded_at ? new Date(Number(r.uploaded_at)).toISOString() : new Date().toISOString(),
    indexedAt: null,
  }))
  if (!docs.length) throw new Error('备份为空')
  const totalChars = docs.reduce((s, d) => s + (d.content || '').length, 0)
  console.log(`[1] 备份读取 ${docs.length} 篇（共 ${totalChars.toLocaleString()} 字）`)

  // ② 新维度初始化（bge-m3 → 1024）
  await milvus.init(embedTexts)
  console.log(`[2] 集合已重建 dim=${milvus.getDim()}`)

  // ④ 逐篇重建（先插文档行使 store 缓存可用，再 load 缓存，再补切片）
  for (const d of docs) {
    const { _titleVector, ...doc } = d
    void _titleVector
    // title 向量重新嵌入（docToRow 只认 length===dim 的数组）
    const [tv] = await embedTexts([doc.title || doc.id])
    doc.title_vector = tv
    await milvus.insertDocument(doc)
    console.log(`    + 文档《${doc.title}》(${(doc.content || '').length} 字)`)
  }

  // 刷新内存缓存，使 store.addChunks 能找到文档
  await store.load()

  for (const d of docs) {
    if (!d.content || !d.content.trim()) continue
    const { chunkList, vectors } = await prepareDocChunksAndVectors(d.content, {})
    await store.addChunks(d.id, chunkList, vectors, { category: d.category, tags: d.tags })
    console.log(`    + 切片 ${chunkList.length} 块（《${d.title}》）`)
  }

  // ⑤ 验证
  const st = store.stats()
  console.log(`\n[5] 重建完成：${st.documents} 篇 / ${st.chunks} 切片`)

  const [qv] = await embedTexts(['多模态是什么'])
  const hits = await store.search(qv, { topK: 3 })
  console.log('检索冒烟（query=多模态是什么）：')
  for (const h of hits) console.log(`    [${(h.score * 100).toFixed(1)}%] ${h.displayTitle || h.title} | ${(h.snippet || '').slice(0, 50)}`)
}

main().catch((e) => {
  console.error('REBUILD FAIL:', e)
  process.exit(1)
})
