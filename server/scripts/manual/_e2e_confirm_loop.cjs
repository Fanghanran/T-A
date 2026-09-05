/**
 * 确认循环故障验证：复现"入库 → 反问确认 → 确认 → 再反问"死循环
 * ① 上传文档 → "请分析这份文档"（建立预览缓存）
 * ② 同会话说"入库" → 断言真正入库（块数增加且回复含"入库成功"），而不是再次反问确认
 * ③ 新文档 → 分析 → 说"确认" → 断言同样直接入库
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000'

async function chat(content, docId, sessionId) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: `u_${Date.now()}`, role: 'user', content }],
      agentName: 'doc-processor',
      ...(docId ? { docId } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  })
  const sid = r.headers.get('x-session-id')
  const raw = await r.text()
  const texts = []
  for (const line of raw.split('\n')) if (line.startsWith('0:')) texts.push(JSON.parse(line.slice(2)))
  return { sid, text: texts.join('') }
}

async function health() {
  const h = await (await fetch(`${BASE}/api/health`)).json()
  return { docs: h.documents, chunks: h.chunks }
}

async function uploadDoc(tag) {
  const fd = new FormData()
  const content = `# ${tag}\n\n## 第一节\n\n${'确认循环测试内容。'.repeat(25)}\n\n## 第二节\n\n${'第二节内容，用于切块。'.repeat(25)}`
  fd.append('file', new Blob([content]), `${tag}.md`)
  const up = await (await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })).json()
  return up.docId
}

async function main() {
  // ── 场景 A：分析后说"入库" ──
  const docA = await uploadDoc('confirm-loop-a')
  console.log(`[A0] 上传 OK docId=${docA}`)
  const rA1 = await chat('请分析这份文档', docA)
  console.log(`[A1] 分析 → ${rA1.text.replace(/\n+/g, ' ').slice(0, 80)}…`)
  const before = await health()
  const rA2 = await chat('入库', docA, rA1.sid)
  const afterA = await health()
  const committedA = afterA.chunks > before.chunks
  console.log(`[A2] "入库" → 块数 ${before.chunks}→${afterA.chunks}（${committedA ? '已入库 ✅' : '未入库 ❌'}）`)
  console.log(`     回复片段: ${rA2.text.replace(/\n+/g, ' ').slice(0, 120)}`)
  if (!committedA) throw new Error('场景A失败：说"入库"后未执行入库')
  if (!/入库成功/.test(rA2.text)) throw new Error('场景A失败：回复中缺少"入库成功"确认')

  // ── 场景 B：分析后说"确认" ──
  const docB = await uploadDoc('confirm-loop-b')
  console.log(`[B0] 上传 OK docId=${docB}`)
  const rB1 = await chat('请分析这份文档', docB)
  const beforeB = await health()
  const rB2 = await chat('确认', docB, rB1.sid)
  const afterB = await health()
  const committedB = afterB.chunks > beforeB.chunks
  console.log(`[B2] "确认" → 块数 ${beforeB.chunks}→${afterB.chunks}（${committedB ? '已入库 ✅' : '未入库 ❌'}）`)
  console.log(`     回复片段: ${rB2.text.replace(/\n+/g, ' ').slice(0, 120)}`)
  if (!committedB) throw new Error('场景B失败：说"确认"后未执行入库')

  // 清理
  await fetch(`${BASE}/api/knowledge/documents/${docA}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/knowledge/documents/${docB}`, { method: 'DELETE' })
  for (const sid of [rA1.sid, rB1.sid]) if (sid) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })
  console.log('[C] 测试数据已清理')
  console.log('\n=== CONFIRM LOOP PASS ===')
}

main().catch((e) => {
  console.error('E2E FAIL:', e.message)
  process.exit(1)
})
