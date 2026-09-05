#!/usr/bin/env node
/**
 * _e2e_design_ext.cjs —— 设计文档 §9 扩展功能 E2E 测试
 *
 * 验证：
 *   1. 预览/调整接口返回切片质量评分（score/level/issues + avgScore）
 *   2. 「第N块有问题，请重新处理该块」指令（标记问题块 → split）
 *   3. 处理模板：创建 → 列表 → 套用（按 maxChars 重新切片）→ 同名覆盖 → 删除
 *   4. 批量入库 commit-batch：两份文档一次入库 + 去重统计 + 已入库跳过（409 记为 fail 但不中断）
 *   5. commit-batch 的 opReport 回报（工作流卡片 + 总结文本）
 *   6. 跨文档去重：同一内容上传两份，第二份入库时跨文档去重应跳过绝大部分块
 *
 * 用法：node _e2e_design_ext.cjs   （需后端已运行在 127.0.0.1:3000）
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
  return { status: resp.status, data }
}

async function uploadDoc(text, filename) {
  const fd = new FormData()
  fd.append('file', new Blob([text], { type: 'text/markdown' }), filename)
  const resp = await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })
  const data = await resp.json()
  return { status: resp.status, data }
}

function makeDoc(title) {
  const sections = Array.from({ length: 6 }, (_, i) =>
    `## ${title}-章节${i + 1}\n\n` +
    Array.from({ length: 6 }, (_, j) => `这是${title}第 ${i + 1} 章第 ${j + 1} 段：向量数据库支持相似度检索，适合知识库问答场景。`).join('\n\n'),
  )
  return `# ${title}\n\n${sections.join('\n\n')}`
}

async function main() {
  // ───── 1. 评分 ─────
  const up1 = await uploadDoc(makeDoc('E2E评分文档'), 'e2e-score.md')
  ok(up1.status === 201 && !!up1.data.docId, '上传文档A（评分）', `docId=${up1.data.docId}`)
  const docA = up1.data.docId
  if (!docA) process.exit(1)

  const pv = await postJson(`${BASE}/api/doc-processor/preview`, { docId: docA })
  const pvChunks = pv.data.chunks || []
  const allScored = pvChunks.every((c) => Number.isFinite(c.score) && ['good', 'fair', 'poor'].includes(c.level) && Array.isArray(c.issues))
  ok(pv.status === 200 && pvChunks.length > 0 && allScored, '预览返回逐块评分', `${pvChunks.length} 块 | avgScore=${pv.data.avgScore}`)
  ok(Number.isFinite(pv.data.avgScore) && pv.data.avgScore > 0, '预览返回整体均分', `avgScore=${pv.data.avgScore}`)
  const sample = pvChunks.find((c) => c.score < 100) || pvChunks[0]
  console.log(`   示例块: score=${sample.score} level=${sample.level} issues=[${(sample.issues || []).join('；')}]`)

  // ───── 2. 标记问题块指令 ─────
  const n0 = pvChunks.length
  const adj = await postJson(`${BASE}/api/doc-processor/adjust`, { docId: docA, instruction: '第 1 块有问题，请重新处理该块' })
  ok(
    adj.status === 200 && (adj.data.adjustment || {}).op === 'split' && (adj.data.adjustment || {}).index === 1,
    '标记问题块指令解析为 split',
    `adjustment=${JSON.stringify(adj.data.adjustment)}`,
  )
  ok((adj.data.chunks || []).length === n0 + 1, '问题块被重新拆分', `${n0} → ${(adj.data.chunks || []).length} 块`)
  const adjScored = (adj.data.chunks || []).every((c) => Number.isFinite(c.score))
  ok(adjScored, '调整后返回重新评分的切片')

  // ───── 3. 模板 ─────
  const tplCreate = await postJson(`${BASE}/api/doc-processor/templates`, { name: 'E2E-紧凑切片', strategy: 'semantic', maxChars: 400 })
  ok(tplCreate.status === 200 && !!tplCreate.data.template?.id, '创建模板', `id=${tplCreate.data.template?.id}`)
  const tplId = tplCreate.data.template?.id

  const tplList = await fetch(`${BASE}/api/doc-processor/templates`).then((r) => r.json())
  ok((tplList.templates || []).some((t) => t.id === tplId), '模板列表包含新模板')

  // 套用模板 → 按模板参数重新切片（缓存被替换，块数/均分刷新）
  const apply = await postJson(`${BASE}/api/doc-processor/templates/apply`, { docId: docA, templateId: tplId })
  ok(apply.status === 200 && (apply.data.chunks || []).length > 0 && apply.data.template?.maxChars === 400, '套用模板重新切片', `${apply.data.totalChunks} 块 | avgScore=${apply.data.avgScore}`)
  const pvAfterApply = await postJson(`${BASE}/api/doc-processor/preview`, { docId: docA })
  ok((pvAfterApply.data.chunks || []).length === (apply.data.chunks || []).length, '套用后预览缓存同步')

  // 同名覆盖更新
  const tplUpdate = await postJson(`${BASE}/api/doc-processor/templates`, { name: 'E2E-紧凑切片', strategy: 'semantic', maxChars: 600 })
  ok(tplUpdate.status === 200 && tplUpdate.data.template?.maxChars === 600, '同名模板覆盖更新', `maxChars=${tplUpdate.data.template?.maxChars}`)

  // ───── 4. 批量入库 + 去重 ─────
  // 文档B内容与文档A完全相同 → 批内各自正常，B 的块与已入库的 A 跨文档重复会被去重跳过
  const up2 = await uploadDoc(makeDoc('E2E评分文档'), 'e2e-dup.md')
  const docB = up2.data.docId
  ok(up2.status === 201 && !!docB, '上传文档B（与A同内容，验证跨文档去重）', `docId=${docB}`)

  const batch = await postJson(`${BASE}/api/doc-processor/commit-batch`, { docIds: [docA, docB] })
  const results = batch.data.results || []
  ok(batch.status === 200 && batch.data.okCount === 2, '批量入库两份文档', `ok=${batch.data.okCount} fail=${batch.data.failCount}`)
  const rA = results.find((r) => r.docId === docA)
  const rB = results.find((r) => r.docId === docB)
  ok(rA?.ok && rA.chunkCount > 0, '文档A入库成功（保留调整后切片）', `${rA?.chunkCount} 块`)
  ok(rB?.ok && Number.isFinite(rB.skippedCross), '文档B入库返回去重统计', `块数=${rB?.chunkCount} 跨文档跳过=${rB?.skippedCross}`)

  // 重复批量入库：两份都已入库 → 两个 fail(409)，不中断
  const batch2 = await postJson(`${BASE}/api/doc-processor/commit-batch`, { docIds: [docA, docB] })
  ok(
    batch2.status === 200 && batch2.data.okCount === 0 && batch2.data.failCount === 2 && batch2.data.results.every((r) => r.status === 409),
    '重复批量入库：已入库跳过且不中断',
    `ok=${batch2.data.okCount} fail=${batch2.data.failCount}`,
  )

  // 5) commit-batch 的 opReport 回报
  const reportResp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '批量入库' }],
      agentName: 'doc-processor',
      docId: docA,
      opReport: {
        op: 'commit-batch',
        docId: docA,
        okCount: 2,
        failCount: 0,
        results: [
          { docId: docA, ok: true, chunkCount: rA?.chunkCount },
          { docId: docB, ok: true, chunkCount: rB?.chunkCount },
        ],
      },
    }),
  })
  const raw = await reportResp.text()
  const sid = reportResp.headers.get('x-session-id') || ''
  const annotTypes = []
  for (const line of raw.match(/^2:\[.*\]$/gm) || []) {
    try { annotTypes.push(...JSON.parse(line.slice(2)).map((a) => a?.type)) } catch { /* ignore */ }
  }
  ok(reportResp.status === 200 && /^0:"/m.test(raw) && annotTypes.includes('agent_workflow'), 'commit-batch opReport 回报（卡片+总结）', `注解=[${annotTypes.join(',')}]`)

  // ───── 清理 ─────
  if (sid) await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })
  for (const d of [docA, docB]) {
    const del = await fetch(`${BASE}/api/knowledge/documents/${d}`, { method: 'DELETE' })
    ok(del.status === 200 || del.status === 204, `清理测试文档 ${d}`)
  }
  const tplDel = await fetch(`${BASE}/api/doc-processor/templates/${tplId}`, { method: 'DELETE' })
  ok(tplDel.status === 200 || tplDel.status === 204, '清理测试模板')

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常：', e)
  process.exit(1)
})
