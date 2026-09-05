#!/usr/bin/env node
/**
 * check-layers —— 分层架构静态检查（严谨模块的机器化守卫）
 *
 * 规则（与 index.js 头注释一致，依赖只允许自上而下引用）：
 *   L0  基础设施   env / config / logger / errors / requestTrace
 *   L1  存储       milvusStore / vectorStore / sessionStore / questionBank
 *   L2  算法       chunker / embed / queryRewriter
 *   L3  LLM        llm
 *   L4  领域       docProcessor / unifiedSearch
 *   L5  注册表     management/registry
 *   L5.5 编排语义  intents
 *   L6  工具层     tools/*
 *   L7  工作流层   workflows/*
 *   L8  HTTP       routes/* + management/manager
 *   L9  入口       index.js
 *   （env.js 归 L0：必须最先加载的 .env 读取器，先于 config）
 *
 * 断言（任一失败退出码 1）：
 *   A. 依赖方向：每个模块引用的内部模块层级必须 ≤ 自身层级（禁止向下越级 2 层以上
 *      的反向依赖；同层互相引用允许，除 routes/shared 例外只允许被 L8 引用）
 *   B. 工作流层不得直接 import 工具层实现（tools/*）——工具一律经 registry.resolveRunner 解耦
 *   C. lib 任何模块不得引用 routes/* 或 index.js
 *   D. 循环依赖检测（A→B→A）
 *
 * 用法：node scripts/check-layers.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 模块 → 层级映射（键为相对 lib/ 或根目录的模块路径） */
const LAYERS = {
  // L0 基础设施
  'env.js': 0, 'lib/logger.js': 0, 'lib/config.js': 0, 'lib/errors.js': 0, 'lib/requestTrace.js': 0, 'lib/security.js': 0, 'lib/tunables.js': 0,
  'lib/mathUtils.js': 0, 'lib/textUtils.js': 0, 'lib/streamUtils.js': 0, 'lib/llmProvider.js': 0, 'lib/cache.js': 0,
  'lib/models.js': 0,
  // L1 存储
  'lib/milvusStore.js': 1, 'lib/vectorStore.js': 1, 'lib/sessionStore.js': 1, 'lib/questionBank.js': 1,
  // L2 算法
  'lib/chunker.js': 2, 'lib/embed.js': 2, 'lib/queryRewriter.js': 2,
  // L3 LLM
  'lib/llm.js': 3,
  // L4 领域
  'lib/docProcessor.js': 4, 'lib/unifiedSearch.js': 4, 'lib/chunkAudit.js': 4, 'lib/memoryService.js': 4,
  'lib/agents/builtin/knowledgeBase.js': 4, 'lib/agents/builtin/interviewRetrieval.js': 4, 'lib/agents/builtin/defaultChat.js': 4,
  'lib/agents/builtin/resumeAnalysis.js': 4, 'lib/agents/builtin/mockInterview.js': 4,
  // L5 注册表
  'lib/management/registry.js': 5, 'lib/management/audit.js': 5,
  'lib/agents/agentRegistry.js': 5,
  // L5.5 编排语义（数值用 5.5，比较时直接数值比较）
  'lib/intents.js': 5.5,
  // L6 工具层
  'lib/tools/docTools.js': 6,
  // L7 工作流层
  'lib/workflows/docWorkflow.js': 7, 'lib/workflows/docPlanWorkflow.js': 7, 'lib/workflows/docWorkflowShared.js': 7,
  // L8 HTTP
  'lib/management/manager.js': 8,
  'routes/shared.js': 8, 'routes/health.js': 8, 'routes/sessions.js': 8, 'routes/interview.js': 8,
  'routes/knowledge.js': 8, 'routes/docProcessor.js': 8, 'routes/chat.js': 8, 'routes/resume.js': 8,
  // L9 入口
  'index.js': 9,
}

