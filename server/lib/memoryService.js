/**
 * memoryService —— 会话记忆领域服务（M2 / ADR-007）
 *
 * 两层记忆：
 *   短期层  会话内滚动摘要：sessionStore.session_memory 表，游标 summary_until_seq
 *   长期层  跨会话事实向量库：Milvus kb_memory（scope=global|session），游标 extract_until_seq
 *
 * 失败语义（ADR-009「无增强有效实现」类）：记忆是增强层，召回/提炼失败时对话主链路
 * 仍然完整可用 —— 允许在显式 warn 日志后继续，但禁止静默吞掉；提炼游标不前进，
 * 下一轮自动重试，content_hash 去重保证重试幂等。
 *
 * 接线（routes/chat.js）：
 *   - dispatch 前   recallBlock() → ctx.memoryBlock（召回失败不阻断对话）
 *   - 回答落库后    onTurnEnd()（fire-and-forget，同一会话进行中去重）
 */
import { randomUUID, createHash } from 'node:crypto'
import { childLogger } from './logger.js'
import { tunables } from './tunables.js'
import * as sessionStore from './sessionStore.js'
import * as milvusStore from './milvusStore.js'
import { embedTexts, embedMode } from './embed.js'
import { summarizeSession, extractMemories } from './llm.js'

const log = childLogger('memoryService')

/** 记忆专用模型路由：走通用对话角色 + 按智能体绑定（三级路由，ADR-006） */
const MEMORY_ROLE = 'chat.general'

/** 同一会话的轮末处理去重：上一轮尚未跑完时本轮直接跳过（下轮再触发） */
const inFlight = new Map()

/** 消息行 id（msg_N，N 为全局单调 seq）→ 序号 */
function seqOf(m) {
  const n = Number(String(m.id ?? '').replace(/^msg_/, ''))
  return Number.isFinite(n) ? n : 0
}

/** scope|text 的 sha256，作为长期层去重键（64 字符，适配 LEN.id=128） */
function factHash(scope, text) {
  return createHash('sha256').update(`${scope}|${text}`).digest('hex')
}

/* ==================== 召回（短期层 + 长期层） ==================== */

/**
 * 召回会话记忆：滚动摘要 + 与当前 query 语义相关的已知事实。
 * @param {{sessionId: string, agentName?: string, query?: string}} p
 * @returns {Promise<{summary: string, facts: Array<{text: string, scope: string, score: number}>}>}
 */
export async function recall({ sessionId, agentName, query, ownerId }) {
  if (!sessionId || !ownerId) return { summary: '', facts: [] }
  if (!tunables.memory?.enabled) return { summary: '', facts: [] }

  const state = sessionStore.getMemoryState(sessionId, ownerId)
  const summary = state.summary || ''

  let facts = []
  if (query && embedMode() === 'external') {
    try {
      const [vec] = await embedTexts([query])
      facts = await milvusStore.searchMemories(vec, {
        topK: tunables.memory.recallTopK,
        sessionId,
        ownerId,
      })
    } catch (err) {
      // 显式降级：本轮不带事实记忆继续（对话主链路不依赖记忆），warn 留痕
      log.warn({ details: err.message }, `[memory] 记忆召回失败（会话 ${sessionId}），本轮不带事实记忆`)
      facts = []
    }
  }
  return { summary, facts }
}

/**
 * 把召回结果拼成注入 system prompt 的记忆块；无记忆返回空串（不注入）。
 * @param {{summary?: string, facts?: Array<{text: string, scope: string}>}} memory
 */
export function buildMemoryBlock({ summary, facts } = {}) {
  if (!summary && !facts?.length) return ''
  const factCap = Number(tunables.memory?.factBudgetChars) || 800
  const lines = ['【会话记忆】下面是关于该用户的已知信息，可在回答中自然参考，但不要逐条罗列或复述：']
  if (summary) lines.push(`[对话摘要] ${summary}`)
  for (const f of facts ?? []) {
    lines.push(`[已知事实·${f.scope === 'global' ? '长期' : '本会话'}] ${String(f.text ?? '').slice(0, factCap)}`)
  }
  return lines.join('\n')
}

