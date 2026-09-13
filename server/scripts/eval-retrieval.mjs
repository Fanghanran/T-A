#!/usr/bin/env node
/**
 * eval-retrieval —— 检索质量回归评测（黄金集跑 unifiedSearch 全链路）
 *
 * 用途：Query 改写策略 / 排序管线调整前后各跑一次，对比 hit@3 与 MRR，防肉眼验收误判。
 * 依赖运行环境：Milvus + ES（如启用）+ Ollama（改写/HyDE 真实触发）——与线上同一链路，
 * 不 mock 任何一环；因此不要放进 check:all 门禁（无服务环境会全红）。
 *
 * 用法：node --env-file-if-exists=.env scripts/eval-retrieval.mjs [--golden path] [--tag type]
 * 输出：逐条命中明细（排名/命中切片）+ 汇总 hit@3 / MRR；exit 0 恒定（报告型脚本）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.chdir(SERVER)

const args = process.argv.slice(2)
const argOf = (k) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : null
}
const goldenPath = path.resolve(argOf('--golden') ?? 'test/retrieval.golden.json')
const tagFilter = argOf('--tag')

const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))
const { unifiedSearch, applyExcludePenalty } = await import('../lib/unifiedSearch.js')
const { rewrite } = await import('../lib/queryRewriter.js')

// --contract：意图感知改写的行为契约检查（真实 LLM，覆盖五类判定与排除词）
if (args.includes('--contract')) {
  const contractCases = [
    { name: 'negation', q: '不使用 SSR 的话，这个系统前端为什么选 SPA', expectType: 'negation', needExclude: true },
    { name: 'comparison', q: 'Python 里 list 和 tuple 该怎么选，有什么区别', expectType: 'comparison' },
    { name: 'multi_intent', q: 'RAG 的完整闭环有哪几个环节，缺一个会怎么样', expectType: 'multi_intent' },
    { name: 'plain', q: '常见的开源向量数据库有哪些', expectType: 'plain' },
  ]
  let pass = 0
  let fail = 0
  console.log('==== 意图改写契约检查 ====')
  for (const c of contractCases) {
    const r = await rewrite(c.q, [], {}, 'eval-contract')
    const checks = [
      [`type=${r.queryType}`, r.queryType === c.expectType],
      [c.needExclude ? 'excludeTerms 非空' : 'excludeTerms 为空', c.needExclude ? (r.excludeTerms?.length ?? 0) > 0 : (r.excludeTerms?.length ?? 0) === 0],
      ['补充 query>=1', r.queries.length >= 2],
    ]
    const ok = checks.every(([, ok]) => ok)
    ok ? pass++ : fail++
    console.log(`${ok ? 'PASS' : 'FAIL'} [${c.name}] type=${r.queryType} exclude=[${(r.excludeTerms ?? []).join(',')}] queries=${r.queries.length}`)
    if (!ok) checks.filter(([, ok]) => !ok).forEach(([n]) => console.log(`   未过: ${n}`))
  }
  // 降权纯函数冒烟（不依赖 LLM）
  const smoke = applyExcludePenalty([{ item: { id: 'a', text: 'Redux 集中式方案' }, score: 0.9 }], ['Redux'])
  const penaltyOk = smoke[0].item.excludedBy === 'Redux' && smoke[0].score < 0.9
  penaltyOk ? pass++ : fail++
  console.log(`${penaltyOk ? 'PASS' : 'FAIL'} [降权纯函数] 命中排除词 ×${'EXCLUDE_PENALTY'} 生效`)
  console.log(`==== 契约汇总：通过 ${pass} / 失败 ${fail} ====`)
  process.exit(fail ? 1 : 0)
}

const TOPK = 3
let cases = golden.cases
if (tagFilter) cases = cases.filter((c) => c.type === tagFilter)

const OWNER = 'admin'
const results = []
let hitCount = 0
let mrrSum = 0

for (const c of cases) {
  const t0 = performance.now()
  let items = []
  let err = null
  try {
    const r = await unifiedSearch({
      q: c.q,
      scope: 'knowledge',
      topK: TOPK,
      history: c.history ?? [],
      ownerId: OWNER,
    })
    items = r.knowledgeResults?.items ?? []
  } catch (e) {
    err = e.message
  }
  const ms = Math.round(performance.now() - t0)

  // 判定：topK 内存在切片——属于期望文档 且 正文包含全部期望关键词
  let rank = 0
  items.forEach((it, i) => {
    if (rank) return
    const inDoc = !c.expectDoc || String(it.title ?? '').includes(c.expectDoc) || String(it.docTitle ?? '').includes(c.expectDoc)
    const hay = `${it.text ?? ''}${it.snippet ?? ''}`
    const kwOk = (c.expectKeywords ?? []).every((k) => hay.includes(k))
    if (inDoc && kwOk) rank = i + 1
  })
  const hit = rank > 0
  if (hit) { hitCount++; mrrSum += 1 / rank }
  results.push({
    id: c.id,
    type: c.type,
    hit,
    rank: rank || '-',
    ms,
    top1: items[0] ? `${String(items[0].title ?? '').slice(0, 18)} § ${(items[0].idx ?? 0) + 1}` : (err ?? '空'),
  })
  const mark = hit ? '✓' : '✗'
  console.log(`${mark} [${c.type}] ${c.id}  rank=${rank || '-'} ${ms}ms  top1=${results[results.length - 1].top1}`)
}

const n = results.length
console.log('\n==== 汇总 ====')
console.log(`用例 ${n} | hit@${TOPK} ${hitCount}/${n} = ${((hitCount / n) * 100).toFixed(0)}% | MRR ${(mrrSum / n).toFixed(3)}`)
const byType = {}
for (const r of results) {
  byType[r.type] ??= { total: 0, hit: 0 }
  byType[r.type].total++
  if (r.hit) byType[r.type].hit++
}
for (const [t, v] of Object.entries(byType)) console.log(`  ${t}: ${v.hit}/${v.total}`)
process.exit(0)
