/**
 * 检索链路单测 —— queryRewriter 降级 / hyde 守卫 / unifiedSearch 双路融合与级联。
 *
 * 隔离策略：node --test 不加载 server/.env → llmAvailable=false（改写/HyDE 天然降级）；
 * unifiedSearch 的存储与 embedding 依赖用 mock.module 桩掉（需 --experimental-test-module-mocks）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { rewrite } from '../lib/queryRewriter.js'
import { hypothesize } from '../lib/hyde.js'
import { setTunable } from '../lib/tunables.js'

/* ===================== queryRewriter 降级路径 ===================== */

test('rewrite 空查询降级 empty_query', async () => {
  const r = await rewrite('', [], {})
  assert.deepEqual(r.queries, [])
  assert.equal(r.rewritten, false)
  assert.equal(r.reason, 'empty_query')
})

test('rewrite 总开关关闭降级 rewrite_disabled，保留原始 query', async () => {
  const r = await rewrite('这是一条测试查询语句', [], { rewriteEnabled: false })
  assert.deepEqual(r.queries, ['这是一条测试查询语句'])
  assert.equal(r.rewritten, false)
  assert.equal(r.reason, 'rewrite_disabled')
})

test('rewrite LLM 不可用（测试环境无 .env）降级单 query', async () => {
  const q = '向量数据库的底层存储结构是什么'
  const r = await rewrite(q, [], {})
  assert.deepEqual(r.queries, [q])
  assert.equal(r.rewritten, false)
})

test('rewrite 带历史对话也稳定降级（不抛错）', async () => {
  const r = await rewrite('它和前一个问题有什么区别', [
    { role: 'user', content: '什么是 Milvus' },
    { role: 'assistant', content: 'Milvus 是向量数据库' },
  ], {})
  assert.ok(Array.isArray(r.queries) && r.queries.length >= 1)
})

/* ===================== hyde 守卫路径 ===================== */

test('hypothesize 空查询返回 null', async () => {
  assert.equal(await hypothesize(''), null)
  assert.equal(await hypothesize('   '), null)
})

test('hypothesize 总开关关闭返回 null（tunables 热生效）', async () => {
  const res = setTunable('hyde.hydeEnabled', false)
  assert.equal(res.ok, true)
  try {
    assert.equal(await hypothesize('一个足够长的问题语句'), null)
  } finally {
    // setTunable 返回 {ok, from, item}，旧值在 from 字段
    setTunable('hyde.hydeEnabled', res.from)
  }
})

test('hypothesize LLM 不可用返回 null（测试环境无 .env）', async () => {
  // 测试进程不加载 .env → llmAvailable=false → 生成前熔断返回 null，绝不抛错
  const r = await hypothesize('一个足够长的问题语句')
  assert.equal(r, null)
})

/* ===================== unifiedSearch 双路融合（mock.module 桩） ===================== */

// 桩：向量库检索（按 field 分发 fixture）+ 题库 + HyDE 生成 + embedding
let _storeSearchImpl = null
let _hydeImpl = null
let storeSearchCalls = []

mock.module('../lib/vectorStore.js', {
  namedExports: {
    search: async (qv, opts = {}) => {
      storeSearchCalls.push({ field: opts.field, topK: opts.topK })
      return _storeSearchImpl ? _storeSearchImpl(opts.field, storeSearchCalls.length) : []
    },
    // ES 仅命中块的 payload 补齐（内存镜像查询）；单测默认无此块，返回 null
    getChunkById: () => null,
  },
})
// 桩：ES BM25 通道默认关闭（单测只验证向量融合语义，关键词通道另行覆盖）
let _esSearchImpl = null
mock.module('../lib/esStore.js', {
  namedExports: {
    isEnabled: () => _esSearchImpl !== null,
    search: async (q, opts) => (_esSearchImpl ? _esSearchImpl(q, opts) : { hits: [], degraded: false }),
  },
})
mock.module('../lib/questionBank.js', {
  namedExports: {
    search: async () => [],
  },
})
mock.module('../lib/hyde.js', {
  namedExports: {
    hypothesize: async (q) => (_hydeImpl ? _hydeImpl(q) : null),
  },
})
mock.module('../lib/embed.js', {
  namedExports: {
    embedTexts: async (texts) => texts.map(() => [1, 0]),
    embedSentences: async (ss) => ss.map(() => [1, 0]),
    averageVectors: (vecs) => (vecs.length ? vecs[0] : []),
    embedMode: () => 'mock',
  },
})

// 桩就位后再加载被测模块（静态 import 会被提升，必须动态 import）
const { unifiedSearch } = await import('../lib/unifiedSearch.js')

