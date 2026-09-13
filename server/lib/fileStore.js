import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from './logger.js'

/**
 * fileStore —— 持久层唯一访问器（L1）
 *
 * 三级存储模型（见 docs/向量库重构设计书.md）里的「持久层」：
 *   data/files/{ownerId}/{docId}/
 *     source.{ext}   原件（保真保存，供下载）
 *     content.md     抽取正文（切片与锚点的参照物）
 *
 * 职责边界：纯文件存取，**零业务语义** —— 不知道切片、向量、检索。
 * 不 import 任何业务模块；被锚点层（anchorStore/vectorStore）与索引层调用。
 *
 * 关键约定：
 *  - span 锚点用**字符偏移**（JS string 语义），不是字节偏移。UTF-8 中文多字节下
 *    字节偏移必然错位。因此 content.md 一旦写入，任何非本模块的改写都会使锚点失效，
 *    业务层必须走「编辑必重切」流程。
 *  - 文本类原件（md/txt/csv/json/yaml/html）与正文同源：上传时只落 source.{ext}，
 *    readContent 自动回退读它，不再复制一份 content.md。
 *  - 写入原子化：临时文件 + rename。受限环境下 rename 可能被拒（实测 EPERM），
 *    此时降级为直写并告警 —— 可用性优先于原子性。
 */

const log = childLogger('fileStore')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', 'data', 'files')

/** 标识符白名单：ownerId / docId 会拼进路径，必须防目录穿越 */
const ID_RE = /^[A-Za-z0-9_-]+$/

/** 文本类扩展名：原件即正文，可与 content 同源 */
const TEXT_EXT = new Set([
  'md',
  'markdown',
  'txt',
  'log',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'html',
  'htm',
])

export const CONTENT_NAME = 'content.md'

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(
      `fileStore: ${label} 非法（仅允许字母数字下划线连字符）：${JSON.stringify(value)}`,
    )
  }
}

export function isTextExt(ext) {
  return TEXT_EXT.has(String(ext ?? '').toLowerCase().replace(/^\./, ''))
}

/** 文档目录绝对路径（不保证存在） */
export function docDir(ownerId, docId) {
  assertId(ownerId, 'ownerId')
  assertId(docId, 'docId')
  return join(ROOT, ownerId, docId)
}

/** 相对 data/files/ 的路径 —— 存进 documents.path，布局变更时无需迁移数据 */
export function relDocDir(ownerId, docId) {
  assertId(ownerId, 'ownerId')
  assertId(docId, 'docId')
  return `${ownerId}/${docId}`
}

export function docDirExists(ownerId, docId) {
  return existsSync(docDir(ownerId, docId))
}

/** 原子写：先写临时文件再 rename；rename 被拒则降级直写 */
function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch (err) {
    log.warn(`rename 原子替换被拒（${err.code ?? err.message}），降级为直写：${file}`)
    writeFileSync(file, data)
    try {
      unlinkSync(tmp)
    } catch {
      /* 残留临时文件无害 */
    }
  }
}

/** 在文档目录里找一个现有原件（source.*），返回 { name, ext } 或 null */
export function findSource(ownerId, docId) {
  const dir = docDir(ownerId, docId)
  if (!existsSync(dir)) return null
  try {
    for (const name of readdirSync(dir)) {
      const m = /^source\.([A-Za-z0-9]+)$/.exec(name)
      if (m) return { name, ext: m[1].toLowerCase() }
    }
  } catch (err) {
    log.warn(`读取目录失败：${dir} — ${err.message}`)
  }
  return null
}

/* ============ 原件 ============ */

/**
 * 保存原件（保真落盘）。
 * @param {string} ownerId
 * @param {string} docId
 * @param {Buffer|Uint8Array} buffer 原始字节
 * @param {string} ext 扩展名（不含点）
 * @returns {{path:string, name:string, isText:boolean}}
 */
export function saveSource(ownerId, docId, buffer, ext) {
  const safeExt = String(ext ?? '')
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/[^a-z0-9]/g, '')
  if (!safeExt) throw new Error('fileStore: 缺少原件扩展名')
  const name = `source.${safeExt}`
  const file = join(docDir(ownerId, docId), name)
  atomicWrite(file, buffer)
  return { path: relDocDir(ownerId, docId), name, isText: isTextExt(safeExt) }
}

/**
 * 读原件字节（下载用）。
 * @returns {Buffer|null}
 */