/** recall + buildMemoryBlock 一步到位；任何异常都只 warn 并返回空串（不阻断对话） */
export async function recallBlock({ sessionId, agentName, query }) {
  try {
    return buildMemoryBlock(await recall({ sessionId, agentName, query }))
  } catch (err) {
    log.warn({ details: err.message }, `[memory] 记忆召回异常（会话 ${sessionId}），本轮不带记忆`)
    return ''
  }
}

/* ==================== 轮末处理（摘要滚动 + 事实提炼） ==================== */

/**
 * 轮末触发（fire-and-forget）：推进滚动摘要 + 提炼长期事实。
 * 同一会话有进行中的处理时直接跳过；失败只 warn，游标不前进，下轮重试。
 * @param {{sessionId: string, agentName?: string}} p
 */
export function onTurnEnd({ sessionId, agentName, ownerId }) {
  if (!sessionId || !ownerId) return
  if (!tunables.memory?.enabled) return
  if (inFlight.has(sessionId)) return
  const task = runTurnEnd({ sessionId, agentName, ownerId })
    .catch((err) => {
      log.warn(
        { details: err.message, stack: err.stack },
        `[memory] 轮末记忆处理失败（会话 ${sessionId}），游标不前进，下轮重试`,
      )
    })
    .finally(() => inFlight.delete(sessionId))
  inFlight.set(sessionId, task)
}

async function runTurnEnd({ sessionId, agentName, ownerId }) {
  const msgs = sessionStore.getMessages(sessionId, ownerId).map((m) => ({ ...m, seq: seqOf(m) }))

  const summaryUntilSeq = await rollSummary({ sessionId, agentName, msgs, ownerId })
  // 摘要滚动可能已写库，重读最新状态再提炼，避免游标互相覆盖
  const state = sessionStore.getMemoryState(sessionId, ownerId)
  await extractFacts({
    sessionId,
    agentName,
    msgs,
    ownerId,
    state: { ...state, summaryUntilSeq },
  })
}

/**
 * 短期层：自上一次摘要游标以来新增的用户轮数达到 summaryEveryTurns 时，
 * 把「旧摘要 + 新增消息」压缩为新的滚动摘要并推进游标。
 * @returns {Promise<number>} 本次实际生效的摘要游标（未滚动则维持原值）
 */
async function rollSummary({ sessionId, agentName, msgs, ownerId }) {
  const state = sessionStore.getMemoryState(sessionId, ownerId)
  const every = Number(tunables.memory?.summaryEveryTurns) || 6
  const pending = msgs.filter((m) => m.seq > state.summaryUntilSeq)
  const pendingUserTurns = pending.filter((m) => m.role === 'user').length
  if (!pending.length || pendingUserTurns < every) return state.summaryUntilSeq

  const lastSeq = pending[pending.length - 1].seq
  const summary = await summarizeSession({
    prevSummary: state.summary,
    turns: pending,
    budgetChars: Number(tunables.memory?.summaryBudgetChars) || 600,
    role: MEMORY_ROLE,
    agentId: agentName || undefined,
  })
  sessionStore.setMemoryState(sessionId, ownerId, {
    summary,
    summaryUntilSeq: lastSeq,
    extractUntilSeq: state.extractUntilSeq,
  })
  log.info(`[memory] 会话 ${sessionId} 摘要已滚动（覆盖至 seq=${lastSeq}，新增 ${pending.length} 条消息）`)
  return lastSeq
}

/**
 * 长期层：自提炼游标以来新增的用户轮数达到 extractEveryTurns 时，
 * 用 LLM 提炼事实 → content_hash 去重 → 向量化入库（scope=global 全局 / session 本会话）。
 * 游标只在事实成功持久化（或合法空结果）后推进。
 */
