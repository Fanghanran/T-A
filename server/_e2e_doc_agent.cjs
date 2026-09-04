/**
 * docAgent E2E 冒烟：真实 LLM（Ollama qwen2.5-coder）下验证 ReAct 工作流
 * 用法：node _e2e_doc_agent.cjs
 * 流程：上传 sample-notes.md → 对话「分析并预览」→ 期望 Agent 自主调用
 *       AnalyzeDocument + PreviewChunks（流中含切片预览与 2: 注解）。
 */
const fs = require('node:fs')
const path = require('node:path')

const BASE = process.env.BASE || 'http://127.0.0.1:3000'

async function main() {
  // ① 上传
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'sample-notes.md'))]), 'agent-test.md')
  const up = await fetch(`${BASE}/api/doc-processor/upload`, { method: 'POST', body: fd })
  const upJson = await up.json()
  if (!up.ok) throw new Error(`上传失败: ${JSON.stringify(upJson)}`)
  console.log(`[1] 上传 OK docId=${upJson.docId} chars=${upJson.chars}`)

  // ② 对话：分析并预览（Agent 应自主调用 AnalyzeDocument + PreviewChunks）
  const t0 = Date.now()
  const chat = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', content: '请分析这份文档并预览切片' }],
      agentName: 'doc-processor',
      docId: upJson.docId,
    }),
  })
  const sid = chat.headers.get('x-session-id')
  const raw = await chat.text()
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  // 解析 data-stream
  const texts = []
  const annotations = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('0:')) texts.push(JSON.parse(line.slice(2)))
    else if (line.startsWith('2:')) annotations.push(...JSON.parse(line.slice(2)))
  }
  const full = texts.join('')
  console.log(`[2] 对话完成 ${secs}s | x-session-id=${sid}`)
  console.log('--- 流式文本（前 900 字）---')
  console.log(full.slice(0, 900))
  const docAnnot = annotations.filter((a) => a?.engine === 'doc-processor')
  console.log(`--- 注解: ${docAnnot.length} 条 doc-processor | 总块数=${docAnnot[0]?.total ?? '无'} ---`)
  console.log(`--- 会话持久化 sid=${sid} ---`)

  const pass =
    full.includes('收到文档') && full.includes('切片预览') && docAnnot.length > 0 && docAnnot[0]?.total > 0
  console.log(pass ? '\n=== E2E PASS ===' : '\n=== E2E FAIL ===')
  if (!pass) process.exitCode = 1
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exitCode = 1
})
