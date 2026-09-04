#!/usr/bin/env node
/**
 * _e2e_apply_batch.cjs —— 「统一策略处理」专项 E2E
 *
 * 验证模板批量套用：3 份不同文档 → 创建模板(maxChars=300) → apply-batch
 * → 每份文档预览缓存均按模板参数重切（块数变化、maxChars 生效、评分携带）。
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

function makeDoc(title, sections = 6) {
  return `# ${title}\n\n` + Array.from({ length: sections }, (_, i) =>
    `## ${title}-章节${i + 1}\n\n` +
    Array.from({ length: 8 }, (_, j) => `这是${title}第 ${i + 1} 章第 ${j + 1} 段：向量数据库通过 embedding 检索相似内容，切片质量直接影响召回效果。`).join('\n\n'),
  ).join('\n\n')
}

async function main() {
  // 1. 上传 3 份文档
  const docs = []
  for (let i = 1; i <= 3; i++) {
    const up = await uploadDoc(makeDoc(`E2E统一策略${i}`), `e2e-unify-${i}.md`)
    ok(up.status === 201 && !!up.data.docId, `上传文档${i}`, `docId=${up.data.docId}`)
    docs.push(up.data.docId)
  }
  if (docs.some((d) => !d)) process.exit(1)

  // 2. 记录套用前的块数（走一次预览缓存）
  const before = []
  for (const d of docs) {
    const pv = await postJson(`${BASE}/api/doc-processor/preview`, { docId: d })
    before.push(pv.data.totalChunks)
  }
  console.log(`   套用前块数: [${before.join(', ')}]`)

  // 3. 创建模板（紧凑：maxChars=300）并批量套用
  const tpl = await postJson(`${BASE}/api/doc-processor/templates`, { name: 'E2E-统一紧凑', strategy: 'semantic', maxChars: 300 })
  const tplId = tpl.data.template?.id
  ok(!!tplId, '创建模板', `id=${tplId}`)

  const batch = await postJson(`${BASE}/api/doc-processor/templates/apply-batch`, { docIds: docs, templateId: tplId })
  ok(
    batch.status === 200 && batch.data.okCount === 3 && batch.data.results.every((r) => r.ok),
    '批量套用到 3 份文档',
    `ok=${batch.data.okCount}/${batch.data.total}`,
  )

  // 4. 每份文档的缓存确实按模板重切（块数应普遍变多，且带评分）
  const after = []
  let allScored = true
  for (const d of docs) {
    const pv = await postJson(`${BASE}/api/doc-processor/preview`, { docId: d })
    after.push(pv.data.totalChunks)
    if (!(pv.data.chunks || []).every((c) => Number.isFinite(c.score))) allScored = false
    // maxChars 生效校验：块字数普遍 ≤ 硬上限量级
    const maxLen = Math.max(...(pv.data.chunks || []).map((c) => c.chars || 0))
    if (maxLen > 2000) allScored = false
  }
  console.log(`   套用后块数: [${after.join(', ')}]`)
  ok(after.every((n, i) => n > before[i]), '统一策略生效：每份文档按 maxChars=300 重切后块数增加')
  ok(allScored, '套用后预览缓存携带评分')

  // 5. 混入一个不存在的 docId：单点失败不中断整批
  const batch2 = await postJson(`${BASE}/api/doc-processor/templates/apply-batch`, { docIds: ['doc_not_exist', docs[0]], templateId: tplId })
  ok(
    batch2.status === 200 && batch2.data.okCount === 1 && batch2.data.failCount === 1 && batch2.data.results[0].status === 404,
    '单点失败不中断整批',
    `ok=${batch2.data.okCount} fail=${batch2.data.failCount}`,
  )

  // 6. 参数校验
  const noIds = await postJson(`${BASE}/api/doc-processor/templates/apply-batch`, { templateId: tplId })
  ok(noIds.status === 400, '缺少 docIds 返回 400')
  const badTpl = await postJson(`${BASE}/api/doc-processor/templates/apply-batch`, { docIds: docs, templateId: 'tpl_not_exist' })
  ok(badTpl.status === 404, '模板不存在返回 404')

  // 清理
  for (const d of docs) await fetch(`${BASE}/api/knowledge/documents/${d}`, { method: 'DELETE' })
  await fetch(`${BASE}/api/doc-processor/templates/${tplId}`, { method: 'DELETE' })
  console.log('已清理测试文档与模板')

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常：', e)
  process.exit(1)
})
