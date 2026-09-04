/**
 * runtimeAnnotations —— 绕过 Vercel AI SDK useChat 的 messages 状态覆盖问题。
 *
 * 背景：useChat 在流式输出时，每收到一个 0:text 分片就会重写 messages 数组中最后一条
 * assistant message，导致我们手动 setMessages 打进的 `annotations` 字段立刻被 SDK 覆盖
 * （面板只闪 1 帧就消失）。所以 annotations 不能存在 messages 里，必须存在独立 Map。
 *
 * 存储模型（双索引策略）：
 *   1. 主索引：Map<chatId, Map<messageId, annotations>>
 *      用于通过 message.id 精确查找（适用于历史会话恢复）
 *   2. 回退索引：Map<chatId, Array<annotations>>
 *      按轮次排列，用于索引查找（适用于流式生成时 SDK 消息 ID 不稳定的情况）
 *
 * 写：useChatWithAnnotations 拦截到后端 `2:` 行时，调用 appendChatAnnotation
 *     把 parsed annot 数组存储到两个索引中。
 * 读：StreamingMessage 渲染时，先通过 message.id 查找，找不到则通过回退索引按轮次查找。
 *
 * 清理：组件卸载 / messages 清空 / 切换 chatId。
 */

import { child } from '@/lib/logger'

const log = child('annotations')

/**
 * @type {Map<string, Map<string, Array>>}
 * 主索引：chatId -> (messageId -> annotations)
 */
const store = new Map()

/**
 * @type {Map<string, Array<Array>>}
 * 回退索引：chatId -> annotations queue（每轮一个 annot 数组，按对话轮次顺序）
 * 用于在 SDK 消息 ID 不稳定时（流式生成中）按轮次查找
 */
const queueStore = new Map()

// ── 内存上限（防多会话/长会话切换导致 Map 无限增长）──
const MAX_CHAT_ENTRIES = 50 // 最多保留多少个 chat 的注解（LRU：超出淘汰最久未触碰的 chat）
const MAX_MESSAGES_PER_CHAT = 200 // 单个 chat 最多保留多少条消息注解（超出裁最旧，__pending__ 除外）

/** LRU 淘汰：store/queueStore 同步删除最旧 chat（Map 迭代序 = 插入序，读时 delete+set 触碰前置） */
function _evictIfOverflow() {
  while (store.size > MAX_CHAT_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
    queueStore.delete(oldest)
    log.debug('[runtimeAnnotations] LRU 淘汰最旧 chat 注解', { chatId: oldest })
  }
}

/** 单 chat 消息注解条数上限：超出时裁掉最旧的消息条目（保留 __pending__ 流式累积区） */
function _trimChatMessages(chatMap) {
  if (chatMap.size <= MAX_MESSAGES_PER_CHAT) return
  for (const msgKey of chatMap.keys()) {
    if (msgKey === '__pending__') continue
    chatMap.delete(msgKey)
    if (chatMap.size <= MAX_MESSAGES_PER_CHAT) break
  }
}

function _ensureChatMap(chatId) {
  const key = String(chatId ?? '__default__')
  let chatMap = store.get(key)
  if (chatMap) {
    // LRU 触碰前置：最近使用的 chat 排到队尾
    store.delete(key)
    store.set(key, chatMap)
  } else {
    chatMap = new Map()
    store.set(key, chatMap)
  }
  let queue = queueStore.get(key)
  if (!queue) {
    queue = []
    queueStore.set(key, queue)
  }
  _evictIfOverflow()
  _trimChatMessages(chatMap)
  return { key, chatMap, queue }
}

/**
 * 写入：fetch wrapper 拦截到 `2:` annotation 行时调用。
 *
 * 无 messageId（流式场景）：合并进 `__pending__`——一轮回复可能含多条注解
 * （ReAct 每步工具一条 + FINISH 一条），逐条追加，等新的 assistant 消息出现在
 * messages 后，由 useChatWithAnnotations 里的 effect 调用 finalizePending()
 * 按 assistant 的"第几个 assistant（0-indexed）"合并定版，保证 1:1 对齐。
 *
 * @param {string} chatId 聊天 ID
 * @param {Array} annotations 注解数组
 * @param {string} [messageId] 消息 ID（可选，历史恢复时使用；流式新消息通常不传）
 */
