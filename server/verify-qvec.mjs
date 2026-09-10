// 临时验证脚本：查 Milvus 验证 question_vector 是否独立于 text_vector（验证后删除）
import { MilvusClient } from '@zilliz/milvus2-sdk-node'

const c = new MilvusClient({ address: 'localhost:19530', logLevel: 'error' })

const res = await c.query({
  collection_name: 'kb_chunks',
  filter: 'doc_id == "doc_mtpd50m0_4538g6"',
  output_fields: ['chunk_id', 'idx', 'heading', 'questions', 'text_vector', 'question_vector'],
  limit: 200,
})
const rows = res.data ?? []
console.log('查询到块数:', rows.length)

let withQ = 0
let diffVec = 0
let sameVec = 0
for (const r of rows) {
  const qs = (() => { try { return JSON.parse(r.questions ?? '[]') } catch { return [] } })()
  if (qs.length > 0) withQ++
  const tv = r.text_vector ?? []
  const qv = r.question_vector ?? []
  if (tv.length === qv.length && tv.length > 0) {
    let same = true
    for (let i = 0; i < tv.length; i += 50) { if (Math.abs(tv[i] - qv[i]) > 1e-9) { same = false; break } }
    same ? sameVec++ : diffVec++
  }
}
console.log('含questions的块数:', withQ)
console.log('question_vector 与 text_vector 不同(独立向量):', diffVec)
console.log('question_vector 与 text_vector 相同(退化复制):', sameVec)

const sample = rows.find((r) => { try { return JSON.parse(r.questions ?? '[]').length > 0 } catch { return false } })
if (sample) {
  console.log('\n示例块 idx=' + sample.idx + ' heading=' + sample.heading)
  console.log('questions:', sample.questions)
}
