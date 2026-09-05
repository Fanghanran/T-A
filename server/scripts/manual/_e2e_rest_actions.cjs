#!/usr/bin/env node
/**
 * _e2e_rest_actions.cjs —— 底部操作栏 REST 端点 E2E 测试
 *
 * 验证 POST /api/doc-processor/{preview,adjust,commit,export} 全链路：
 *   upload → preview → adjust(合并) → export → commit → commit(409 防重复) → 清理
 * 以及操作完成后的 opReport 回报（POST /api/chat + body.opReport）：
 *   每个操作完成后对话里应出现「卡片注解（2:）+ LLM 简要总结文本（0:）」
 *
 * 用法：node _e2e_rest_actions.cjs   （需后端已运行在 127.0.0.1:3000）
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
  const data = await resp.json().catch(() => ({}))
  return { status: resp.status, data, headers: resp.headers }
}

/**
 * 模拟前端 useChat 的 append：POST /api/chat 带 opReport，
 * 断言返回的 data-stream 里有卡片注解（2:）与总结文本（0:）。
 */
async function chatOpReport(content, opReport, sessionId, expectTool) {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content }],
      agentName: 'doc-processor',
      ...(sessionId ? { sessionId } : {}),
      ...opReport,
    }),
  })
  const raw = await resp.text()
  const sid = resp.headers.get('x-session-id') || sessionId || ''
  const hasText = /^0:"/m.test(raw)
  const hasDone = /^d:/m.test(raw)
  const annotLines = raw.match(/^2:\[.*\]$/gm) || []
  let annotTypes = []
  for (const line of annotLines) {
    try {
      const arr = JSON.parse(line.slice(2))
      annotTypes.push(...arr.map((a) => a?.type))
    } catch { /* 忽略解析失败行 */ }
  }
  const hasCard = annotTypes.includes('search_results') || annotTypes.includes('agent_workflow')
  // preview / adjust 现在与 ReAct 工具同口径：工作流卡片 + 切片卡片都要有
  if ((opReport.opReport.op === 'preview' || opReport.opReport.op === 'adjust')) {
    ok(annotTypes.includes('agent_workflow') && annotTypes.includes('search_results'),
      `opReport（${opReport.opReport.op}）双卡片`, `注解=[${annotTypes.join(',')}]`)
  }
  ok(
    resp.status === 200 && hasText && hasCard && hasDone,
    `opReport 回报（${opReport.opReport.op}）`,
    `注解=[${annotTypes.join(',')}] 文本=${hasText ? '有' : '无'}`,
  )
  if (expectTool && !raw.includes(expectTool)) {
    ok(false, `opReport（${opReport.opReport.op}）工作流卡片应含 ${expectTool}`)
  }
  return sid
}

async function main() {
  // 1) 上传（生成一份多标题长文档，确保切出多块以验证合并/拆分）
  const sections = Array.from({ length: 8 }, (_, i) =>
    `## 章节${i + 1}\n\n` +
    Array.from({ length: 6 }, (_, j) => `这是第 ${i + 1} 章第 ${j + 1} 段：向量数据库支持相似度检索，适合知识库问答场景。`).join('\n\n'),
  )
  const longText = `# E2E 测试文档\n\n${sections.join('\n\n')}`
  const fd = new FormData()
  fd.append('file', new Blob([longText], { type: 'text/markdown' }), 'e2e-rest-actions.md')
  const upResp = await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })
  const up = await upResp.json()
  ok(upResp.status === 201 && !!up.docId, '上传文档', `docId=${up.docId} chars=${up.chars}`)
  if (!up.docId) process.exit(1)
  const docId = up.docId

  try {
    // 2) 预览
    const pv = await postJson(`${BASE}/api/doc-processor/preview`, { docId })
    const chunks = pv.data.chunks || []
    ok(pv.status === 200 && chunks.length > 0, '预览切片', `${chunks.length} 块 / ${pv.data.totalChars} 字`)

    // 2b) opReport（preview）：对话里应出现切片卡片 + 简要总结
    let sid = await chatOpReport('预览切片', { docId, opReport: { op: 'preview', docId } }, '')

    if (chunks.length < 2) {
      console.log('   样例文档块数不足 2，跳过合并调整验证')
    } else {
      // 3) 调整：合并第 1、2 块 → 块数应减 1
      const adj = await postJson(`${BASE}/api/doc-processor/adjust`, { docId, instruction: '合并第1、2块' })
      ok(
        adj.status === 200 && (adj.data.chunks || []).length === chunks.length - 1,
        '调整（合并第1、2块）',
        `${chunks.length} → ${(adj.data.chunks || []).length} 块`,
      )

      // 3b) 预览缓存应包含调整结果（操作栏/对话框共享缓存）
      const pv2 = await postJson(`${BASE}/api/doc-processor/preview`, { docId })
      ok((pv2.data.chunks || []).length === chunks.length - 1, '调整后预览保持一致（共享缓存）')

      // 3c) opReport（adjust）
      sid = await chatOpReport(
        '合并第1、2块',
        { docId, opReport: { op: 'adjust', docId, instruction: '合并第1、2块', totalChunks: adj.data.totalChunks, totalChars: adj.data.totalChars } },
        sid,
      )

      // 4) 导出：markdown 非空 + 文件名
      const ex = await postJson(`${BASE}/api/doc-processor/export`, { docId })
      ok(
        ex.status === 200 && (ex.data.markdown || '').length > 0 && /整理\.md$/.test(ex.data.filename || ''),
        '导出 Markdown',
        `filename=${ex.data.filename} ${ex.data.chunkCount} 块 / ${(ex.data.markdown || '').length} 字`,
      )

      // 4b) opReport（export）：工作流卡片（ExportMarkdown）+ 简要总结
      sid = await chatOpReport('导出', { docId, opReport: { op: 'export', docId } }, sid, 'ExportMarkdown')
    }

    // 5) 入库
    const cm = await postJson(`${BASE}/api/doc-processor/commit`, { docId })
    ok(cm.status === 200 && cm.data.chunkCount > 0, '入库', `${cm.data.chunkCount} 块 / ${cm.data.ms}ms`)

    // 5b) opReport（commit）：工作流卡片（CommitToStore）+ 简要总结（只回报，不重复入库）
    sid = await chatOpReport(
      '入库',
      { docId, opReport: { op: 'commit', docId, chunkCount: cm.data.chunkCount, totalChars: cm.data.totalChars, ms: cm.data.ms } },
      sid,
      'CommitToStore',
    )

    // 6) 重复入库 → 409
    const cm2 = await postJson(`${BASE}/api/doc-processor/commit`, { docId })
    ok(cm2.status === 409, '重复入库返回 409', cm2.data.message || '')

    // 7) 入库后导出仍可用
    const ex2 = await postJson(`${BASE}/api/doc-processor/export`, { docId })
    ok(ex2.status === 200, '入库后仍可导出')

    // 8) 清理会话
    if (sid) {
      const delS = await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })
      ok(delS.status === 200 || delS.status === 204, '清理测试会话', sid)
    }
  } finally {
    // 8) 清理
    const del = await fetch(`${BASE}/api/knowledge/documents/${docId}`, { method: 'DELETE' })
    ok(del.status === 200 || del.status === 204, '清理测试文档')
  }

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常：', e)
  process.exit(1)
})