/** 重置桩状态（esImpl：ES BM25 通道桩；默认关闭） */
function resetStubs(storeImpl, hydeImpl, esImpl) {
  storeSearchCalls = []
  _storeSearchImpl = storeImpl || null
  _hydeImpl = hydeImpl || null
  _esSearchImpl = esImpl || null
}

test('unifiedSearch 双路命中融合：max(t, qt, avg×1.15)', async () => {
  // text 路 0.6、question 路 0.7 → qt=0.63、avg=0.615、avg×1.15≈0.70725
  // 浮点实际值 0.7072499999999999 → toFixed(4) = 0.7072
  resetStubs((field) => {
    if (field === 'text') return [{ id: 'a', docId: 'd1', score: 0.6, text: 'zzz', snippet: 'zzz' }]
    return [{ id: 'a', docId: 'd1', score: 0.7, text: 'zzz', snippet: 'zzz' }]
  })
  const r = await unifiedSearch({ q: 'dual path english query', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.items.length, 1)
  assert.equal(r.knowledgeResults.items[0].score, 0.7072)
  assert.equal(r.knowledgeResults.hyde, null) // top1 达标不触发
})

test('unifiedSearch 仅正文命中保留 t 分', async () => {
  resetStubs((field) => {
    if (field === 'text') return [{ id: 'a', docId: 'd1', score: 0.6, text: 'zzz', snippet: 'zzz' }]
    return []
  })
  const r = await unifiedSearch({ q: 'text only english query', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.items[0].score, 0.6)
})

test('unifiedSearch 仅锚点命中按 QUESTION_WEIGHT 降权', async () => {
  resetStubs((field) => {
    if (field === 'question') return [{ id: 'a', docId: 'd1', score: 0.7, text: 'zzz', snippet: 'zzz' }]
    return []
  })
  const r = await unifiedSearch({ q: 'question only english query', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.items[0].score, 0.63) // 0.7 × 0.9
})

test('unifiedSearch ES 仅命中：归一化后 × KEYWORD_WEIGHT(0.7) 降档', async () => {
  // 向量两路全空，ES 命中一条（唯一命中 → 归一化 s=1.0 → ×0.7=0.7）
  // q 与文本完全一致 → 2-gram 覆盖率 1 → +0.2 → 最终 0.9
  resetStubs(
    () => [],
    null,
    () => ({ hits: [{ id: 'a', score: 8.5 }], degraded: false }),
  )
  // getChunkById 桩默认 null → 仅 ES 命中块需有 payload 才进结果；这里借 store.search
  // 无法返回（桩返回空），所以直接验证 es 调试信息而不验证条目（payload 补齐在集成验证）
  const r = await unifiedSearch({ q: 'better-sqlite3', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.es.hits, 1)
  assert.equal(r.knowledgeResults.es.degraded, false)
  assert.equal(r.knowledgeResults.items.length, 0) // payload 缺失（桩返回 null）不入池
})

test('unifiedSearch 向量+ES 双命中：max 语义加成', async () => {
  // 向量 text 路 0.5；ES 唯一命中归一化 s=1.0×KEYWORD_WEIGHT(0.7)=0.7
  // avg=(0.5+0.7)/2=0.6 → ×1.15=0.69 → max(0.5, 0.7, 0.69)=0.7
  resetStubs(
    (field) => {
      if (field === 'text') return [{ id: 'a', docId: 'd1', score: 0.5, text: 'zzz', snippet: 'zzz' }]
      return []
    },
    null,
    () => ({ hits: [{ id: 'a', score: 12.0 }], degraded: false }),
  )
  const r = await unifiedSearch({ q: 'english query term', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.items.length, 1)
  assert.equal(r.knowledgeResults.items[0].score, 0.7)
  assert.equal(r.knowledgeResults.es.hits, 1)
})

test('unifiedSearch 2-gram 字面命中加权（覆盖率 1 → +0.2）', async () => {
  // 用户问句逐字出现在片段中 → 覆盖率 1 → 语义分 0.5 + 0.2 = 0.7
  resetStubs((field) => {
    if (field === 'text') {
      return [{ id: 'a', docId: 'd1', score: 0.5, text: '公司还招外卖员吗待遇如何', snippet: '公司还招外卖员吗' }]
    }
    return []
  })
  const r = await unifiedSearch({ q: '还招外卖员吗', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.items[0].score, 0.7)
})

test('unifiedSearch HyDE 级联触发：低分触发并融合假设答案命中', async () => {
  let hydeCalled = 0
  resetStubs(
    (field, callNo) => {
      // 首轮（前两次调用）：text/question 均低分 0.2 → top1=0.2 < 0.45 触发 HyDE
      if (callNo <= 2) {
        return [{ id: 'low', docId: 'd1', score: 0.2, text: 'zzz', snippet: 'zzz' }]
      }
      // HyDE 二次检索（第 3 次调用，text 路）：高分命中 0.9 → 0.9×0.8=0.72
      if (field === 'text') {
        return [{ id: 'hyde1', docId: 'd2', score: 0.9, text: 'yyy', snippet: 'yyy' }]
      }
      return []
    },
    () => {
      hydeCalled++
      return { text: '假设答案文本内容', source: 'llm', ms: 100 }
    },
  )
  const r = await unifiedSearch({ q: 'hard query with low score', scope: 'knowledge', topK: 5 })
  assert.equal(hydeCalled, 1)
  assert.equal(r.knowledgeResults.hyde.triggered, true)
  assert.equal(r.knowledgeResults.hyde.added, 1)
  // HyDE 命中 0.9×0.8=0.72 > 首轮 0.2 → 排第一
  assert.equal(r.knowledgeResults.items[0].id, 'hyde1')
  assert.equal(r.knowledgeResults.items[0].score, 0.72)
})

test('unifiedSearch HyDE 高分查询不触发（零额外调用）', async () => {
  let hydeCalled = 0
  resetStubs(
    () => [{ id: 'hi', docId: 'd1', score: 0.9, text: 'zzz', snippet: 'zzz' }],
    () => {
      hydeCalled++
      return { text: 'x', source: 'llm', ms: 1 }
    },
  )
  const r = await unifiedSearch({ q: 'high score english query', scope: 'knowledge', topK: 3 })
  assert.equal(hydeCalled, 0)
  assert.equal(r.knowledgeResults.hyde, null)
})

test('unifiedSearch HyDE 生成失败保留首轮结果不抛错', async () => {
  resetStubs(
    () => [{ id: 'low', docId: 'd1', score: 0.2, text: 'zzz', snippet: 'zzz' }],
    () => null, // hypothesize 失败（超时/LLM 不可用）
  )
  const r = await unifiedSearch({ q: 'trigger but fail query', scope: 'knowledge', topK: 3 })
  assert.equal(r.knowledgeResults.hyde.triggered, false)
  assert.equal(r.knowledgeResults.items.length, 1)
  // text/question 双路同命中 0.2：qt=0.18、avg=0.19、avg×1.15=0.2185（双路融合分）
  assert.equal(r.knowledgeResults.items[0].score, 0.2185)
})

test('unifiedSearch 单文档配额：同 docId 最多 3 条', async () => {
  resetStubs((field) => {
    if (field === 'text') {
      return [1, 2, 3, 4, 5].map((i) => ({
        id: `item${i}`, docId: 'sameDoc', score: 0.9 - i * 0.01,
        text: `unique text ${i}`, snippet: `unique snippet ${i}`,
      }))
    }
    return []
  })
  const r = await unifiedSearch({ q: 'quota test english query', scope: 'knowledge', topK: 5 })
  assert.equal(r.knowledgeResults.items.length, 3) // MAX_PER_DOC = 3
})

test('unifiedSearch 近重复折叠：同 snippet 前缀留最高分', async () => {
  resetStubs((field) => {
    if (field === 'text') {
      const dup = '同一篇讲义的同质段落开头六十四字符' + 'x'.repeat(40)
      return [
        { id: 'dup1', docId: 'd1', score: 0.5, text: dup, snippet: dup },
        { id: 'dup2', docId: 'd1', score: 0.8, text: dup, snippet: dup },
      ]
    }
    return []
  })
  const r = await unifiedSearch({ q: 'near dup english query test', scope: 'knowledge', topK: 5 })
  assert.equal(r.knowledgeResults.items.length, 1)
  assert.equal(r.knowledgeResults.items[0].id, 'dup2') // 留最高分
})

test('unifiedSearch category 过滤在合并后统一执行', async () => {
  resetStubs((field) => {
    if (field === 'text') {
      return [
        { id: 'a', docId: 'd1', score: 0.9, category: '计算机基础', text: 'zzz', snippet: 'zzz' },
        { id: 'b', docId: 'd2', score: 0.85, category: '其他分类', text: 'yyy', snippet: 'yyy' },
      ]
    }
    return []
  })
  const r = await unifiedSearch({ q: 'category filter query', scope: 'knowledge', topK: 5, category: '计算机基础' })
  assert.equal(r.knowledgeResults.items.length, 1)
  assert.equal(r.knowledgeResults.items[0].id, 'a')
})

test('unifiedSearch scope 隔离：question scope 不查知识库', async () => {
  resetStubs(() => {
    throw new Error('不应触达向量库')
  })
  const r = await unifiedSearch({ q: 'scope isolation query', scope: 'question', topK: 3 })
  assert.equal(r.knowledgeResults, null)
  assert.ok(r.questionResults)
  assert.equal(storeSearchCalls.length, 0)
})
