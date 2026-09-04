/**
 * 工作流卡片注解验证：docAgent 每步工具调用应发一条 agent_workflow 注解（2: 行）
 * ① 上传 + "请分析这份文档" → 断言注解含 AnalyzeDocument（含 label/args/observation/ms），且以 FINISH 收尾
 * ② "入库" → 断言含 CommitToStore 步骤
 * ③ 清理
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
  const annots = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('0:')) texts.push(JSON.parse(line.slice(2)))
    else if (line.startsWith('2:')) annots.push(...JSON.parse(line.slice(2)))
  }
  return { sid, text: texts.join(''), annots }
}

async function main() {
  const fd = new FormData()
  const content = '# 工作流卡片测试\n\n## 第一节\n\n' + '工作流注解验证内容。'.repeat(25) + '\n\n## 第二节\n\n' + '第二节内容。'.repeat(25)
  fd.append('file', new Blob([content]), 'wf-card-test.md')
  const up = await (await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })).json()
  console.log(`[0] 上传 OK docId=${up.docId}`)

  // ① 分析轮
  const r1 = await chat('请分析这份文档', up.docId)
  const wf1 = r1.annots.filter((a) => a.type === 'agent_workflow')
  const tools1 = wf1.map((a) => a.tool)
  console.log(`[1] 分析轮注解：agent_workflow ${wf1.length} 条 → 工具序列 [${tools1.join(' → ')}]`)
  if (!tools1.includes('AnalyzeDocument')) throw new Error('缺少 AnalyzeDocument 工具注解')
  if (!tools1.includes('FINISH')) throw new Error('缺少 FINISH 终态注解（时间线未闭合）')
  const analyze = wf1.find((a) => a.tool === 'AnalyzeDocument')
  if (!analyze.label || !analyze.observation || typeof analyze.ms !== 'number') {
    throw new Error(`AnalyzeDocument 注解字段不全: ${JSON.stringify(analyze).slice(0, 200)}`)
  }
  console.log(`    AnalyzeDocument: label="${analyze.label}" | ${analyze.ms}ms | 观察摘要: ${analyze.observation.slice(0, 60)}…`)
  const searchAnnots = r1.annots.filter((a) => a.type === 'search_results')
  console.log(`    同轮 search_results（切片卡片）: ${searchAnnots.length} 条`)

  // ② 入库轮
  const hBefore = await (await fetch(`${BASE}/api/health`)).json()
  const r2 = await chat('入库', up.docId, r1.sid)
  const hAfter = await (await fetch(`${BASE}/api/health`)).json()
  const wf2 = r2.annots.filter((a) => a.type === 'agent_workflow')
  const tools2 = wf2.map((a) => a.tool)
  console.log(`[2] 入库轮注解：agent_workflow ${wf2.length} 条 → 工具序列 [${tools2.join(' → ')}]`)
  if (!tools2.includes('CommitToStore')) throw new Error('缺少 CommitToStore 工具注解')
  if (hAfter.chunks <= hBefore.chunks) throw new Error('入库未生效')
  console.log(`    CommitToStore 已执行，块数 ${hBefore.chunks} → ${hAfter.chunks} ✅`)

  // ③ 清理
  await fetch(`${BASE}/api/knowledge/documents/${up.docId}`, { method: 'DELETE' })
  if (r1.sid) await fetch(`${BASE}/api/sessions/${r1.sid}`, { method: 'DELETE' })
  console.log('[3] 测试数据已清理')
  console.log('\n=== WORKFLOW ANNOTATION PASS ===')
}

main().catch((e) => {
  console.error('E2E FAIL:', e.message)
  process.exit(1)
})
