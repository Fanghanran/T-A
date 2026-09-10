import * as store from '../vectorStore.js'
import { embedTexts } from '../embed.js'
import { generateChunkAnnotations } from '../llm.js'
import { childLogger } from '../logger.js'
import {
  analyzeDocFeatures,
  previewChunks,
  formatChunksPreview,
  chunksToAnnotation,
  applyChunkAdjustment,
  exportChunksAsMarkdown,
  prepareDocChunksAndVectors,
  dedupWithinBatch,
  DEDUP_THRESHOLDS,
  getCachedPreview,
  setCachedPreview,
  clearCachedPreview,
} from '../docProcessor.js'
import { toolRegistry } from '../management/registry.js'
// 意图判定已下沉为独立领域模块（lib/intents.js），工具层与工作流层共用同一口径
import { hasCommitConfirmation } from '../intents.js'

/**
 * docTools —— 文档处理智能体的工具集（工具层）
 *
 * 每个工具向 toolRegistry 注册元数据（中文名/描述/参数说明），供两处消费：
 *  1. 管理模块（/api/management/*）：列表展示、启用/禁用
 *  2. 工作流层（workflows/docWorkflow.js）：System Prompt 的「可用工具」块
 *     从注册表动态生成（只列启用项）；LLM 调用禁用工具时由工作流层拦截
 *
 * 工具契约：run(ctx, args, extra) → { observation, userText?, annotation?, finish? }
 *  - ctx        执行上下文 { docId, cacheKey, resolveText() }
 *  - extra      { query, history }（CommitToStore 的确认守卫用）
 *  - observation  写入 scratchpad 的机器可读结果（给 LLM 看）
 *  - userText     呈现给用户的正文；annotation 为前端卡片注解
 *
 * FINISH 不在本注册表（它是循环终止信号而非可执行工具，由工作流层特判）。
 */

const log = childLogger('docTools')

function truncate(s, max) {
  const t = typeof s === 'string' ? s.trim() : ''
  if (t.length <= max) return t
  return t.slice(0, max).trimEnd() + '…'
}

/**
 * 把已调整的预览 chunks 直接转为入库数据（embed + topic/questions 标注）。
 * 与 prepareDocChunksAndVectors 的区别：不再从原文重新切片——用户在预览阶段做的
 * 合并/拆分必须被保留（原 confirm 分支从 text 重切会丢失调整，这里修正）。
 *
 * 导出供 index.js 的 REST 入库端点（POST /api/doc-processor/commit）复用：
 * 操作栏入库与聊天里说"入库"走同一份数据准备逻辑，保证两侧入库结果一致。
 */
export async function prepareAdjustedChunks(chunks) {
  const texts = chunks.map((c) => (typeof c.text === 'string' ? c.text : ''))
  let vectors = []
  try {
    vectors = await embedTexts(texts)
  } catch (err) {
    log.warn(`[docTools] prepareAdjustedChunks embedTexts 失败：${err.message}，降级空向量`)
    vectors = texts.map(() => [])
  }
  let annots = []
  try {
    annots = await generateChunkAnnotations(chunks, { questionsPerChunk: 3 })
  } catch (err) {
    log.warn(`[docTools] generateChunkAnnotations 失败：${err.message}，降级 heading 兜底`)
    annots = []
  }
  if (!Array.isArray(annots) || annots.length !== chunks.length) {
    annots = chunks.map((c) => ({
      topic: (typeof c.heading === 'string' && c.heading.trim()) || truncate(c.text, 30),
      questions: [],
    }))
  }
  const chunkList = chunks.map((c, i) => ({
    idx: i,
    heading: c.heading || '',
    text: typeof c.text === 'string' ? c.text : '',
    preContext: typeof c.preContext === 'string' ? c.preContext : '',
    postContext: typeof c.postContext === 'string' ? c.postContext : '',
    topic: annots[i]?.topic || '',
    questions: Array.isArray(annots[i]?.questions) ? annots[i].questions : [],
    sentenceStart: 0,
    sentenceEnd: 0,
  }))
  // 问题向量：questions join 后批量 embed（与 prepareDocChunksAndVectors 同口径）；
  // 无 questions 的块占位 null，入库时退化用 text 向量
  let questionVectors = null
  const qTexts = chunkList.map((c) =>
    Array.isArray(c.questions) && c.questions.length ? c.questions.join('\n') : null,
  )
  if (qTexts.some((t) => typeof t === 'string' && t.length > 0)) {
    try {
      const embedded = await embedTexts(qTexts.map((t) => t ?? ''))
      questionVectors = qTexts.map((t, i) => (t ? embedded[i] : null))
    } catch (err) {
      log.warn(`[docTools] prepareAdjustedChunks 问题向量 embed 失败：${err.message}，question_vector 退化用 text 向量`)
      questionVectors = null
    }
  }
  return { chunkList, vectors, questionVectors }
}

