#!/usr/bin/env node
/**
 * e2e-main-flow —— 主链路端到端测试（上传 → 入库 → 检索 → 问答 → 清理）
 *
 * 需要一个已启动的后端（默认 http://localhost:3000，可用 E2E_BASE_URL 覆盖）
 * 以及可达的 Milvus / Ollama。全部断言通过退出码 0，任一失败退出码 1。
 *
 * 用法：
 *   node scripts/e2e-main-flow.mjs
 *   E2E_BASE_URL=http://localhost:3001 node scripts/e2e-main-flow.mjs
 *
 * 流程（复刻前端真实操作序列，走两段式上传）：
 *   1) POST /api/knowledge/documents/prepare   上传 md（Q&A 格式，问题路可解析）
 *   2) POST /api/knowledge/documents/commit    异步入库 → 轮询 jobs/:id 至 done
 *   3) GET  /api/knowledge/documents/:id/chunks 切片落库校验
 *   4) POST /api/search/query                  语义检索，断言 top1 命中本文档
 *   5) POST /api/knowledge/ask                 RAG 流式问答，断言答案非空 + 注解携带命中
 *   6) DELETE /api/knowledge/documents/:id     清理测试数据（失败也会在 finally 执行）
 */

const BASE = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
// 唯一标记：内容哈希去重（409）与检索断言都靠它区分不同轮次
const MARK = `e2e${Date.now().toString(36)}`
const TITLE = `E2E主链路测试-${MARK}.md`
const DOC_TEXT = [
  `# ${MARK} 内部测试文档`,
  '',
  `问：什么是 ${MARK} 协议？`,
  `答：${MARK} 协议是端到端测试专用的虚拟通信协议，工作在传输层之上，采用三阶段握手建立连接，默认端口 47${MARK.length}9，最大报文长度 2048 字节。`,
  '',
  `问：${MARK} 协议如何保证可靠性？`,
  `答：${MARK} 协议通过序列号确认重传机制保证可靠性：发送方为每个报文分配递增序列号，接收方逐序确认，超时未确认则重传，连续三次重传失败断开连接。`,
  '',
  `问：${MARK} 协议和 TCP 的区别是什么？`,
  `答：${MARK} 协议面向测试场景设计，省去了拥塞控制与流量控制，握手阶段更短；TCP 面向通用可靠传输，拥塞控制完备但握手开销更大。`,
  '',
].join('\n')