export function readSource(ownerId, docId) {
  const found = findSource(ownerId, docId)
  if (!found) return null
  return readFileSync(join(docDir(ownerId, docId), found.name))
}

/* ============ 正文 ============ */

/**
 * 写正文（切片依据）。
 * @returns {string} 正文文件绝对路径
 */
export function writeContent(ownerId, docId, text) {
  const file = join(docDir(ownerId, docId), CONTENT_NAME)
  atomicWrite(file, String(text ?? ''))
  return file
}

/**
 * 读正文全文。文本类原件与正文同源：无 content.md 时回退读 source.{ext}。
 * @returns {string}
 */
export function readContent(ownerId, docId) {
  const contentFile = join(docDir(ownerId, docId), CONTENT_NAME)
  if (existsSync(contentFile)) return readFileSync(contentFile, 'utf8')

  const found = findSource(ownerId, docId)
  if (found && isTextExt(found.ext)) {
    return readFileSync(join(docDir(ownerId, docId), found.name), 'utf8')
  }
  throw new Error(`fileStore: 正文不存在（${relDocDir(ownerId, docId)}）`)
}

export function hasContent(ownerId, docId) {
  const contentFile = join(docDir(ownerId, docId), CONTENT_NAME)
  if (existsSync(contentFile)) return true
  const found = findSource(ownerId, docId)
  return !!(found && isTextExt(found.ext))
}

/**
 * ★ 锚点取文 —— 整个检索回读的落点。
 * 用字符偏移（JS string.slice 语义）从正文中切出切片内容。
 * @param {number} start 起始偏移（含）
 * @param {number} end 结束偏移（不含）；省略则取到末尾
 */
export function readSpan(ownerId, docId, start, end) {
  const text = readContent(ownerId, docId)
  const s = Math.max(0, Number(start) || 0)
  const e = end === undefined || end === null ? text.length : Math.min(text.length, Number(end))
  if (s >= e) return ''
  return text.slice(s, e)
}

/* ============ 删除 ============ */

/**
 * 删除文档目录（物理）。
 * 受限环境下 fs 删除可能被安全删除机制接管而超时/被拒 —— 此时返回 false，
 * 由上层（锚点层）标记 documents.status='deleted' 隐藏数据，物理清理交给运维脚本。
 * @returns {boolean} 是否物理删除成功
 */
export function removeDoc(ownerId, docId) {
  const dir = docDir(ownerId, docId)
  if (!existsSync(dir)) return true
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch (err) {
    log.warn(`物理删除失败（${err.code ?? err.message}），留给运维脚本清理：${dir}`)
    return false
  }
}

/* ============ 事务化删除（改名进回收站，出错可回滚） ============ */

/** 回收站根目录：删除事务的暂存区，位于持久层内部（对账只扫 local/，不误报） */
const TRASH_ROOT = join(ROOT, '.trash')

/**
 * 第一步：把文档目录改名进回收站（同盘 rename，原子操作）。
 * rename 失败（Windows 下常见于文件被占用）→ 返回 null，调用方直接中止，系统零变化。
 * @returns {string|null} 回收站路径；目录本不存在时返回 ''（视为无事可做的成功路径）
 */
export function removeDocToTrash(ownerId, docId) {
  const dir = docDir(ownerId, docId)
  if (!existsSync(dir)) return ''
  try {
    mkdirSync(TRASH_ROOT, { recursive: true })
    const trashPath = join(TRASH_ROOT, `${ownerId}-${docId}-${Date.now()}`)
    renameSync(dir, trashPath)
    return trashPath
  } catch (err) {
    log.warn(`改名进回收站失败（${err.code ?? err.message}）：${dir}`)
    return null
  }
}

/** 回滚：把回收站里的目录改名回原位（rename 回去，完全恢复） */
export function restoreFromTrash(trashPath, ownerId, docId) {
  if (!trashPath) return
  try {
    renameSync(trashPath, docDir(ownerId, docId))
  } catch (err) {
    log.error(`回滚失败：${trashPath} 未恢复原位，需手工处理（${err.message}）`)
  }
}

/** 事务成功后的最后一步：真删回收站中的目录；失败仅留待下次清理，不影响一致性 */
export function purgeTrash(trashPath) {
  if (!trashPath) return
  try {
    rmSync(trashPath, { recursive: true, force: true })
  } catch (err) {
    log.warn(`回收站清理失败（${err.code ?? err.message}），不影响一致性，留待手工清理：${trashPath}`)
  }
}

/** 持久层根目录（备份脚本用） */
export function rootDir() {
  return ROOT
}