/**
 * 文档去重（设计文档 §9 扩展）：入库前对已准备的 chunk 数据去重。
 *  ① 批内去重：同一文档内语义几乎相同的块（cos ≥ 0.96，常见于原文重复段落）只保留首个；
 *  ② 跨文档去重：对批内保留的每块向量在 Milvus 检索 top-1，与库中已有块
 *     近似完全重复（cos ≥ 0.985）时跳过入库（多份文档合并场景）。
 * 导出供 index.js 的 REST 入库端点复用，聊天/操作栏两条链路口径一致。
 * @param {Array} questionVectors 问题向量（可空；块被过滤时同步过滤，防止索引错位）
 * @returns {{ chunkList:Array, vectors:Array, questionVectors:Array|null, skippedWithin:number, skippedCross:number }}
 */
export async function dedupPreparedChunks(chunkList, vectors, questionVectors = null) {
  const batch = dedupWithinBatch(chunkList, vectors)
  // 批内去重后原索引失效：按原 chunkList 的 text 反查过滤后的问题向量
  const qvByText = Array.isArray(questionVectors)
    ? new Map(chunkList.map((c, i) => [c, questionVectors[i] ?? null]))
    : null
  let skippedCross = 0
  const keptList = []
  const keptVecs = []
  const keptQVecs = []
  for (let i = 0; i < batch.chunkList.length; i++) {
    const v = Array.isArray(batch.vectors[i]) ? batch.vectors[i] : []
    let dup = false
    if (v.length) {
      try {
        // 只看最相似的 1 条；COSINE 度量，score 即相似度
        const hits = await store.search(v, { topK: 1, field: 'text' })
        if (hits?.length && Number(hits[0].score) >= DEDUP_THRESHOLDS.crossDoc) dup = true
      } catch (err) {
        // 检索失败不阻塞入库：宁可重复，不可丢数据
        log.warn(`[docTools] 跨文档去重检索失败：${err.message}，该块按保留处理`)
      }
    }
    if (dup) {
      skippedCross++
      continue
    }
    keptList.push(batch.chunkList[i])
    keptVecs.push(v)
    keptQVecs.push(qvByText ? (qvByText.get(batch.chunkList[i]) ?? null) : null)
  }
  return {
    chunkList: keptList,
    vectors: keptVecs,
    questionVectors: qvByText ? keptQVecs : null,
    skippedWithin: batch.skipped,
    skippedCross,
  }
}

/** 规范化 LLM 给出的 AdjustChunks 参数 → 现有 applyChunkAdjustment 的 adj 结构 */
function normalizeAdjustArgs(args) {
  const op = typeof args?.op === 'string' ? args.op.trim().toLowerCase() : ''
  if (op === 'merge') {
    const idx = Array.isArray(args.indices)
      ? args.indices.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : []
    if (idx.length >= 2) return { op: 'merge', indices: [...new Set(idx)].sort((a, b) => a - b) }
    return null
  }
  if (op === 'split') {
    const i = parseInt(args.index, 10)
    if (Number.isFinite(i) && i > 0) return { op: 'split', index: i }
    return null
  }
  if (op === 'reparam') {
    const m = Number(args.maxChars)
    if (Number.isFinite(m) && m >= 100 && m <= 5000) return { op: 'reparam', maxChars: m }
    return null
  }
  return null
}