export function appendChatAnnotation(chatId, annotations, messageId) {
  if (!annotations || !Array.isArray(annotations) || annotations.length === 0)
    return
  // 可渲染的注解类型：search_results（检索/切片卡片）+ agent_workflow（工具调用时间线卡片）
  // + resume_report（简历分析报告卡）+ interview_scorecard（模拟面试评分卡）。
  // ⚠️ 不能只过滤 search_results：opReport 流（操作栏入库/导出回报）的注解在流头部，
  // 被 fetch wrapper 剥离后只能走本 Map，agent_workflow 类型若被丢弃卡片就不显示了。
  const renderable = annotations.some(
    (a) =>
      a &&
      (a.type === 'search_results' ||
        a.type === 'agent_workflow' ||
        a.type === 'resume_report' ||
        a.type === 'interview_scorecard'),
  )
  if (!renderable) return
  const { key, chatMap, queue } = _ensureChatMap(chatId)

  // 1) 流式场景：messageId 未出现 → 追加合并到 __pending__（一轮多注解累积）
  if (!messageId) {
    const existing = chatMap.get('__pending__')
    chatMap.set(
      '__pending__',
      Array.isArray(existing) ? [...existing, ...annotations] : annotations,
    )
    log.debug('[runtimeAnnotations] appendChatAnnotation (pending)', {
      chatId: key,
      queueLen: queue.length,
      pendingLen:
        (Array.isArray(existing) ? existing.length : 0) + annotations.length,
      annotTypes: annotations.map((a) => a?.type),
    })
    return
  }

  // 2) 有 messageId（历史恢复或 SDK 已经给出最终 id）→ 精确写到主索引 + 回退索引
  const msgKey = String(messageId)
  const existing = chatMap.get(msgKey)
  const sameContent =
    existing &&
    existing.length === annotations.length &&
    existing.every(
      (a, i) =>
        a?.engine === annotations[i]?.engine &&
        a?.total === annotations[i]?.total,
    )
  if (sameContent) return
  chatMap.set(msgKey, annotations)

  // 3) 回退索引：如果 caller 已经知道是第几个 assistant 就直接 set；否则暂时不 push
  //    （只靠 messageId 精确匹配就能查），避免因时序问题把 queue 推错位 1 条。
  log.debug('[runtimeAnnotations] appendChatAnnotation (by id)', {
    chatId: key,
    messageId,
    queueLen: queue.length,
    annotTypes: annotations.map((a) => a?.type),
  })
}

/**
 * 异步定稿（合并语义）：当 SDK 真正把新的 assistant 消息塞进 messages 之后调用。
 * - 取出 store[chatId].__pending__
 * - 以 message.id 为 key **合并**写入主索引（ReAct 流的注解分布在整轮，
 *   此函数会被 effect 多次触发：已有条目则追加，首轮则新建）
 * - 同步写入回退索引 queue[assistantIndex]（严格按第几个 assistant，保证一一对应）
 * - 必要时在 queue 里补 null 占位，避免索引越界（例如前几轮 assistant 没有 annotation）
 * - 没有 pending 时 no-op（幂等，调用方无需防重）
 *
 * @param {string} chatId
 * @param {string} messageId   新 assistant 消息的最终 id
 * @param {number} assistantIndex  这条消息是第几个 assistant（0-indexed）
 * @returns {boolean}  是否真的定稿了一条 pending
 */
export function finalizePending(chatId, messageId, assistantIndex) {
  const key = String(chatId ?? '__default__')
  const chatMap = store.get(key)
  const pending = chatMap?.get?.('__pending__')
  if (!pending || !Array.isArray(pending) || pending.length === 0) return false
  if (!messageId || typeof assistantIndex !== 'number') return false

  const { queue } = _ensureChatMap(chatId)

  // 补 null 占位到足够长度，保证 queue[assistantIndex] 有效
  while (queue.length <= assistantIndex) queue.push(null)

  const msgKey = String(messageId)
  // 合并：首轮定版新建，后续到达的 pending 并入（ReAct 每步注解陆续到达）
  const existing = chatMap.get(msgKey)
  const merged = Array.isArray(existing) ? [...existing, ...pending] : pending
  chatMap.set(msgKey, merged)
  chatMap.delete('__pending__')
  queue[assistantIndex] = merged

  log.debug('[runtimeAnnotations] finalizePending', {
    chatId: key,
    messageId,
    assistantIndex,
    queueLen: queue.length,
    mergedCount: merged.length,
  })
  return true
}

/**
 * 读取：StreamingMessage 渲染时调用。返回该消息对应的注解数组（或 null）。
 * @param {string} chatId
 * @param {Array} messages 当前 useChat 返回的全量 messages 数组
 * @param {number} msgIndex  当前消息在 messages 数组的下标
 */
