/**
 * Small process-local TTL/LRU cache.
 * Values are retained in insertion/access order and expired entries are removed
 * lazily as well as by a lightweight periodic sweep.
 */
export class TtlLruCache {
  constructor({ maxEntries = 1000, maxBytes = 0, ttlMs = 300000, cleanupIntervalMs, sizeOf } = {}) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 1)
    this.maxBytes = Math.max(0, Number(maxBytes) || 0)
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.sizeOf = typeof sizeOf === 'function' ? sizeOf : (value) => {
      try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return 0 }
    }
    this.entries = new Map()
    this.bytes = 0
    const interval = Math.max(1000, Number(cleanupIntervalMs) || Math.min(this.ttlMs || 60000, 60000))
    this.timer = this.ttlMs > 0 ? setInterval(() => this.cleanup(), interval) : null
    this.timer?.unref?.()
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) { this.delete(key); return undefined }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.delete(key)
    const bytes = Math.max(0, Number(this.sizeOf(value)) || 0)
    this.entries.set(key, { value, bytes, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 })
    this.bytes += bytes
    this.evict()
    return this
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
    return !!entry
  }

  clear() { this.entries.clear(); this.bytes = 0 }
  cleanup() { for (const [key, entry] of this.entries) if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) this.delete(key) }
  evict() {
    this.cleanup()
    while (this.entries.size > this.maxEntries || (this.maxBytes > 0 && this.bytes > this.maxBytes)) {
      const first = this.entries.keys().next().value
      if (first === undefined) break
      this.delete(first)
    }
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; this.clear() }
}

export function createTtlLruCache(options) { return new TtlLruCache(options) }
