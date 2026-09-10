// 诊断脚本：直接调用 prepareDocChunksAndVectors 检查 questionVectors 是否生成（验证后删除）
import { prepareDocChunksAndVectors } from './lib/docProcessor.js'
import * as models from './lib/models.js'

// 初始化模型配置（模拟服务启动路径）
try {
  if (typeof models.initModelProfiles === 'function') await models.initModelProfiles()
} catch (e) {
  console.log('initModelProfiles 跳过:', e.message)
}

const text = `问：什么是RAG？

答：RAG是检索增强生成，先检索知识库再生成答案。

问：什么是LoRA？

答：LoRA是低秩适配，一种高效的微调方法。`

const r = await prepareDocChunksAndVectors(text, { withQuestions: true })
console.log('块数:', r.chunkList.length)
console.log('questions[0]:', JSON.stringify(r.chunkList[0]?.questions))
console.log('questionVectors 类型:', Array.isArray(r.questionVectors) ? 'Array' : typeof r.questionVectors)
if (Array.isArray(r.questionVectors)) {
  console.log('questionVectors 长度:', r.questionVectors.length)
  r.questionVectors.forEach((qv, i) => {
    console.log(`  [${i}] ${Array.isArray(qv) ? 'vec(' + qv.length + '维) 前3值=' + qv.slice(0, 3).map(v => v.toFixed(4)).join(',') : 'null'}`)
  })
  const tv0 = r.vectors[0]
  const qv0 = r.questionVectors[0]
  if (Array.isArray(tv0) && Array.isArray(qv0)) {
    let same = true
    for (let i = 0; i < Math.min(tv0.length, qv0.length); i++) if (Math.abs(tv0[i] - qv0[i]) > 1e-9) { same = false; break }
    console.log('块0 text向量 vs question向量 相同?', same)
  }
} else {
  console.log('!! questionVectors 未生成（null）—— 生成侧问题')
}
console.log('vectors[0] 维度:', Array.isArray(r.vectors[0]) ? r.vectors[0].length : '无')
