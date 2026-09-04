#!/usr/bin/env node
/**
 * 管理模块 E2E：/api/management/* 端点验证（重构：工具/工作流注册表 + 启停 + 持久化）
 *
 * 验证链路：
 *  1. GET  /overview          工具5个 + 工作流2个（doc-react / doc-plan），全部默认启用
 *  2. GET  /tools /workflows  列表含 enabled 状态、run 函数已剥离（hasRunner）
 *  3. PATCH /tools/:name      禁用 ExportMarkdown → 列表状态翻转
 *  4. PATCH /workflows/:name  禁用 doc-react → 单任务聊天回退关键词路由（无 agent_workflow 注解）
 *  4b. 复合任务分发：doc-plan 启用时复合消息出现 PlanWorkflow 注解（拆分后的独立计划工作流）
 *  5. 持久化：data/management/registry.json 写入禁用项
 *  6. 异常分支：未注册名 404、缺 enabled 字段 400
 *  7. 清理：恢复全部启用（overrides 清空）
 */
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000'
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`❌ ${msg}`)
    process.exit(1)
  }
  console.log(`✅ ${msg}`)
}

async function json(method, path, body) {
  const resp = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await resp.json().catch(() => ({}))
  return { status: resp.status, data }
}

async function main() {
  console.log(`== 管理模块 E2E（${BASE}）==\n`)

  // 1. 总览
  {
    const { status, data } = await json('GET', '/api/management/overview')
    assert(status === 200, `GET /overview → 200`)
    const tools = data.tools?.items ?? []
    const wfs = data.workflows?.items ?? []
    assert(tools.length === 5, `工具注册 5 个（实际 ${tools.length}）：${tools.map((t) => t.name).join(', ')}`)
    const wfNames = wfs.map((w) => w.name).sort().join(',')
    assert(wfs.length === 2 && wfNames === 'doc-plan,doc-react', `工作流注册 2 个（实际 ${wfs.length}）：${wfNames}`)
    assert(tools.every((t) => t.enabled), '工具全部默认启用')
    assert(wfs.every((w) => w.enabled), '工作流全部默认启用')
    assert(tools.every((t) => typeof t.run !== 'function' && t.hasRunner === true), 'run 函数已剥离（hasRunner 标识）')
    assert(typeof tools.find((t) => t.name === 'AdjustChunks')?.params === 'string', '工具元数据含 params 说明')
  }

  // 2. 独立列表
  {
    const t = await json('GET', '/api/management/tools')
    const w = await json('GET', '/api/management/workflows')
    assert(t.status === 200 && t.data.total === 5 && t.data.enabled === 5, 'GET /tools 统计 5/5 启用')
    assert(w.status === 200 && w.data.total === 2 && w.data.enabled === 2, 'GET /workflows 统计 2/2 启用')
  }

  // 3. 禁用/启用工具
  {
    const off = await json('PATCH', '/api/management/tools/ExportMarkdown', { enabled: false })
    assert(off.status === 200 && off.data.item.enabled === false, 'PATCH 禁用 ExportMarkdown → enabled=false')
    const list = await json('GET', '/api/management/tools')
    assert(list.data.enabled === 4 && list.data.disabled === 1, '工具统计翻转为 4 启用 / 1 禁用')
    const on = await json('PATCH', '/api/management/tools/ExportMarkdown', { enabled: true })
    assert(on.status === 200 && on.data.item.enabled === true, 'PATCH 重新启用 ExportMarkdown')
  }

  // 4. 禁用工作流 → 聊天分支回退关键词路由（不再出现 agent_workflow 注解）
  {
    const off = await json('PATCH', '/api/management/workflows/doc-react', { enabled: false })
    assert(off.status === 200 && off.data.item.enabled === false, 'PATCH 禁用工作流 doc-react')

    // 发一条带粘贴文本的分析消息：禁用期间走 action 关键词路由（无 ReAct 注解）
    const text = '# 测试文档\n\n管理模块回退验证：工作流已禁用，应走关键词路由。'
    const resp = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '分析这份文档' }],
        agentName: 'doc-processor',
        text,
        docId: '',
      }),
    })
    const raw = await resp.text()
    const hasWorkflowCard = /^2:.*agent_workflow/m.test(raw)
    assert(resp.status === 200 && raw.includes('0:'), '禁用期间聊天仍正常返回（回退路由）')
    assert(!hasWorkflowCard, '禁用期间无 agent_workflow 注解（未走 ReAct 工作流）')

    // 持久化文件应含禁用项
    const reg = await json('GET', '/api/management/overview')
    assert(reg.data.workflows.enabled === 1, '总览确认 doc-react 已禁用（doc-plan 仍启用）')

    // 4b. doc-react 禁用期间复合任务仍走 doc-plan（独立工作流，互不影响）：
    //     PlanWorkflow 注解应出现（计划工作流的标志性步骤）
    const compoundText = '# 计划工作流独立验证\n\n复合任务在 doc-react 被禁用期间，仍应由 doc-plan 工作流拆解执行。\n\n第二段内容，保证切片有意义。'
    const cresp = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '请分析这份文档，之后预览' }],
        agentName: 'doc-processor',
        text: compoundText,
        docId: '',
      }),
    })
    const craw = await cresp.text()
    const hasPlan = /"tool":"PlanWorkflow"/.test(craw)
    assert(cresp.status === 200 && craw.includes('0:'), 'doc-react 禁用期间复合任务正常返回')
    assert(hasPlan, '复合任务走 doc-plan（出现 PlanWorkflow 注解，两工作流互不影响）')

    const reg2 = await json('GET', '/api/management/overview')
    assert(reg2.data.workflows.enabled === 1, '总览确认工作流状态未受复合任务影响')
  }

  // 5. 持久化文件内容（服务端文件直查）
  {
    const { readFileSync, existsSync } = require('node:fs')
    const file = './data/management/registry.json'
    assert(existsSync(file), 'data/management/registry.json 已生成')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert(raw?.workflows?.['doc-react'] === false, '持久化文件记录 workflows.doc-react=false')
  }

  // 6. 异常分支
  {
    const nf = await json('PATCH', '/api/management/tools/NoSuchTool', { enabled: false })
    assert(nf.status === 404, 'PATCH 未注册工具 → 404')
    const bad = await json('PATCH', '/api/management/workflows/doc-react', {})
    assert(bad.status === 400, 'PATCH 缺 enabled 字段 → 400')
  }

  // 7. 清理：恢复全部启用
  {
    const on = await json('PATCH', '/api/management/workflows/doc-react', { enabled: true })
    assert(on.status === 200 && on.data.item.enabled === true, '恢复工作流 doc-react 启用')
    const { readFileSync } = require('node:fs')
    const raw = JSON.parse(readFileSync('./data/management/registry.json', 'utf8'))
    assert(raw?.workflows?.['doc-react'] === undefined, '重新启用后覆盖项已清除')
  }

  console.log('\n== 全部通过 ==')
}

main().catch((err) => {
  console.error('❌ E2E 异常：', err)
  process.exit(1)
})
