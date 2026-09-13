import test from 'node:test'
import assert from 'node:assert/strict'
import { applyExcludePenalty, EXCLUDE_PENALTY } from '../lib/unifiedSearch.js'

/**
 * 反问/否定降权纯函数单测（不依赖运行环境；unifiedSearch 顶层 import 链无网络副作用）。
 * 场景对应意图感知改写（ADR-008 评测配套）：negation 类输出 excludeTerms 后的排序降权。
 */

const mk = (id, text, title = '') => ({ item: { id, title, text }, score: 0.9 })

test('命中正文排除词 → 分数打折并标记 excludedBy', () => {
  const out = applyExcludePenalty([mk('a', 'Redux 是集中式状态管理方案')], ['Redux'])
  assert.equal(out[0].item.excludedBy, 'Redux')
  assert.ok(Math.abs(out[0].score - 0.9 * EXCLUDE_PENALTY) < 1e-9)
})

test('命中标题排除词 → 同样降权', () => {
  const out = applyExcludePenalty([mk('a', '正文未提及', 'Next.js 实战')], ['Next.js'])
  assert.equal(out[0].item.excludedBy, 'Next.js')
  assert.ok(out[0].score < 0.9)
})

test('未命中排除词 → 原样返回（不标记、不打折）', () => {
  const out = applyExcludePenalty([mk('a', 'Zustand 轻量状态管理')], ['Redux'])
  assert.equal(out[0].item.excludedBy, undefined)
  assert.equal(out[0].score, 0.9)
})

test('多词条命中时按 terms 顺序取第一个命中的词', () => {
  const out = applyExcludePenalty([mk('a', '提到了 Faiss 与 Milvus')], ['Milvus', 'Faiss'])
  assert.equal(out[0].item.excludedBy, 'Milvus')
})

test('空排除词 / 空候选 → 原样返回', () => {
  const items = [mk('a', '任意内容')]
  assert.equal(applyExcludePenalty(items, []), items)
  assert.equal(applyExcludePenalty(items, ['', '  ']), items)
  assert.equal(applyExcludePenalty([], ['Redux']).length, 0)
})