let docId = null
const results = []
function step(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`)
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function main() {
  console.log(`E2E 主链路测试 → ${BASE}（标记 ${MARK}）`)

  // ---- 1) prepare：上传 + 抽文本 + 切片预览 ----
  const fd = new FormData()
  fd.append('file', new Blob([DOC_TEXT], { type: 'text/markdown' }), TITLE)
  const prepRes = await fetch(`${BASE}/api/knowledge/documents/prepare`, {
    method: 'POST',
    body: fd,
  })
  const prep = await prepRes.json().catch(() => null)
  if (prepRes.status !== 200 || !prep?.previewId) {
    step('prepare 上传预览', false, `status=${prepRes.status} ${JSON.stringify(prep)?.slice(0, 200)}`)
    return
  }
  step('prepare 上传预览', true, `previewId=${prep.previewId} chunks=${prep.chunkCount} avgScore=${prep.avgScore}`)
  if (!Number.isFinite(prep.chunkCount) || prep.chunkCount < 1) {
    step('prepare 切片数', false, `chunkCount=${prep.chunkCount}`)
    return
  }
  step('prepare 切片数', true, `${prep.chunkCount} 块`)

  // ---- 2) commit：异步入库 + 轮询任务 ----
  const commit = await api('/api/knowledge/documents/commit', {
    method: 'POST',
    body: JSON.stringify({ previewId: prep.previewId, category: 'E2E测试', tags: ['e2e'], withQuestions: false, async: true }),
  })
  if (commit.status !== 202 || !commit.body?.jobId) {
    step('commit 提交任务', false, `status=${commit.status} ${JSON.stringify(commit.body)?.slice(0, 200)}`)
    return
  }
  step('commit 提交任务', true, `jobId=${commit.body.jobId}`)

  let job = null
  const deadline = Date.now() + 180000 // 入库含 embedding，本地模型可能较慢
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const j = await api(`/api/knowledge/documents/jobs/${commit.body.jobId}`)
    job = j.body
    if (j.status !== 200 || job?.stage === 'done' || job?.stage === 'error') break
  }
  if (job?.stage !== 'done' || !job?.doc?.id) {
    step('commit 入库完成', false, `stage=${job?.stage} error=${job?.error}`)
    return
  }
  docId = job.doc.id
  step('commit 入库完成', true, `docId=${docId} chunks=${job.chunkCount}`)

  // ---- 3) 切片落库校验 ----
  const chunksRes = await api(`/api/knowledge/documents/${docId}/chunks`)
  const chunkList = chunksRes.body?.items || []
  if (chunksRes.status !== 200 || !Array.isArray(chunkList) || chunkList.length === 0) {
    step('切片落库校验', false, `status=${chunksRes.status} total=${chunksRes.body?.total}`)
    return
  }
  step('切片落库校验', true, `${chunkList.length} 块`)

  // ---- 4) 语义检索：断言 top1 命中本文档 ----
  const search = await api('/api/search/query', {
    method: 'POST',
    body: JSON.stringify({ q: `${MARK} 协议如何保证可靠性`, scope: 'knowledge', topK: 3 }),
  })
  const items = search.body?.knowledgeResults?.items || []
  const top = items[0]
  if (search.status !== 200 || !top || top.docId !== docId || !(top.score > 0.5)) {
    step('语义检索命中', false, `top1=${top ? `${top.docId}/${top.score}` : '无'}（期望 docId=${docId} 且 score>0.5）`)
    return
  }
  step('语义检索命中', true, `top1 score=${top.score}`)

  // ---- 5) RAG 流式问答：断言答案非空 + 注解携带命中 ----
  const askRes = await fetch(`${BASE}/api/knowledge/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `什么是${MARK}协议？` }),
  })
  if (askRes.status !== 200) {
    step('RAG 流式问答', false, `status=${askRes.status}`)
    return
  }
  const raw = await askRes.text()
  let answer = ''
  const annots = [] // 2: 行是注解对象数组（AI SDK message annotations），可能多行多次推送
  for (const line of raw.split('\n')) {
    if (line.startsWith('0:')) {
      try { answer += JSON.parse(line.slice(2)) } catch { /* 跳过非法分片 */ }
    } else if (line.startsWith('2:')) {
      try { annots.push(...[].concat(JSON.parse(line.slice(2)))) } catch { /* 跳过 */ }
    }
  }
  const hitAnnot = annots.find((a) => Array.isArray(a?.results) && a.results.some((r) => r.docId === docId))
  if (!answer.trim() || !hitAnnot) {
    step('RAG 流式问答', false, `answer=${answer.length}字 注解命中=${Boolean(hitAnnot)}`)
    return
  }
  step('RAG 流式问答', true, `答案 ${answer.length} 字，注解命中 ${hitAnnot.results.length} 条`)

  // 顺带断言：答案正文中不应复述命中元数据（文件名/相似度），只做弱校验（不含文档标题）
  const noLeak = !answer.includes(TITLE)
  step('答案不含元数据泄漏', noLeak, noLeak ? '正文未出现文件名' : '正文出现文件名')
}

main()
  .catch((err) => {
    step('执行异常', false, err.message)
  })
  .finally(async () => {
    // ---- 6) 清理：无论成败都删除测试文档，不留脏数据 ----
    if (docId) {
      try {
        const del = await api(`/api/knowledge/documents/${docId}`, { method: 'DELETE' })
        // 删除成功返回 200（带统计体）或 204（无内容），均为成功
        step('清理测试文档', del.status === 200 || del.status === 204, `docId=${docId} status=${del.status}`)
      } catch (err) {
        step('清理测试文档', false, err.message)
      }
    }
    const failed = results.filter((r) => !r.ok)
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) {
      console.log('失败步骤：', failed.map((f) => f.name).join('、'))
      process.exit(1)
    }
    process.exit(0)
  })
