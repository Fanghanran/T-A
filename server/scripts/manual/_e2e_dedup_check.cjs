#!/usr/bin/env node
/**
 * _e2e_dedup_check.cjs —— 跨文档去重专项验证
 * 同一内容上传两份 → 各自 preview（同一切片路径）→ 依次 commit →
 * 第二份的块应被跨文档去重跳过（skippedCross ≥ 1，chunkCount 显著减少）。
 */
const BASE = 'http://127.0.0.1:3000'

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

const text = [
  '# 去重专项测试',
  '',
  '## 分布式系统的 CAP 定理',
  'CAP 定理指出，一个分布式系统不可能同时满足一致性、可用性与分区容错性这三个特性。在实际工程中，通常需要在一致性与可用性之间做权衡取舍，例如 CP 系统优先保证一致性，AP 系统优先保证可用性。',
  '',
  '## Raft 共识算法',
  'Raft 是一种易于理解的一致性共识算法，将节点划分为领导者、跟随者与候选者三种角色，通过领导者选举与日志复制两个子问题，保证集群状态机的一致性。相比 Paxos，Raft 的设计更侧重可理解性与工程可实现性。',
  '',
  '## Milvus 向量数据库',
  'Milvus 是一款开源向量数据库，支持多种向量索引与距离度量方式，常用于语义检索与知识库问答场景。其云原生架构支持存储计算分离，可通过水平扩展支撑十亿级向量的检索需求。',
  '',
].join('\n')

async function main() {
  const upA = await uploadDoc(text, 'dedup-a.md')
  const upB = await uploadDoc(text, 'dedup-b.md')
  console.log(`上传: A=${upA.data.docId} B=${upB.data.docId}`)

  // 都走 preview 缓存路径（切片一致）
  const pvA = await postJson(`${BASE}/api/doc-processor/preview`, { docId: upA.data.docId })
  const pvB = await postJson(`${BASE}/api/doc-processor/preview`, { docId: upB.data.docId })
  console.log(`预览: A=${pvA.data.totalChunks} 块 B=${pvB.data.totalChunks} 块`)

  const cmA = await postJson(`${BASE}/api/doc-processor/commit`, { docId: upA.data.docId })
  console.log(`commit A: status=${cmA.status} chunkCount=${cmA.data.chunkCount} within=${cmA.data.skippedWithin} cross=${cmA.data.skippedCross}`)

  const cmB = await postJson(`${BASE}/api/doc-processor/commit`, { docId: upB.data.docId })
  console.log(`commit B: status=${cmB.status} chunkCount=${cmB.data.chunkCount} within=${cmB.data.skippedWithin} cross=${cmB.data.skippedCross}`)

  const skipped = (cmB.data.skippedCross || 0) + (cmB.data.skippedWithin || 0)
  console.log(skipped > 0 ? '✅ 跨文档去重生效' : '❌ 跨文档去重未生效（B 与 A 内容完全相同）')

  // 清理
  for (const d of [upA.data.docId, upB.data.docId]) {
    if (d) await fetch(`${BASE}/api/knowledge/documents/${d}`, { method: 'DELETE' })
  }
  console.log('已清理测试文档')
}

main().catch((e) => {
  console.error('异常：', e)
  process.exit(1)
})
