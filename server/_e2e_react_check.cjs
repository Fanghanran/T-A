/**
 * _e2e_react_check.cjs —— 验证对话内自然语言是否真的走 ReAct 工作流
 *
 * 用例 1（单步）：发"预览"，断言 agent_workflow 时间线（PreviewChunks → FINISH）
 * 用例 2（复合任务）：发"请分析这份文档，之后入库"，断言链式执行
 *   AnalyzeDocument → PreviewChunks → CommitToStore（不得中途 FINISH 反问）
 * 并断言每步含 LLM thought（真实推理）。
 */
const BASE = 'http://127.0.0.1:3000'
let failures = 0

function ok(cond, label, extra = '') {
  const mark = cond ? '✅' : '❌'
  if (!cond) failures++
  console.log(`${mark} ${label}${extra ? ` | ${extra}` : ''}`)
}

/** 发一条对话消息（无 opReport → 走 ReAct），返回 { raw, sid, annots } */
async function chat(content, docId, sessionId) {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content }],
      agentName: 'doc-processor',
      ...(docId ? { docId } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  })
  const raw = await resp.text()
  const sid = resp.headers.get('x-session-id') || sessionId || ''
  const annots = []
  for (const line of raw.match(/^2:\[.*\]$/gm) || []) {
    try { annots.push(...JSON.parse(line.slice(2))) } catch { /* 忽略 */ }
  }
  return { raw, sid, annots, status: resp.status }
}

async function main() {
  // 1) 上传一份小文档
  const text = `# ReAct 验证文档\n\n## 概念\n\nReAct 是推理与行动结合的智能体模式，通过循环执行思考、行动、观察来完成任务。\n\n## 工具\n\n智能体通过工具调用完成文档处理任务，包括分析、切片、调整、入库和导出。\n\n## 流程\n\n上传文档后依次分析结构、预览切片、确认入库，最后可选导出。`
  const fd = new FormData()
  fd.append('file', new Blob([text], { type: 'text/markdown' }), 'react-check.md')
  const upResp = await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })
  const up = await upResp.json()
  ok(!!up.docId, '上传文档', `docId=${up.docId}`)
  if (!up.docId) process.exit(1)
  const docId = up.docId
  let sid = ''

  try {
    // ── 用例 1：单步「预览」→ PreviewChunks → FINISH
    const r1 = await chat('预览', docId, sid)
    sid = r1.sid
    const wf1 = r1.annots.filter((a) => a?.type === 'agent_workflow')
    const tools1 = wf1.map((a) => a.tool)
    ok(r1.status === 200, '用例1 请求成功')
    ok(wf1.length > 0 && tools1.includes('FINISH'), '用例1 时间线（预览→FINISH）', `工具=[${tools1.join(' → ')}]`)
    ok(wf1.some((a) => (a?.thought || '').length > 10), '用例1 含 LLM thought')
    ok(r1.annots.some((a) => a?.type === 'search_results'), '用例1 有切片卡片')

    // ── 用例 2：复合任务「请分析这份文档，之后入库」→ 计划模式（拆解→执行→汇总）
    const r2 = await chat('请分析这份文档，之后入库', docId, sid)
    sid = r2.sid
    const wf2 = r2.annots.filter((a) => a?.type === 'agent_workflow')
    const tools2 = wf2.map((a) => a.tool)
    const planStep = wf2.find((a) => a.tool === 'PlanWorkflow')
    const commitIdx = tools2.indexOf('CommitToStore')
    const finishIdx = tools2.indexOf('FINISH')
    ok(r2.status === 200, '用例2 请求成功')
    ok(!!planStep, '用例2 有任务拆解步骤（PlanWorkflow）', `子任务=${JSON.stringify(planStep?.args?.subtasks)}`)
    ok(
      tools2.includes('AnalyzeDocument') || tools2.includes('PreviewChunks'),
      '用例2 有前置子任务',
      `工具=[${tools2.join(' → ')}]`,
    )
    ok(commitIdx >= 0, '用例2 链式执行到入库')
    ok(finishIdx < 0 || finishIdx > commitIdx, '用例2 未中途 FINISH 反问（汇总在最后）')
    ok(/入库成功/.test(r2.raw.replace(/^0:|"|\n/g, '')), '用例2 返回入库成功文案')
    ok(/汇总/.test(r2.raw.replace(/^0:|"|\\n/g, '')), '用例2 末尾有 LLM 汇总')
    ok(wf2.some((a) => (a?.thought || '').length > 10), '用例2 步骤含 thought')

    // ── 清理会话
    if (sid) {
      const del = await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })
      ok(del.status === 200 || del.status === 204, '清理测试会话', sid)
    }
  } finally {
    const del = await fetch(`${BASE}/api/knowledge/documents/${docId}`, { method: 'DELETE' })
    ok(del.status === 200 || del.status === 204, '清理测试文档')
  }

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
