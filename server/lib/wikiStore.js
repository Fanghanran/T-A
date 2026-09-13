import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from './logger.js'

/**
 * wikiStore —— LLM Wiki 词条存储（L1 存储层，per-owner 隔离）
 *
 * 职责：持久化「LLM 实体抽取 → 归一合并 → 词条摘要」的全部中间产物，
 * 支撑增量生成（切片内容哈希未变即跳过抽取）与断点续跑（每步写穿透）：
 *  - entries：词条表（name/aliases/summary/提及切片清单/提及上下文）
 *  - chunkExtractions：切片抽取记录（chunkId → { hash, entities }），
 *    哈希变化（正文编辑/重切）或切片消失（文档删除）都会触发重算
 *
 * 持久化：data/knowledge/wiki/<ownerId>.json（原子替换写：tmp + rename），内存
 * 懒加载 + 写穿透。version 每次 save 递增，作为网络图缓存键的一部分
 * （生成完成后前端重新拉图，服务端缓存按版本失效）。
 * '*'（admin 聚合视图）为只读合并；写入必须用具体 ownerId。
 * 旧版全局 wiki.json 首次访问时自动迁移为 wiki/admin.json。
 *
 * 分层约束：不感知上层消费方（wikiBuilder / manager）；无 React/HTTP 概念。
 */

const log = childLogger('wikiStore')

const WIKI_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'knowledge',
  'wiki',
)
const LEGACY_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'knowledge', 'wiki.json')
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 空态（文件缺失 / 损坏时重置） */
function emptyState() {
  return { version: 0, entries: [], chunkExtractions: {} }
}

/** 内存态（懒加载，per-owner） */
const _states = new Map()
let _legacyMigrated = false

function assertOwner(ownerId) {
  if (!OWNER_ID_RE.test(String(ownerId))) {
    throw new Error(`wikiStore: 非法 ownerId：${ownerId}`)
  }
  return ownerId
}