/** 收集目录下所有 .js 文件（相对 SERVER_ROOT） */
function collectJsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'data' || name === '.git' || name === 'scripts') continue
      collectJsFiles(full, acc)
    } else if (name.endsWith('.js')) {
      acc.push(relative(SERVER_ROOT, full).replaceAll('\\', '/'))
    }
  }
  return acc
}

const files = collectJsFiles(SERVER_ROOT).filter((f) => f === 'index.js' || f.startsWith('lib/') || f.startsWith('routes/'))
const errors = []
const edges = [] // { from, to }

const IMPORT_RE = /import\s+(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g

for (const file of files) {
  const src = readFileSync(join(SERVER_ROOT, file), 'utf8')
  const fromLayer = LAYERS[file]
  if (fromLayer === undefined) {
    errors.push(`[分层表缺失] ${file} 未登记层级，请更新 scripts/check-layers.mjs 的 LAYERS`)
    continue
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2]
    // 解析相对路径 → 相对 SERVER_ROOT 的规范模块路径
    const abs = resolve(SERVER_ROOT, dirname(join(SERVER_ROOT, file)), spec)
    let target = relative(SERVER_ROOT, abs).replaceAll('\\', '/')
    if (!target.endsWith('.js')) {
      // 补 .js 或指向目录 index
      if (existsSync(`${target}.js`)) target += '.js'
      else if (existsSync(join(target, 'index.js'))) target += '/index.js'
    }
    if (LAYERS[target] === undefined) {
      // 目标不在受管清单（未知文件报错，保证分层表覆盖全部内部模块）
      errors.push(`[分层表缺失] ${file} 引用了未登记模块 ${target}`)
      continue
    }
    edges.push({ from: file, to: target, fromLayer, toLayer: LAYERS[target] })

    // A. 依赖方向：不得反向（目标层级 > 自身层级 = 引用了上层，违规）
    if (LAYERS[target] > fromLayer) {
      errors.push(
        `[反向依赖] ${file}(L${fromLayer}) → ${target}(L${LAYERS[target]})：只允许自上而下引用`,
      )
    }

    // B. 工作流层不得直接 import 工具层实现
    if (file.startsWith('lib/workflows/') && target.startsWith('lib/tools/')) {
      errors.push(
        `[工作流耦合] ${file} 直接 import ${target}：工具一律经 toolRegistry.resolveRunner 解耦调用`,
      )
    }

    // C. lib 不得引用 routes / index.js
    if (file.startsWith('lib/') && (target.startsWith('routes/') || target === 'index.js')) {
      errors.push(`[越界引用] lib 模块 ${file} 不得引用 ${target}`)
    }
  }
}

// D. 循环依赖（DFS 找环）
const adj = new Map()
for (const e of edges) {
  if (!adj.has(e.from)) adj.set(e.from, [])
  adj.get(e.from).push(e.to)
}
const WHITE = 0, GRAY = 1, BLACK = 2
const color = new Map()
function dfs(node, stack) {
  color.set(node, GRAY)
  stack.push(node)
  for (const next of adj.get(node) ?? []) {
    const c = color.get(next) ?? WHITE
    if (c === GRAY) {
      const cycleStart = stack.indexOf(next)
      errors.push(`[循环依赖] ${[...stack.slice(cycleStart), next].join(' → ')}`)
    } else if (c === WHITE) {
      dfs(next, stack)
    }
  }
  stack.pop()
  color.set(node, BLACK)
}
for (const node of adj.keys()) {
  if ((color.get(node) ?? WHITE) === WHITE) dfs(node, [])
}

// 输出
const total = edges.length
if (errors.length) {
  console.error(`❌ 分层检查失败（${errors.length} 处违规，共 ${total} 条依赖边）：\n`)
  for (const e of [...new Set(errors)]) console.error(`  ${e}`)
  process.exit(1)
}
console.log(`✅ 分层检查通过：${files.length} 个模块 / ${total} 条依赖边，无反向依赖、无工作流-工具直连、无循环依赖`)