/* ===================== 工具注册（元数据 = System Prompt 与管理界面的唯一来源） ===================== */

toolRegistry.register({
  name: 'AnalyzeDocument',
  label: '分析文档结构',
  category: 'document',
  description: '分析当前文档的结构特征（字数/段落/标题/代码/问答/表格），返回推荐切片策略',
  params: '无',
  async run(ctx) {
    const text = ctx.resolveText()
    if (!text.trim()) {
      return { observation: '错误：当前没有文档。', userText: '当前还没有文档，请先上传文件或粘贴文本。' }
    }
    const f = analyzeDocFeatures(text)
    // 初始化/刷新预览缓存（保留已有 chunks）
    const cached = getCachedPreview(ctx.cacheKey)
    setCachedPreview(ctx.cacheKey, {
      text,
      chunks: cached?.chunks ?? null,
      strategy: f.suggestedStrategy,
      opts: { ...(cached?.opts || {}), maxChars: f.maxChars },
    })
    const obs = JSON.stringify(f)
    const userText =
      `收到文档：共 ${f.chars.toLocaleString()} 字 / ${f.paragraphs} 个段落 / ${f.headings} 个标题，` +
      `${f.hasCode ? '含代码块' : '无代码'}，${f.hasQa ? '含问答结构' : '无问答'}，${f.hasTable ? '含表格' : '无表格'}。\n` +
      `推荐策略：${f.suggestedStrategy}（maxChars=${f.maxChars}）。`
    return { observation: obs, userText }
  },
})

toolRegistry.register({
  name: 'PreviewChunks',
  label: '切片预览',
  category: 'document',
  description: '按策略执行切片预览（不嵌入向量、不入库）',
  params: 'strategy（"semantic" 或 "delimiter"，可选，默认 semantic）、maxChars（数字，可选）、delimiter（字符串，strategy=delimiter 时可选）',
  async run(ctx, args) {
    const text = ctx.resolveText()
    if (!text.trim()) {
      return { observation: '错误：当前没有文档。', userText: '请先上传文档，再预览切片。' }
    }
    const strategy = args?.strategy === 'delimiter' ? 'delimiter' : 'semantic'
    const opts = {
      strategy,
      // delimiter 禁止 trim：\n / \n\n 类纯空白分隔符 trim 后变空串会被丢弃，
      // 导致落到默认 '---' → 文档无此分隔符时整篇切不开（装箱出大块）
      ...(typeof args?.delimiter === 'string' && args.delimiter.length > 0 ? { delimiter: args.delimiter } : {}),
      ...(Number.isFinite(Number(args?.maxChars)) && Number(args.maxChars) > 0 ? { maxChars: Number(args.maxChars) } : {}),
    }
    const chunks = await previewChunks(text, opts)
    setCachedPreview(ctx.cacheKey, { text, chunks, strategy, opts })
    const total = chunks.reduce((s, c) => s + (c.chars || 0), 0)
    const brief = chunks.slice(0, 5).map((c) => `第${c.idx + 1}块·${c.chars}字`).join('，')
    return {
      observation: `切片完成：共 ${chunks.length} 块，总字数 ${total}。概要：${brief}${chunks.length > 5 ? '…' : ''}`,
      userText: formatChunksPreview(chunks),
      annotation: await chunksToAnnotation(chunks, ctx.docId || '__ephemeral__', { action: 'preview' }),
    }
  },
})

