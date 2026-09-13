import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childLogger } from '../logger.js'

/**
 * jwt —— HS256 签名/校验（零依赖实现，ADR-008 v2 改版新增）
 *
 * 仅支持本系统签发的 access token：
 *   header  { alg:'HS256', typ:'JWT' }
 *   payload { sub:userId, role:'admin'|'member', typ:'access', iat, exp }
 *
 * 秘钥来源：env AUTH_JWT_SECRET（32+ 字符推荐）；
 * 未配置时首次启动自动生成 64 hex 并持久化到 data/management/auth-jwt-secret，
 * 之后重启复用同一秘钥（否则所有已签发 token 失效）。文件损坏则重新生成并 warn。
 */

const log = childLogger('jwt')

const SECRET_FILE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'management', 'auth-jwt-secret',
)

const TOKEN_TTL_S = 7 * 24 * 3600 // 7 天（本地部署单设备场景；刷新令牌暂不做，过期重登）

let _secret = null

function loadSecret() {
  if (_secret) return _secret
  const envSecret = String(process.env.AUTH_JWT_SECRET || '').trim()
  if (envSecret.length >= 16) {
    _secret = envSecret
    return _secret
  }
  try {
    if (existsSync(SECRET_FILE)) {
      const s = readFileSync(SECRET_FILE, 'utf8').trim()
      if (s.length >= 16) {
        _secret = s
        return _secret
      }
    }
  } catch (err) {
    log.warn(`[jwt] 读取秘钥文件失败（${err.message}），将重新生成`)
  }
  _secret = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(SECRET_FILE), { recursive: true })
    writeFileSync(SECRET_FILE, _secret, 'utf8')
    log.info('[jwt] 已自动生成 JWT 秘钥并持久化（data/management/auth-jwt-secret）')
  } catch (err) {
    // 写不进去时仅本次进程有效：重启后 token 全失效（显式 warn，不静默）
    log.warn(`[jwt] 秘钥持久化失败（${err.message}）：重启后已签发 token 将全部失效`)
  }
  return _secret
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function signPart(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/**
 * 签发 access token。
 * @param {{ userId:string, role?:string }} account
 * @param {{ ttlS?: number }} [opts]
 * @returns {{ token:string, expiresAt:number }} expiresAt 为 Unix 毫秒
 */
export function signAccessToken({ userId, role = 'member' }, opts = {}) {
  const now = Math.floor(Date.now() / 1000)
  const ttl = Number(opts.ttlS) > 0 ? Number(opts.ttlS) : TOKEN_TTL_S
  const payload = { sub: userId, role, typ: 'access', iat: now, exp: now + ttl }
  return { token: signPart(payload, loadSecret()), expiresAt: (now + ttl) * 1000 }
}

/**
 * 校验 token（签名 + 过期 + typ）。合法返回 payload，非法/过期返回 null。
 * @param {string} token
 * @returns {{ sub:string, role:string, exp:number } | null}
 */
export function verifyAccessToken(token) {
  const t = String(token ?? '').trim()
  const parts = t.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts
  const expected = createHmac('sha256', loadSecret()).update(`${head}.${body}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (payload?.typ !== 'access' || typeof payload.sub !== 'string') return null
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) return null
  return payload
}