/** 旧版全局 wiki.json → wiki/admin.json（一次性，幂等） */
function migrateLegacy() {
  if (_legacyMigrated) return
  _legacyMigrated = true
  try {
    if (!existsSync(LEGACY_FILE)) return
    mkdirSync(WIKI_DIR, { recursive: true })
    const adminFile = join(WIKI_DIR, 'admin.json')
    if (!existsSync(adminFile)) {
      renameSync(LEGACY_FILE, adminFile)
      log.info('[wikiStore] 旧版全局 wiki.json 已迁移 → wiki/admin.json')
    } else {
      renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`)
      log.info('[wikiStore] 迁移产物已存在，旧文件改名保留为 wiki.json.migrated')
    }
  } catch (err) {
    log.warn(`[wikiStore] 旧文件迁移失败（${err.message}），忽略`)
  }
}

function wikiFile(ownerId) {
  return join(WIKI_DIR, `${assertOwner(ownerId)}.json`)
}

/** 懒加载 + 结构校验（损坏文件按空态处理，不抛错阻塞服务） */
function load(ownerId) {
  assertOwner(ownerId)
  migrateLegacy()
  let s = _states.get(ownerId)
  if (s) return s
  const file = wikiFile(ownerId)
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      s = {
        version: Number(raw?.version) || 0,
        entries: Array.isArray(raw?.entries) ? raw.entries : [],
        chunkExtractions:
          raw?.chunkExtractions && typeof raw.chunkExtractions === 'object'
            ? raw.chunkExtractions
            : {},
      }
    } else {
      s = emptyState()
    }
  } catch (err) {
    log.error(`[wikiStore] 读取 ${file} 失败（${err.message}），按空态处理`)
    s = emptyState()
  }
  _states.set(ownerId, s)
  return s
}

/** 原子写（tmp + rename）并递增版本号（网络图缓存失效用） */
function save(ownerId) {
  const s = load(ownerId)
  s.version += 1
  try {
    mkdirSync(dirname(wikiFile(ownerId)), { recursive: true })
    const tmp = `${wikiFile(ownerId)}.tmp`
    writeFileSync(tmp, JSON.stringify(s), 'utf8')
    renameSync(tmp, wikiFile(ownerId))
  } catch (err) {
    log.error(`[wikiStore] 写入 ${ownerId} wiki 失败：${err.message}（修改仅本次进程生效）`)
  }
}

/** 文本内容哈希（与 vectorStore 秒断重复同款 sha256 口径） */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

/** 当前数据版本号（网络图缓存键组成部分；'*' 取各 owner 最大值） */
export function getWikiVersion(ownerId) {
  if (ownerId === '*') {
    let max = 0
    for (const o of listOwnerIds()) max = Math.max(max, load(o).version)
    return max
  }
  return load(ownerId).version
}

/** 全部已落盘 owner 清单 */
export function listOwnerIds() {
  migrateLegacy()
  try {
    return existsSync(WIKI_DIR)
      ? readdirSync(WIKI_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
      : []
  } catch {
    return []
  }
}

/** 词条全量（含未生成摘要的 pending 词条；'*' 合并全部 owner） */
export function listEntries(ownerId) {
  if (ownerId === '*') {
    const out = []
    for (const o of listOwnerIds()) out.push(...load(o).entries)
    return out
  }
  return load(ownerId).entries
}

/** 词条详情（id 精确匹配；'*' 跨 owner 查找） */
export function getEntry(id, ownerId) {
  if (ownerId === '*') {
    for (const o of listOwnerIds()) {
      const hit = load(o).entries.find((e) => e.id === id)
      if (hit) return hit
    }
    return null
  }
  return load(ownerId).entries.find((e) => e.id === id) ?? null
}

/** 切片抽取记录（切片 chunkId 全局唯一，按具体 owner 存取） */
export function getExtraction(chunkId, ownerId) {
  return load(ownerId).chunkExtractions[chunkId] ?? null
}

/** 写入切片抽取记录（每块抽取完成即落盘，断点续跑的增量基础） */
export function putExtraction(chunkId, rec, ownerId) {
  const s = load(ownerId)
  s.chunkExtractions[chunkId] = rec
  save(ownerId)
}

/**
 * 整表写入词条（归一合并阶段产物）。保留旧词条的摘要与生成时间：
 * 同 id 且提及切片清单未变的词条，summary/generatingAt 原样继承。
 */
export function putEntries(nextEntries, ownerId) {
  const s = load(ownerId)
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
  save(ownerId)
}

/** 单词条补丁（词条摘要生成完成时逐条落盘） */
export function updateEntry(id, patch, ownerId) {
  const s = load(ownerId)
  const idx = s.entries.findIndex((e) => e.id === id)
  if (idx < 0) return false
  s.entries[idx] = { ...s.entries[idx], ...patch }
  save(ownerId)
  return true
}

/**
 * 对账：清理已不存在切片的抽取记录（文档删除后）。
 * 词条层的失效提及由归一合并阶段重建（mentionChunkIds 全量重算）。
 * @param {Set<string>} validChunkIds 当前库内全部 chunkId
 * @returns {number} 清理条数
 */
export function reconcileChunkExtractions(validChunkIds, ownerId) {
  const s = load(ownerId)
  let removed = 0
  for (const id of Object.keys(s.chunkExtractions)) {
    if (!validChunkIds.has(id)) {
      delete s.chunkExtractions[id]
      removed++
    }
  }
  if (removed > 0) {
    log.info(`[wikiStore] 对账清理 ${removed} 条失效切片抽取记录`)
    save(ownerId)
  }
  return removed
}

/** 统计（状态卡片 / 生成完成回执；'*' 聚合全部 owner） */
export function stats(ownerId) {
  if (ownerId === '*') {
    const acc = { version: 0, entries: 0, summarized: 0, extractedChunks: 0 }
    for (const o of listOwnerIds()) {
      const s = load(o)
      acc.version = Math.max(acc.version, s.version)
      acc.entries += s.entries.length
      acc.summarized += s.entries.filter((e) => e.summary).length
      acc.extractedChunks += Object.keys(s.chunkExtractions).length
    }
    return acc
  }
  const s = load(ownerId)
  return {
    version: s.version,
    entries: s.entries.length,
    summarized: s.entries.filter((e) => e.summary).length,
    extractedChunks: Object.keys(s.chunkExtractions).length,
  }
}

/** 清空 ownerId 的全部 Wiki 数据（'*' 清全部 owner） */
export function clearWiki(ownerId) {
  if (ownerId === '*') {
    for (const o of listOwnerIds()) {
      _states.set(o, emptyState())
      save(o)
    }
    log.info('[wikiStore] 已清空全部 owner 的 Wiki 数据')
    return true
  }
  _states.set(ownerId, emptyState())
  save(ownerId)
  log.info(`[wikiStore] 已清空 ${ownerId} 的 Wiki 数据`)
  return true
}