toolRegistry.register({
  name: 'AdjustChunks',
  label: '调整切片',
  category: 'document',
  description: '在当前切片预览上调整',
  dependsOn: ['PreviewChunks'], // 调整对象是预览缓存切片；无缓存时虽可兜底重切，但预览链路禁用后体验降级
  params: 'op（"merge" | "split" | "reparam"）、indices（数字数组，1-based，op=merge 时如 [2,3]）、index（数字，1-based，op=split 时）、maxChars（数字，op=reparam 时）',
  async run(ctx, args) {
    const adj = normalizeAdjustArgs(args)
    if (!adj) {
      return {
        observation: '错误：AdjustChunks 参数无法解析。需要 op（merge/split/reparam）及对应 indices/index/maxChars。',
        userText: '调整指令的参数不完整，我需要知道具体操作（如合并第2、3块 / 拆分第5块 / maxChars 改成 1000）。',
      }
    }
    const cached = getCachedPreview(ctx.cacheKey)
    let chunks = cached?.chunks || null
    // 没预览过 → 先按当前缓存参数切一次（与原 adjust 分支口径一致）
    if (!chunks) {
      const text = ctx.resolveText()
      if (!text.trim()) {
        return { observation: '错误：当前没有文档。', userText: '请先上传文档并预览切片，再做调整。' }
      }
      chunks = await previewChunks(text, { strategy: cached?.strategy || 'semantic', ...(cached?.opts || {}) })
    }
    let newChunks
    if (adj.op === 'reparam') {
      const newOpts = { ...(cached?.opts || {}), maxChars: adj.maxChars }
      newChunks = await previewChunks(cached?.text || ctx.resolveText(), { strategy: cached?.strategy || 'semantic', ...newOpts })
      setCachedPreview(ctx.cacheKey, { text: cached?.text || ctx.resolveText(), chunks: newChunks, strategy: cached?.strategy || 'semantic', opts: newOpts })
    } else {
      newChunks = applyChunkAdjustment(chunks, adj)
      setCachedPreview(ctx.cacheKey, { ...(cached || {}), text: cached?.text || ctx.resolveText(), chunks: newChunks })
    }
    const verb = adj.op === 'merge' ? `合并第 ${adj.indices.join('、')} 块` : adj.op === 'split' ? `拆分第 ${adj.index} 块` : `按 maxChars=${adj.maxChars} 重新切片`
    return {
      observation: `已${verb}，现在共 ${newChunks.length} 块。`,
      userText: `已${verb}，现在共 ${newChunks.length} 块：\n\n${formatChunksPreview(newChunks)}`,
      annotation: await chunksToAnnotation(newChunks, ctx.docId || '__ephemeral__', { action: 'preview' }),
    }
  },
})

