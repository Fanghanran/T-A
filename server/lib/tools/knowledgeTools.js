import { toolRegistry } from '../management/registry.js'
import { unifiedSearch } from '../unifiedSearch.js'
import * as store from '../vectorStore.js'
import { writeGlobalFact } from '../memoryService.js'
import { childLogger } from '../logger.js'

/**
 * knowledgeTools —— ReAct 自主规划器的首批工具集（通用 Agent 能力设计 P2）
 *
 * 与 docTools 的差异：docTools 服务文档处理场景（ctx 携带 docId/cacheKey），
 * 本文件的工具面向自主规划的复合任务（检索 → 整理 → 写记忆），ctx 只需 ownerId。
 *
 * 首批只放 3 个只读为主的安全工具；写类工具仅 memory.write（写长期记忆，
 * 幂等去重、可回退，不触碰知识库/文档数据）。知识库写入/删除类工具
 * 不对自主规划开放（设计书 §5：开放必须接 HITL 确认钩子）。
 *
 * 工具契约与 docTools 一致：run(ctx, args, extra) → { observation, userText?, annotation? }
 *  - observation  写入规划器 scratchpad 的机器可读结果（给 LLM 看）
 *  - userText     呈现给用户的正文（规划器可选透传）
 */

const log = childLogger('knowledgeTools')

function truncate(s, max) {
  const t = typeof s === 'string' ? s.trim() : ''
  if (t.length <= max) return t
  return t.slice(0, max).trimEnd() + '…'
}

/* ===================== kb.search —— 知识库混合检索 ===================== */

toolRegistry.register({
  name: 'kb.search',
  label: '知识库检索',
  category: 'react',
  description: '在本地知识库中做混合检索（向量 + 关键词），返回最相关的切片（含标题、相似度、正文摘要）',
  params: 'query（字符串，必填，检索问题）、topK（数字，可选，默认 5，最大 20）',
  async run(ctx, args, extra) {
    const q = typeof args?.query === 'string' ? args.query.trim() : ''
    if (!q) {
      return { observation: '错误：缺少 query 参数。请给出要检索的问题或关键词。' }
    }
    const topKRaw = Number(args?.topK)
    const topK = Number.isFinite(topKRaw) ? Math.min(Math.max(Math.round(topKRaw), 1), 20) : 5
    const r = await unifiedSearch({
      q,
      scope: 'knowledge',
      topK,
      history: extra?.history,
      caller: 'reactPlanner',
      ownerId: ctx.ownerId,
    })
    const items = r?.knowledgeResults?.items ?? []
    if (!items.length) {
      return {
        observation: `知识库中未检索到与「${truncate(q, 50)}」相关的内容（0 条）。可换一个表述再试，或改用 kb.documentInfo 查看库内有哪些文档。`,
        userText: `知识库中未检索到与「${truncate(q, 50)}」相关的内容。`,
      }
    }
    const obs = JSON.stringify(
      items.map((it) => ({
        title: it.title ?? '',
        score: Number(it.score?.toFixed?.(4) ?? it.score),
        snippet: truncate(it.text ?? it.snippet ?? '', 300),
      })),
    )
    const userText =
      `检索「${truncate(q, 50)}」命中 ${items.length} 条：\n` +
      items.map((it, i) => `${i + 1}. 【${it.title ?? '无标题'}】（相似度 ${(it.score ?? 0).toFixed?.(3) ?? it.score}）`).join('\n')
    return { observation: obs, userText }
  },
})

/* ===================== kb.documentInfo —— 文档/切片明细 ===================== */

toolRegistry.register({
  name: 'kb.documentInfo',
  label: '文档明细查询',
  category: 'react',
  description: '查询知识库的文档清单（标题/分类/大小/切片数），或按 docId 查单个文档详情',
  params: 'docId（字符串，可选）：传了返回该文档详情与切片数；不传返回全部文档清单',
  async run(ctx, args) {
    const docId = typeof args?.docId === 'string' ? args.docId.trim() : ''
    if (docId) {
      const doc = store.getDocument(docId, ctx.ownerId)
      if (!doc) {
        return { observation: `错误：文档 ${docId} 不存在（或不属于当前用户）。` }
      }
      let chunks = 0
      try {
        chunks = await store.countChunksOfDoc(docId, ctx.ownerId)
      } catch (err) {
        log.warn(`[knowledgeTools] countChunksOfDoc 失败：${err.message}`)
      }
      const obs = JSON.stringify({ id: doc.id, title: doc.title, category: doc.category ?? '', size: doc.size, chunks })
      return {
        observation: obs,
        userText: `文档【${doc.title}】：${chunks} 个切片，${(doc.size ?? 0).toLocaleString()} 字节${doc.category ? `，分类「${doc.category}」` : ''}。`,
      }
    }
    const docs = store.listDocuments({ ownerId: ctx.ownerId })
    if (!docs.length) {
      return { observation: '知识库当前没有任何文档。', userText: '知识库当前还没有文档。' }
    }
    const brief = []
    for (const d of docs.slice(0, 20)) {
      let chunks = 0
      try {
        chunks = await store.countChunksOfDoc(d.id, ctx.ownerId)
      } catch {
        /* 明细查询失败不阻塞清单展示 */
      }
      brief.push({ id: d.id, title: d.title, category: d.category ?? '', chunks })
    }
    const obs = JSON.stringify({ total: docs.length, items: brief })
    const userText =
      `知识库共 ${docs.length} 篇文档：\n` +
      brief.map((d, i) => `${i + 1}. 【${d.title}】${d.category ? `（${d.category}）` : ''} ${d.chunks} 切片`).join('\n')
    return { observation: obs, userText }
  },
})

/* ===================== memory.write —— 写入长期记忆 ===================== */

toolRegistry.register({
  name: 'memory.write',
  label: '写入长期记忆',
  category: 'react',
  description: '把一条结论性事实写入长期记忆（跨会话可召回）。只能写简明的陈述句事实，不能写长文',
  params: 'text（字符串，必填，一句简明事实，建议 ≤200 字）',
  async run(ctx, args) {
    const text = typeof args?.text === 'string' ? args.text.trim() : ''
    if (!text) {
      return { observation: '错误：缺少 text 参数。请给出要记住的事实（一句陈述句）。' }
    }
    if (text.length > 500) {
      return {
        observation: `错误：text 过长（${text.length} 字，上限 500）。长期记忆只存简明事实，请先提炼再写入。`,
        userText: '要写入的内容太长了，长期记忆只存简明事实，请先提炼成一句话。',
      }
    }
    const r = await writeGlobalFact({ text, ownerId: ctx.ownerId, agentName: 'react-planner' })
    if (!r.written && r.reason === 'duplicate') {
      return {
        observation: '该事实已存在于长期记忆（内容去重），无需重复写入。',
        userText: '这条事实我已经记过了，无需重复写入。',
      }
    }
    return {
      observation: `已写入长期记忆（scope=global，id=${r.id}）：${truncate(text, 100)}`,
      userText: `✅ 已记住：${truncate(text, 120)}`,
    }
  },
})