async function extractFacts({ sessionId, agentName, msgs, ownerId, state }) {
  const every = Number(tunables.memory?.extractEveryTurns) || 4
  const maxFacts = Number(tunables.memory?.maxFactsPerExtract) || 5
  const pending = msgs.filter((m) => m.seq > state.extractUntilSeq)
  const pendingUserTurns = pending.filter((m) => m.role === 'user').length
  if (!pending.length || pendingUserTurns < every) return
  const lastSeq = pending[pending.length - 1].seq

  if (embedMode() !== 'external') {
    // Fail-Fast：embedding 不可用时不推进游标、不静默丢弃 —— 恢复后自动补跑积压
    log.warn(`[memory] 会话 ${sessionId} 事实提炼暂缓：embedding 不可用（游标保持 seq=${state.extractUntilSeq}）`)
    return
  }

  const facts = await extractMemories({
    turns: pending,
    maxFacts,
    role: MEMORY_ROLE,
    agentId: agentName || undefined,
  })
  if (!facts.length) {
    // 合法空结果（没有值得记的内容）→ 只推进游标
    sessionStore.setMemoryState(sessionId, ownerId, {
      summary: state.summary,
      summaryUntilSeq: state.summaryUntilSeq,
      extractUntilSeq: lastSeq,
    })
    return
  }

  const withHash = facts.map((f) => ({ ...f, contentHash: factHash(f.scope, f.text) }))
  // 去重：与库内已有事实（含其他会话写入的 global 事实）比对 content_hash
  const hashFilter = `content_hash in [${withHash.map((f) => `"${f.contentHash}"`).join(',')}]`
  const existing = await milvusStore.listMemories({ filter: hashFilter, limit: withHash.length * 4 })
  const existHashes = new Set(existing.map((m) => m.contentHash))
  const fresh = withHash.filter((f) => !existHashes.has(f.contentHash))

  if (fresh.length) {
    const vectors = await embedTexts(fresh.map((f) => f.text))
    const rows = fresh.map((f, i) => ({
      id: `mem_${randomUUID()}`,
      scope: f.scope,
      // global 事实跨会话共享，不挂会话归属；session 事实只召回给本会话
      sessionId: f.scope === 'global' ? '' : sessionId,
      agentName: agentName ?? '',
      ownerId,
      kind: 'fact',
      text: f.text,
      contentHash: f.contentHash,
      ts: Date.now(),
      vector: vectors[i],
    }))
    await milvusStore.insertMemories(rows)
    // 写耐久（同 ADR-004 策略）：flush 后才视为「已记住」，防止硬杀丢记忆
    await milvusStore.flush([milvusStore.getCollections().memory])
    log.info(`[memory] 会话 ${sessionId} 新增长期事实 ${fresh.length} 条（跳过重复 ${withHash.length - fresh.length} 条）`)
  }

  sessionStore.setMemoryState(sessionId, ownerId, {
    summary: state.summary,
    summaryUntilSeq: state.summaryUntilSeq,
    extractUntilSeq: lastSeq,
  })
}

/**
 * 显式写入一条长期事实（scope=global）—— 供 ReAct 规划器的 memory.write 工具调用。
 * 与自动提炼（extractFacts）同一口径：content_hash 去重 → 向量化 → 入库 → flush 才算「已记住」。
 * embedding 不可用时 Fail-Fast 抛错（工具层会把错误作为 Observation 回传，由 Thought 层感知）。
 * @param {{ text: string, ownerId: string, agentName?: string, sessionId?: string }} p
 * @returns {Promise<{ written: boolean, reason?: string, id?: string }>} written=false 表示与已有事实重复
 */
export async function writeGlobalFact({ text, ownerId, agentName, sessionId }) {
  const t = String(text ?? '').trim()
  if (!t) return { written: false, reason: 'empty' }
  if (!ownerId) throw new Error('writeGlobalFact 缺少 ownerId')
  if (embedMode() !== 'external') throw new Error('embedding 不可用，无法写入长期记忆')

  const contentHash = factHash('global', t)
  const existing = await milvusStore.listMemories({ filter: `content_hash == "${contentHash}"`, limit: 1 })
  if (existing?.length) return { written: false, reason: 'duplicate' }

  const [vec] = await embedTexts([t])
  const row = {
    id: `mem_${randomUUID()}`,
    scope: 'global',
    sessionId: '',
    agentName: agentName ?? '',
    ownerId,
    kind: 'fact',
    text: t,
    contentHash,
    ts: Date.now(),
    vector: vec,
  }
  await milvusStore.insertMemories([row])
  await milvusStore.flush([milvusStore.getCollections().memory])
  log.info(`[memory] 显式写入长期事实（owner=${ownerId}）：${t.slice(0, 60)}${t.length > 60 ? '…' : ''}`)
  return { written: true, id: row.id }
}
