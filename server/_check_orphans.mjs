/**
 * _check_orphans.mjs —— 检查/清理 Milvus 中的孤儿切片（docId 已不存在于 kb_documents 的 chunk）。
 * 只读检查：node --env-file-if-exists=.env _check_orphans.mjs
 * 连带清理：node --env-file-if-exists=.env _check_orphans.mjs --clean
 */
import * as milvus from './lib/milvusStore.js'
import { embedTexts } from './lib/embed.js'

await milvus.init(embedTexts)
const docs = await milvus.listAllDocuments()
const chunks = await milvus.listAllChunks()
const docIds = new Set(docs.map((d) => d.id))
const orphans = chunks.filter((c) => !docIds.has(c.docId))
console.log(`文档 ${docs.length} 篇 / 切片 ${chunks.length} 条 / 孤儿切片 ${orphans.length} 条`)
const byDoc = {}
for (const o of orphans) byDoc[o.docId] = (byDoc[o.docId] || 0) + 1
for (const [id, n] of Object.entries(byDoc)) console.log(`  孤儿 docId=${id} → ${n} 条`)

if (process.argv.includes('--clean') && orphans.length) {
  for (const id of Object.keys(byDoc)) {
    await milvus.deleteChunksOfDoc(id)
    console.log(`已清理孤儿切片：docId=${id}（${byDoc[id]} 条）`)
  }
}
process.exit(0)
