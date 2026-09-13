import { listAllChunks } from './milvusStore.js'
import {
  extractWikiEntities,
  normalizeWikiEntities,
  summarizeWikiEntry,
  llmAvailable,
} from './llm.js'
import * as wikiStore from './wikiStore.js'
import { wikiConfig } from './config.js'
import { childLogger } from './logger.js'
import { ServiceUnavailableError } from './errors.js'

/**
 * wikiBuilder —— LLM Wiki 词条生成编排（L4 领域层）
 *
 * 手动触发的后台三阶段流水线（管理端 POST /api/management/wiki/generate）：
 *  1. extracting   实体抽取：遍历全部切片，LLM 识别实体（名称/类型/原句）；
 *     切片内容哈希未变即跳过（增量），每块抽取完成即落盘（断点续跑）
 *  2. normalizing  归一合并：全库实体名去重后 LLM 归组（中英文写法/简称
 *     全称/大小写差异合并为同一条目），整表写入词条（提及不变继承摘要）
 *  3. summarizing  词条摘要：无摘要的词条逐条生成百科式摘要，逐条落盘
 *
 * 降级口径（ADR-009）：LLM 不可用直接显式报错（503），词条归一失败任务
 * 失败可重试；抽取/摘要的单批失败不静默丢弃——不写哈希/不落摘要，
 * 下次生成自动续跑重试，任务回执中显式计数（failedBatches/failedSummaries）。
 *
 * 取消语义：任意阶段间检查取消标记，任务标记 cancelled 已写入的数据
 * 保留（下次续跑可用）。任务记录内存态保留 10 分钟（前端轮询恢复窗口）。
 *
 * 分层约束：不感知 HTTP（端点在 manager.js）；存储经 wikiStore（L1）；
 * LLM 调用经 llm.js（L3）。
 */

const log = childLogger('wikiBuilder')

/** 抽取批次大小（与 generateChunkAnnotations 同款：本地模型单次输出 token 有限） */
const EXTRACT_BATCH = 4
/** 归一批次大小（实体名列表较长时分组归一） */
const NORMALIZE_BATCH = 40
/** 任务记录保留时长（与上传 job 同款：前端刷新页面后仍可恢复轮询） */
const JOB_TTL_MS = 10 * 60 * 1000
/** 内存中最多保留的任务记录数 */
const JOB_MAX = 20

/** @type {Map<string, object>} jobId → 任务记录 */
const jobs = new Map()

/** 取消哨兵（内部控制流，runWikiJob 捕获后落 cancelled 状态） */
const CANCELLED = Symbol('wiki-cancelled')