export function getAnnotationForMessage(chatId, messages, msgIndex) {
  if (!Array.isArray(messages)) return null
  if (msgIndex < 0 || msgIndex >= messages.length) return null
  const message = messages[msgIndex]
  if (!message || message.role !== 'assistant') return null

  const key = String(chatId ?? '__default__')
  const chatMap = store.get(key)
  const queue = queueStore.get(key)

  // 1. 优先通过 message.id 在主索引中查找；若此时还有未定版的新 pending
  //    （ReAct 流后续步骤的注解陆续到达），一并并入返回（渲染层会按类型去重）
  if (chatMap && message.id) {
    const msgAnnotations = chatMap.get(String(message.id))
    const pending = chatMap.get('__pending__')
    if (msgAnnotations || (Array.isArray(pending) && pending.length)) {
      log.debug(
        '[runtimeAnnotations] getAnnotationForMessage: found by messageId',
        {
          chatId: key,
          messageId: message.id,
        },
      )
      return [
        ...(Array.isArray(msgAnnotations) ? msgAnnotations : []),
        ...(Array.isArray(pending) ? pending : []),
      ]
    }
  }

  // 2. 检查主索引中是否有待处理的注解
  if (chatMap) {
    const pending = chatMap.get('__pending__')
    if (pending) {
      log.debug('[runtimeAnnotations] getAnnotationForMessage: using pending', {
        chatId: key,
      })
      return pending
    }
  }

  // 3. 回退到回退索引：按轮次查找
  // 计算当前消息是第几个 assistant（0-indexed）
  if (queue && queue.length > 0) {
    let nth = 0
    for (let i = 0; i < msgIndex; i++) {
      if (messages[i].role === 'assistant') nth++
    }
    const result = queue[nth] || null
    if (result) {
      log.debug('[runtimeAnnotations] getAnnotationForMessage: found by nth', {
        chatId: key,
        nth,
        queueLen: queue.length,
      })
      return result
    }
  }

  log.debug('[runtimeAnnotations] getAnnotationForMessage: not found', {
    chatId: key,
    messageId: message?.id,
    hasChatMap: !!chatMap,
    hasQueue: !!queue,
    queueLen: queue?.length || 0,
  })
  return null
}

/**
 * 从历史会话消息中恢复注解。
 * @param {string} chatId
 * @param {Array} messages 历史消息数组（含 user/assistant 消息）
 */
export function restoreAnnotationsFromMessages(chatId, messages) {
  if (!Array.isArray(messages)) return
  const key = String(chatId ?? '__default__')
  const chatMap = new Map()
  const queue = []
  let restoredCount = 0

  for (const m of messages) {
    if (m?.role !== 'assistant') continue
    // 👇 每个 assistant 消息都占一个 queue 位置（哪怕是 null），
    //    保证 nthAssistant(0..N-1) 与 queue[0..N-1] 一一对应，避免错位
    if (Array.isArray(m.annotations) && m.annotations.length > 0) {
      // 与 appendChatAnnotation 同口径：search_results + agent_workflow + resume_report + interview_scorecard 都可恢复
      const renderable = m.annotations.some(
        (a) =>
          a &&
          (a.type === 'search_results' ||
            a.type === 'agent_workflow' ||
            a.type === 'resume_report' ||
            a.type === 'interview_scorecard'),
      )
      if (renderable) {
        const msgKey = String(m.id ?? `__msg_${restoredCount}__`)
        chatMap.set(msgKey, m.annotations)
        queue.push(m.annotations)
        restoredCount++
      } else {
        queue.push(null)
      }
    } else {
      queue.push(null)
    }
  }

  if (restoredCount > 0) {
    store.set(key, chatMap)
    queueStore.set(key, queue)
    log.debug('[runtimeAnnotations] restoreAnnotationsFromMessages', {
      chatId: key,
      restoredCount,
      queueLen: queue.length,
      assistantCount: queue.length,
    })
  } else {
    // 即使没有 search_results，也要把 queueStore 写进去（占位 null），
    // 保证后续流式新增的注解在 queue 里的位置正确。
    queueStore.set(key, queue)
    log.debug(
      '[runtimeAnnotations] restoreAnnotationsFromMessages: no search_results but queue stored',
      {
        chatId: key,
        totalMessages: messages.length,
        queueLen: queue.length,
      },
    )
  }
}

/**
 * 将一个 chatId 下的所有注解迁移到另一个 chatId。
 */
export function migrateAnnotations(fromChatId, toChatId) {
  const fromKey = String(fromChatId ?? '__default__')
  const toKey = String(toChatId ?? '__default__')

  const sourceMap = store.get(fromKey)
  const sourceQueue = queueStore.get(fromKey)

  if (sourceMap && sourceMap.size > 0) {
    store.set(toKey, new Map(sourceMap))
  }
  if (sourceQueue && sourceQueue.length > 0) {
    queueStore.set(toKey, [...sourceQueue])
  }

  if (sourceMap || sourceQueue) {
    store.delete(fromKey)
    queueStore.delete(fromKey)
    log.debug('[runtimeAnnotations] migrateAnnotations', {
      fromKey,
      toKey,
      mapCount: sourceMap?.size || 0,
      queueLen: sourceQueue?.length || 0,
    })
  }
}

/** 清理指定 chatId 下所有注解 */
export function clearAnnotationsForChat(chatId) {
  const key = String(chatId ?? '__default__')
  log.debug('[runtimeAnnotations] clearAnnotationsForChat', { chatId: key })
  store.delete(key)
  queueStore.delete(key)
}

/** 全量清空（开发调试用） */
export function clearAllAnnotations() {
  store.clear()
  queueStore.clear()
}

export default {
  appendChatAnnotation,
  finalizePending,
  getAnnotationForMessage,
  restoreAnnotationsFromMessages,
  migrateAnnotations,
  clearAnnotationsForChat,
  clearAllAnnotations,
}
