import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from './logger.js'

/**
 * wikiStore —— LLM Wiki 词条存储（L1 存储层）
 *
 * 职责：持久化「LLM 实体抽取 → 归一合并 → 词条摘要」的全部中间产物，
 * 支撑增量生成（切片内容哈希未变即跳过抽取）与断点续跑（每步写穿透）：
 *  - entries：词条表（name/aliases/summary/提及切片清单/提及上下文）
 *  - chunkExtractions：切片抽取记录（chunkId → { hash, entities }），
 *    哈希变化（正文编辑/重切）或切片消失（文档删除）都会触发重算
 *
 * 持久化：data/knowledge/wiki.json（原子替换写：tmp + rename），内存
 * 懒加载 + 写穿透。version 每次 save 递增，作为网络图缓存键的一部分
 * （生成完成后前端重新拉图，服务端缓存按版本失效）。
 *
 * 分层约束：不感知上层消费方（wikiBuilder / manager）；无 React/HTTP 概念。
 */

const log = childLogger('wikiStore')

const WIKI_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'knowledge',
  'wiki.json',
)

/** 空态（文件缺失 / 损坏时重置） */
function emptyState() {
  return { version: 0, entries: [], chunkExtractions: {} }
}

/** 内存态（懒加载） */
let _state = null

/** 懒加载 + 结构校验（损坏文件按空态处理，不抛错阻塞服务） */
function load() {
  if (_state) return _state
  try {
    if (existsSync(WIKI_FILE)) {
      const raw = JSON.parse(readFileSync(WIKI_FILE, 'utf8'))
      _state = {
        version: Number(raw?.version) || 0,
        entries: Array.isArray(raw?.entries) ? raw.entries : [],
        chunkExtractions:
          raw?.chunkExtractions && typeof raw.chunkExtractions === 'object'
            ? raw.chunkExtractions
            : {},
      }
    } else {
      _state = emptyState()
    }
  } catch (err) {
    log.error(`[wikiStore] 读取 ${WIKI_FILE} 失败（${err.message}），按空态处理`)
    _state = emptyState()
  }
  return _state
}

/** 原子写（tmp + rename）并递增版本号（网络图缓存失效用） */
function save() {
  const s = load()
  s.version += 1
  try {
    mkdirSync(dirname(WIKI_FILE), { recursive: true })
    const tmp = `${WIKI_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(s), 'utf8')
    renameSync(tmp, WIKI_FILE)
  } catch (err) {
    log.error(`[wikiStore] 写入 ${WIKI_FILE} 失败：${err.message}（修改仅本次进程生效）`)
  }
}

/** 文本内容哈希（与 vectorStore 秒断重复同款 sha256 口径） */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

/** 当前数据版本号（网络图缓存键组成部分） */
export function getWikiVersion() {
  return load().version
}

/** 词条全量（含未生成摘要的 pending 词条） */
export function listEntries() {
  return load().entries
}

/** 词条详情（id 精确匹配） */
export function getEntry(id) {
  return load().entries.find((e) => e.id === id) ?? null
}

/** 切片抽取记录 */
export function getExtraction(chunkId) {
  return load().chunkExtractions[chunkId] ?? null
}

/** 写入切片抽取记录（每块抽取完成即落盘，断点续跑的增量基础） */
export function putExtraction(chunkId, rec) {
  const s = load()
  s.chunkExtractions[chunkId] = rec
  save()
}

/**
 * 整表写入词条（归一合并阶段产物）。保留旧词条的摘要与生成时间：
 * 同 id 且提及切片清单未变的词条，summary/generatingAt 原样继承。
 */
export function putEntries(nextEntries) {
  const s = load()
  const prev = new Map(s.entries.map((e) => [e.id, e]))
  s.entries = nextEntries.map((e) => {
    const old = prev.get(e.id)
    if (!old) return e
    const mentionsUnchanged =
      Array.isArray(old.mentionChunkIds) &&
      old.mentionChunkIds.length === (e.mentionChunkIds ?? []).length &&
      (e.mentionChunkIds ?? []).every((id, i) => id === old.mentionChunkIds[i])
    // 提及不变 → 摘要可继承；提及变化 → 留待重生成（summary 置空）
    if (mentionsUnchanged && old.summary) {
      return { ...e, summary: old.summary, generatedAt: old.generatedAt ?? null }
    }
    return e
  })
  save()
}

/** 单词条补丁（词条摘要生成完成时逐条落盘） */
export function updateEntry(id, patch) {
  const s = load()
  const idx = s.entries.findIndex((e) => e.id === id)
  if (idx < 0) return false
  s.entries[idx] = { ...s.entries[idx], ...patch }
  save()
  return true
}

/**
 * 对账：清理已不存在切片的抽取记录（文档删除后）。
 * 词条层的失效提及由归一合并阶段重建（mentionChunkIds 全量重算）。
 * @param {Set<string>} validChunkIds 当前库内全部 chunkId
 * @returns {number} 清理条数
 */
export function reconcileChunkExtractions(validChunkIds) {
  const s = load()
  let removed = 0
  for (const id of Object.keys(s.chunkExtractions)) {
    if (!validChunkIds.has(id)) {
      delete s.chunkExtractions[id]
      removed++
    }
  }
  if (removed > 0) {
    log.info(`[wikiStore] 对账清理 ${removed} 条失效切片抽取记录`)
    save()
  }
  return removed
}

/** 统计（状态卡片 / 生成完成回执） */
export function stats() {
  const s = load()
  return {
    version: s.version,
    entries: s.entries.length,
    summarized: s.entries.filter((e) => e.summary).length,
    extractedChunks: Object.keys(s.chunkExtractions).length,
  }
}

/** 清空全部 Wiki 数据（管理端 DELETE /wiki） */
export function clearWiki() {
  _state = emptyState()
  save()
  log.info('[wikiStore] 已清空全部 Wiki 数据')
  return true
}
