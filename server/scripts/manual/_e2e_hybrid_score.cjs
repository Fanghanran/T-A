#!/usr/bin/env node
/**
 * _e2e_hybrid_score.cjs —— 混合评分（启发式 + 向量语义）专项 E2E
 *
 * 构造一份文档，用分隔符模板精确控制块边界，验证两个语义信号：
 *   ① 相邻块高度相似（块1/块2 内容近乎重复）→ 「高度相似」扣分项
 *   ② 块内主题混杂（块3 句子横跨 4 个无关主题）→ 「语义混杂」扣分项
 *   ③ scoreMode === 'hybrid'（真实 embedding 可用时）
 *   ④ 连贯块（块4 同一主题多句）不应出现语义类扣分项
 */
const BASE = 'http://127.0.0.1:3000'
let failures = 0

function ok(cond, label, extra = '') {
  const mark = cond ? '✅' : '❌'
  if (!cond) failures++
  console.log(`${mark} ${label}${extra ? ` | ${extra}` : ''}`)
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: resp.status, data: await resp.json().catch(() => ({})) }
}

async function uploadDoc(text, filename) {
  const fd = new FormData()
  fd.append('file', new Blob([text], { type: 'text/markdown' }), filename)
  const resp = await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })
  return { status: resp.status, data: await resp.json().catch(() => ({})) }
}

const milvusSentences = [
  'Milvus 是一款开源的向量数据库，专为海量向量检索而设计。',
  '它支持多种索引类型与距离度量，能够高效完成相似度检索。',
  '在知识库问答场景中，Milvus 常用于存储文档切片的 embedding 向量。',
  '其云原生架构支持存储与计算分离，可水平扩展到十亿级向量规模。',
]

const doc = [
  '# 混合评分测试',
  '',
  '## 块1：Milvus 介绍（连贯主题）',
  milvusSentences.join(''),
  '',
  '---',
  '',
  '## 块2：与块1近乎重复（验证相邻相似扣分）',
  // 与块1高度相似：句子结构一致、仅个别词不同 → cos 应 ≥ 0.9
  milvusSentences.join('').replace(/Milvus/g, 'Milvus 数据库'),
  '',
  '---',
  '',
  '## 块3：主题混杂（验证块内一致性扣分）',
  // 四句分属四个互不相关主题 → 句间平均 cos 应 < 0.4
  '快速排序的平均时间复杂度是 O(n log n)，核心操作是分区的原地交换。',
  '宋代汝窑天青釉瓷器存世极少，被历代收藏家视为珍品。',
  'CAP 定理指出分布式系统无法同时满足一致性与可用性。',
  '植物通过光合作用把二氧化碳和水转化为葡萄糖和氧气。',
  '',
  '---',
  '',
  '## 块4：Raft 算法（连贯主题，对照组）',
  'Raft 是一种易于理解的一致性共识算法。',
  '它把节点划分为领导者、跟随者与候选者三种角色。',
  '通过领导者选举与日志复制保证集群状态机的一致性。',
  '相比 Paxos，Raft 的设计更侧重可理解性与工程可实现性。',
].join('\n')

async function main() {
  const up = await uploadDoc(doc, 'e2e-hybrid-score.md')
  ok(up.status === 201 && !!up.data.docId, '上传测试文档', `docId=${up.data.docId}`)
  const docId = up.data.docId
  if (!docId) process.exit(1)

  // 用分隔符模板精确控制：每个 '---' 分隔块 = 一个 chunk
  const tpl = await postJson(`${BASE}/api/doc-processor/templates`, { name: 'E2E-分隔符评分', strategy: 'delimiter', delimiter: '---' })
  const tplId = tpl.data.template?.id
  ok(!!tplId, '创建分隔符模板')

  const apply = await postJson(`${BASE}/api/doc-processor/templates/apply`, { docId, templateId: tplId })
  const chunks = apply.data.chunks || []
  ok(apply.status === 200 && chunks.length >= 4, '按分隔符切出 4 块', `实际 ${chunks.length} 块`)
  ok(apply.data.scoreMode === 'hybrid', 'scoreMode = hybrid（真实 embedding 生效）', `scoreMode=${apply.data.scoreMode}`)
  if (chunks.length < 4) {
    console.log(JSON.stringify(chunks.map((c) => c.heading || c.text?.slice(0, 20)), null, 2))
    process.exit(1)
  }

  // 块序可能含首部（标题+块1），找出对应块
  const findChunk = (kw) => chunks.find((c) => (c.text || '').includes(kw))
  const c1 = findChunk('专为海量向量检索')
  const c3 = findChunk('快速排序')
  const c4 = findChunk('Raft 是一种')

  // ① 相邻高度相似扣分
  const dupIssues = [...(c1?.issues || []), ...(chunks.find((c) => (c.text || '').includes('与块1近乎重复') || (c.text || '').includes('Milvus 数据库'))?.issues || [])]
  ok(
    dupIssues.some((s) => s.includes('高度相似')),
    '相邻块近乎重复 → 「高度相似」扣分项',
    dupIssues.filter((s) => s.includes('高度相似')).join('；') || '未见',
  )

  // ② 块内主题混杂扣分
  ok(
    (c3?.issues || []).some((s) => s.includes('语义混杂')),
    '块内四个无关主题 → 「语义混杂」扣分项',
    (c3?.issues || []).filter((s) => s.includes('语义混杂')).join('；') || '未见',
  )

  // ③ 对照组：连贯块无语义类扣分（只有结构类的「无上下文锚点」等）
  const semanticIssues = (c4?.issues || []).filter((s) => s.includes('高度相似') || s.includes('语义混杂'))
  ok(semanticIssues.length === 0, '连贯主题块无语义扣分项（对照组）', semanticIssues.join('；') || '干净')

  // ④ 混杂块分数应低于连贯块
  ok(
    Number.isFinite(c3?.score) && Number.isFinite(c4?.score) && c3.score < c4.score,
    '混杂块评分 < 连贯块评分',
    `块3=${c3?.score} vs 块4=${c4?.score}`,
  )

  console.log(`\n各块评分：${chunks.map((c, i) => `${i + 1}:[${(c.heading || '').slice(0, 12)}]=${c.score}`).join('  ')}`)

  // 清理
  await fetch(`${BASE}/api/knowledge/documents/${docId}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/doc-processor/templates/${tplId}`, { method: 'DELETE' })
  console.log('已清理测试文档与模板')

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常：', e)
  process.exit(1)
})