/** 新建任务记录 */
function newJob() {
  return {
    id: `wiki-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    stage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancelRequested: false,
    progress: { processed: 0, total: 0, failed: 0 },
    result: null,
    error: null,
  }
}

/** 任务记录 GC：结束后保留 TTL 再移除；运行中任务不回收（生成全程可达）+ 上限裁剪 */
function scheduleJobGc(job) {
  setTimeout(() => {
    // 仍在运行（如全量抽取耗时 30 分钟+）：顺延一个周期再查，避免前端轮询中途 404
    if (job.status === 'running') {
      scheduleJobGc(job)
      return
    }
    jobs.delete(job.id)
  }, JOB_TTL_MS).unref?.()
  if (jobs.size > JOB_MAX) {
    // 最老的先移除（Map 保持插入序；运行中任务排尾不在此列）
    for (const id of jobs.keys()) {
      if (jobs.size <= JOB_MAX) break
      if (jobs.get(id)?.status === 'running') continue
      jobs.delete(id)
    }
  }
}

/** 取消检查点：批间/条间调用，被标记即抛 CANCELLED */
function ensureNotCancelled(job) {
  if (job.cancelRequested) throw CANCELLED
}

/**
 * 启动词条生成任务。已有进行中任务时返回该任务（幂等触发）。
 * LLM 不可用直接抛 ServiceUnavailableError（manager 转 503）。
 * @returns {{ jobId: string, alreadyRunning: boolean }}
 */
export function startWikiJob(ownerId = 'local') {
  for (const j of jobs.values()) {
    if (j.status === 'running') return { jobId: j.id, alreadyRunning: true }
  }
  if (!llmAvailable) {
    throw new ServiceUnavailableError(
      '模型未连接：Wiki 词条生成需要 LLM。请在 server/.env 配置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 后重启后端。',
      'LLM_NOT_CONFIGURED',
    )
  }
  const job = newJob()
  job.ownerId = ownerId
  jobs.set(job.id, job)
  scheduleJobGc(job)
  log.info(`[wikiBuilder] 任务 ${job.id} 启动`)
  // 后台执行（不阻塞 HTTP 响应）；异常全部在 runWikiJob 内部落状态
  runWikiJob(job).catch((err) => {
    job.status = 'error'
    job.error = err?.message || String(err)
    job.finishedAt = new Date().toISOString()
    log.error(`[wikiBuilder] 任务 ${job.id} 未预期失败：${job.error}`)
  })
  return { jobId: job.id, alreadyRunning: false }
}

/**
 * 查询任务进度。
 * @returns {object|null} 任务记录（不存在/已过期返回 null）
 */
export function getWikiJob(jobId) {
  return jobs.get(jobId) ?? null
}

/** 当前进行中的任务（状态查询 / 清空前检查用；无则 null） */
export function getRunningWikiJob() {
  for (const j of jobs.values()) {
    if (j.status === 'running') return j
  }
  return null
}

/**
 * 取消任务：进行中 → 标记取消（流水线在下一个检查点停止，已写入数据保留）；
 * 已结束 → 幂等返回当前状态。
 * @returns {object|null} 任务记录
 */
export function cancelWikiJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return null
  if (job.status === 'running') job.cancelRequested = true
  return job
}

/* ===================== 阶段实现 ===================== */

/** 阶段 1：实体抽取（哈希增量：内容未变的切片跳过） */
async function stageExtract(job) {
  const chunks = await listAllChunks()
  // 对账：清掉已消失切片的抽取记录（文档删除后）
  wikiStore.reconcileChunkExtractions(new Set(chunks.map((c) => c.id)), job.ownerId)
  const pending = chunks.filter((c) => {
    const rec = wikiStore.getExtraction(c.id, job.ownerId)
    return !rec || rec.hash !== wikiStore.hashText(c.text)
  })
  job.stage = 'extracting'
  job.progress = { processed: 0, total: pending.length, failed: 0 }
  let reused = chunks.length - pending.length
  let failedBatches = 0
  for (let s = 0; s < pending.length; s += EXTRACT_BATCH) {
    ensureNotCancelled(job)
    const batch = pending.slice(s, s + EXTRACT_BATCH)
    try {
      const entitiesByIdx = await extractWikiEntities(
        batch.map((c, i) => ({
          idx: s + i,
          heading: c.heading || '',
          text: String(c.text ?? '').slice(0, 800),
        })),
        {
          entitiesPerChunk: wikiConfig.entitiesPerChunk,
          timeoutMs: wikiConfig.extractTimeoutMs,
        },
      )
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i]
        // 空实体也是合法抽取结果（写入哈希防止重复抽取无实体的块）
        wikiStore.putExtraction(c.id, {
          hash: wikiStore.hashText(c.text),
          entities: entitiesByIdx.get(s + i) ?? [],
        }, job.ownerId)
      }
    } catch (err) {
      // 单批失败不落哈希 → 下次生成续跑重试；任务回执显式计数
      failedBatches++
      job.progress.failed += batch.length
      log.warn(
        `[wikiBuilder] 任务 ${job.id} 抽取批次 ${s}~${s + batch.length - 1} 失败（${err.message}），下次生成续跑重试`,
      )
    }
    job.progress.processed += batch.length
  }
  return { totalChunks: chunks.length, reusedChunks: reused, failedBatches }
}

/** 阶段 2：归一合并（实体名 → 词条表，提及继承摘要） */
async function stageNormalize(job) {
  // 汇总全部抽取记录：实体名 → 提及列表（chunkId + 原句上下文 + 类型）
  const chunks = await listAllChunks()
  const chunkOrder = new Map(chunks.map((c, i) => [c.id, i]))
  /** @type {Map<string, Array<{chunkId:string, context:string, type:string}>>} */
  const mentions = new Map()
  for (const c of chunks) {
    const rec = wikiStore.getExtraction(c.id, job.ownerId)
    if (!rec?.entities) continue
    for (const e of rec.entities) {
      if (!chunkOrder.has(c.id)) continue // 防御：抽取记录晚于切片删除
      const list = mentions.get(e.name) ?? []
      list.push({
        chunkId: c.id,
        context: e.context || String(c.text ?? '').slice(0, wikiConfig.mentionContextChars),
        type: e.type || 'term',
      })
      mentions.set(e.name, list)
    }
  }
  const names = [...mentions.keys()]
  job.stage = 'normalizing'
  job.progress = { processed: 0, total: names.length, failed: 0 }
  // 分批 LLM 归组（失败任务整体失败可重试——抽取结果已落盘，重试零成本）
  /** @type {Array<{canonical:string, aliases:string[]}>} */
  const rawGroups = []
  for (let s = 0; s < names.length; s += NORMALIZE_BATCH) {
    ensureNotCancelled(job)
    const batch = names.slice(s, s + NORMALIZE_BATCH)
    rawGroups.push(
      ...(await normalizeWikiEntities(batch, {
        timeoutMs: wikiConfig.extractTimeoutMs,
      })),
    )
    job.progress.processed += batch.length
  }
  // 同 canonical 去重合并：LLM 跨批次可能对同一实体返回多组（组间别名不同），
  // 不合并会产生重复 id 词条（网络图节点 id 冲突，ECharts 直接抛错）
  /** @type {Map<string, {canonical:string, aliases:string[]}>} */
  const groupByKey = new Map()
  for (const g of rawGroups) {
    const key = String(g.canonical ?? '').trim().toLowerCase()
    if (!key) continue
    const prev = groupByKey.get(key)
    if (prev) {
      prev.aliases = [...new Set([...prev.aliases, ...(g.aliases ?? [])])]
    } else {
      groupByKey.set(key, { canonical: g.canonical, aliases: [...(g.aliases ?? [])] })
    }
  }
  const groups = [...groupByKey.values()]
  // 组 → 词条（提及按切片顺序稳定排序）
  const entries = groups.map((g) => {
    const all = [g.canonical, ...g.aliases].filter((n) => mentions.has(n))
    const ms = all.flatMap((n) => mentions.get(n))
    ms.sort((a, b) => (chunkOrder.get(a.chunkId) ?? 0) - (chunkOrder.get(b.chunkId) ?? 0))
    // 词条类型 = 提及中出现最多的实体类型
    const typeCount = new Map()
    for (const m of ms) typeCount.set(m.type, (typeCount.get(m.type) ?? 0) + 1)
    const type = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'term'
    return {
      id: `w-${wikiStore.hashText(g.canonical).slice(0, 12)}`,
      name: g.canonical,
      aliases: g.aliases,
      type,
      mentionChunkIds: [...new Set(ms.map((m) => m.chunkId))],
      mentionContexts: ms.slice(0, 24).map((m) => m.context),
      summary: '',
      generatedAt: null,
      createdAt: new Date().toISOString(),
    }
  })
  // 按提及数降序截断至上限
  entries.sort((a, b) => b.mentionChunkIds.length - a.mentionChunkIds.length)
  const kept = entries.slice(0, wikiConfig.maxEntries)
  wikiStore.putEntries(kept, job.ownerId)
  return { entries: kept.length, dropped: entries.length - kept.length }
}

/** 阶段 3：词条摘要（无摘要词条逐条生成，逐条落盘续跑） */
async function stageSummarize(job) {
  const entries = wikiStore
    .listEntries(job.ownerId)
    .filter((e) => !e.summary)
  job.stage = 'summarizing'
  job.progress = { processed: 0, total: entries.length, failed: 0 }
  let failedSummaries = 0
  for (const e of entries) {
    ensureNotCancelled(job)
    try {
      const summary = await summarizeWikiEntry(
        { name: e.name, aliases: e.aliases, contexts: e.mentionContexts },
        {
          budgetChars: wikiConfig.summaryBudgetChars,
          timeoutMs: wikiConfig.summaryTimeoutMs,
        },
      )
      wikiStore.updateEntry(e.id, {
        summary,
        generatedAt: new Date().toISOString(),
      }, job.ownerId)
    } catch (err) {
      failedSummaries++
      log.warn(`[wikiBuilder] 任务 ${job.id} 词条「${e.name}」摘要失败（${err.message}），下次生成续跑重试`)
    }
    job.progress.processed += 1
  }
  return { failedSummaries }
}

/** 流水线主体：三阶段顺序执行，取消/异常落状态 */
async function runWikiJob(job) {
  const t0 = performance.now()
  try {
    const extractStats = await stageExtract(job)
    const normalizeStats = await stageNormalize(job)
    const summarizeStats = await stageSummarize(job)
    job.status = 'done'
    job.finishedAt = new Date().toISOString()
    job.result = {
      ...wikiStore.stats(job.ownerId),
      ...extractStats,
      ...normalizeStats,
      ...summarizeStats,
      durationMs: Math.round(performance.now() - t0),
    }
    log.info(
      `[wikiBuilder] 任务 ${job.id} 完成：词条 ${job.result.entries} 条（摘要 ${job.result.summarized}）· 抽取 ${job.result.extractedChunks}/${job.result.totalChunks} 块（复用 ${job.result.reusedChunks}）· ${job.result.durationMs}ms`,
    )
  } catch (err) {
    if (err === CANCELLED) {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.result = { ...wikiStore.stats(job.ownerId), stage: job.stage }
      log.info(`[wikiBuilder] 任务 ${job.id} 已取消（阶段 ${job.stage}，已写入数据保留）`)
      return
    }
    job.status = 'error'
    job.error = err?.message || String(err)
    job.finishedAt = new Date().toISOString()
    log.error(`[wikiBuilder] 任务 ${job.id} 失败：${job.error}`)
  }
}

/* ===================== 图数据叠加（manager graph 端点用） ===================== */

/**
 * 图节点 ID 解析（v3 重构期间提及边落到实际存在的切片）。
 *
 * v2 的 chunk id 形如 chk_{docId}_{idx}_{rand}，v3 锚点层形如 chk_{docId}_{idx}。
 * wiki 存量抽取记录保留的是当时生成词条所用的 ID，叠加到图时需匹配当前图节点。
 * 优先原样命中 → 其次 v2↔v3 形态互转（同文档同序号），
 * 避免提及边整批丢失（v3 数据迁移期实测 559 条边 ID 全不命中）。
 * @param {string} cid wiki 记录里的切片 ID
 * @param {{ idSet:Set<string>, posToId:Map<string,string> }} resolver 解析索引
 * @returns {string|null} 图上实际存在的节点 id
 */
export function resolveGraphChunkId(cid, resolver) {
  if (!resolver || typeof cid !== 'string' || !cid) return null
  if (resolver.idSet.has(cid)) return cid
  const m = /^chk_(.+)_(\d+)(?:_[A-Za-z0-9]+)?$/.exec(cid)
  if (m) {
    // v2 ↔ v3 形态互转：chk_{docId}_{idx}_{rand} ↔ chk_{docId}_{idx}
    const mapped = resolver.posToId.get(`${m[1]}|${m[2]}`)
    if (mapped) return mapped
  }
  return null
}

/** 为当前图节点构建 ID 解析索引（供 resolveGraphChunkId 使用） */
export function buildGraphIdResolver(nodes) {
  const idSet = new Set(nodes.map((n) => n.id))
  const posToId = new Map()
  for (const n of nodes) {
    if (n.type !== 'chunk' || !n.docId) continue
    posToId.set(`${n.docId}|${n.idx ?? 0}`, n.id)
  }
  return { idSet, posToId }
}

/**
 * 构造 wiki 词条图节点与提及边（叠加在切片相似网络之上）。
 * 提及边 similarity=1（结构边不受阈值滑杆裁剪，2D/3D 按强边渲染），
 * kind='mention' 供 tooltip 显示「词条提及」。
 * @param {Set<string>} existingNodeIds 切片图已有节点 id（提及边只连存在的切片）
 * @param {string} [ownerId] 数据归属（'*' = 聚合全部 owner）
 * @param {{resolver?: ReturnType<typeof buildGraphIdResolver>}} [opts]
 *        v3 迁移期传入 resolver 以兼容历史抽取记录的不同 ID 形态
 */
export function buildWikiGraphPart(existingNodeIds, ownerId = '*', opts = {}) {
  const entries = wikiStore.listEntries(ownerId)
  const resolver = opts.resolver ?? null
  // 词条 → 实际挂到的图节点 id 集合（去重，一条边不重复连同一节点）
  const targetsOf = (e) => {
    const seen = new Set()
    for (const cid of e.mentionChunkIds ?? []) {
      const hit = resolver
        ? resolveGraphChunkId(cid, resolver)
        : existingNodeIds.has(cid)
          ? cid
          : null
      if (hit) seen.add(hit)
    }
    return [...seen]
  }
  const resolved = entries.map((e) => ({ e, targets: targetsOf(e) }))
  const nodes = resolved.map(({ e, targets }) => ({
    id: `wiki:${e.id}`,
    type: 'wiki',
    name: e.name,
    aliases: e.aliases ?? [],
    entityType: e.type,
    summary: e.summary ?? '',
    // 3D tooltip 兜底字段（无摘要时显示首个提及上下文）
    snippet: e.summary || (e.mentionContexts?.[0] ?? ''),
    topic: 'Wiki 词条',
    docId: '',
    docTitle: '',
    degree: targets.length,
    raw: e,
  }))
  const edges = []
  for (const { e, targets } of resolved) {
    for (const t of targets) {
      edges.push({ source: `wiki:${e.id}`, target: t, similarity: 1, kind: 'mention' })
    }
  }
  return { nodes, edges }
}