toolRegistry.register({
  name: 'CommitToStore',
  label: '写入知识库',
  category: 'document',
  description: '把当前切片正式入库（含 embedding 与检索标注）',
  params: '无。⚠ 必须用户明确同意（如说"入库"、"确认"）后才能调用',
  async run(ctx, args, extra) {
    const text = ctx.resolveText()
    if (!text.trim()) {
      return { observation: '错误：当前没有文档。', userText: '请先上传文档，再入库。' }
    }
    // 代码级守卫：用户没明确确认过就拒绝入库（Prompt 约束的兜底）
    if (!hasCommitConfirmation(extra.query, extra.history)) {
      return {
        observation: '被拒绝：用户尚未明确确认入库。请用 FINISH 向用户确认是否入库。',
        userText: '入库前需要你的确认：当前切片结果确定要写入知识库吗？回复"入库"即可。',
      }
    }
    const cached = getCachedPreview(ctx.cacheKey)
    // 有已调整的预览 → 直接用（保留用户的合并/拆分）；否则走完整链路从原文切
    let chunkList
    let vectors
    let questionVectors
    if (cached?.chunks?.length) {
      ;({ chunkList, vectors, questionVectors } = await prepareAdjustedChunks(cached.chunks))
    } else {
      ;({ chunkList, vectors, questionVectors } = await prepareDocChunksAndVectors(text, {
        strategy: cached?.strategy,
        delimiter: cached?.strategy === 'delimiter' ? cached.opts?.delimiter : undefined,
        maxChars: cached?.opts?.maxChars,
      }))
    }
    // 文档去重（§9 扩展）：批内 + 跨文档（Milvus 检索比对）
    const deduped = await dedupPreparedChunks(chunkList, vectors, questionVectors)
    chunkList = deduped.chunkList
    vectors = deduped.vectors
    questionVectors = deduped.questionVectors
    // 确保 doc 存在（粘贴文本等场景下还没有 doc）
    let docId = ctx.docId
    if (!docId || !store.getDocument(docId, ctx.ownerId)) {
      const doc = await store.createDocument({
        title: `文档处理入库 ${new Date().toLocaleString('zh-CN')}`,
        category: '',
        tags: [],
        size: Buffer.byteLength(text, 'utf8'),
        content: text,
        source: 'doc-processor-agent',
        ownerId: ctx.ownerId,
      })
      docId = doc.id
      ctx.docId = docId
    }
    await store.addChunks(docId, chunkList, vectors, { category: '', tags: [], ownerId: ctx.ownerId, questionVectors })
    // 记录切片策略：后续编辑正文 / reindex 重切时按此恢复，切片格式不漂移
    // （用户手动调整过的预览块无法重放，但重切仍按原策略口径执行）
    store.setDocStrategy(docId, {
      strategy: cached?.strategy === 'delimiter' ? 'delimiter' : 'semantic',
      delimiter: cached?.strategy === 'delimiter' ? cached.opts?.delimiter : undefined,
      maxChars: cached?.opts?.maxChars,
      overlapChars: cached?.opts?.overlapChars,
    })
    clearCachedPreview(ctx.cacheKey)
    const totalChars = chunkList.reduce((s, c) => s + (typeof c.text === 'string' ? c.text.length : 0), 0)
    log.info(`[docTools] 入库 doc ${docId} | ${chunkList.length} 块 | ${totalChars} 字 | 去重跳过 批内${deduped.skippedWithin} 跨文档${deduped.skippedCross}`)
    const dedupNote =
      deduped.skippedWithin + deduped.skippedCross > 0
        ? `\n- 自动去重：跳过 ${deduped.skippedWithin + deduped.skippedCross} 个重复块（批内 ${deduped.skippedWithin}，跨文档 ${deduped.skippedCross}）`
        : ''
    return {
      observation: `入库成功：doc ${docId}，共 ${chunkList.length} 块，总字数 ${totalChars}，去重跳过 批内${deduped.skippedWithin}+跨文档${deduped.skippedCross}。`,
      userText:
        `✅ 文档入库成功\n` +
        `- 切片数：${chunkList.length} 块\n` +
        `- 总字数：${totalChars.toLocaleString()}\n` +
        `- 已生成 topic 标注和检索锚点${dedupNote}\n\n` +
        `可在「知识库」智能体中检索，或对我说"导出"把整理后的内容导出为 Markdown。`,
    }
  },
})

toolRegistry.register({
  name: 'ExportMarkdown',
  label: '导出 Markdown',
  category: 'document',
  description: '把当前切片结果导出为 Markdown 文本',
  params: '无',
  async run(ctx) {
    const cached = getCachedPreview(ctx.cacheKey)
    let chunks = cached?.chunks || null
    if (!chunks) {
      const text = ctx.resolveText()
      if (!text.trim()) {
        return { observation: '错误：当前没有文档。', userText: '请先上传文档并预览切片，再导出。' }
      }
      chunks = await previewChunks(text, { strategy: cached?.strategy || 'semantic' })
      setCachedPreview(ctx.cacheKey, { text, chunks, strategy: cached?.strategy || 'semantic', opts: cached?.opts || {} })
    }
    const md = exportChunksAsMarkdown(chunks)
    return {
      observation: `导出完成：共 ${chunks.length} 块的 Markdown，${md.length} 字。`,
      userText:
        `以下是整理后的 Markdown（共 ${chunks.length} 块，${md.length.toLocaleString()} 字）：\n\n${md}\n\n———\n* 可复制保存为 .md 文件。`,
    }
  },
})
