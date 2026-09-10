/**
 * metrics —— 运行时指标采集（L0 基础设施）
 *
 * 职责：为可观测性端点（GET /api/metrics）提供进程内轻量指标：
 *  - 计数器 incr：HTTP 请求数 / 检索次数 / HyDE 触发 / 缓存命中 / LLM 调用…
 *  - 直方图 observe：检索延迟 / LLM 生成耗时 / Embedding 耗时…
 *
 * 设计约定：
 *  - 纯内存态，重启清零（与 management/registry 运行统计同定位，不持久化）
 *  - 直方图不存全量历史：全程累计 count/sum/min/max + 最近 RING_MAX 条环形样本
 *    （snapshot 时对样本排序算精确分位数，样本量小、无长期内存膨胀风险）
 *  - 标签值必须低基数（method/status 类/scope/op 等），禁止把查询文本等
 *    高基数值当标签，防止指标 Map 无限膨胀
 *
 * 分层约束：本模块位于 L0，不感知任何上层消费方；REST 暴露由 routes/metrics.js（L8）完成。
 */

const RING_MAX = 512

/** 指标名 -> { labelKey -> entry }（labelKey 为空串时用 '_' 占位） */
const counters = new Map()
const histograms = new Map()

/** 标签对象序列化为稳定的低基数键（键排序 + 值截断防脏数据撑爆 Map） */
function labelKey(labels) {
  if (!labels || typeof labels !== 'object') return ''
  const ks = Object.keys(labels)
    .filter((k) => labels[k] !== undefined && labels[k] !== null && labels[k] !== '')
    .sort()
  if (!ks.length) return ''
  return ks.map((k) => `${k}=${String(labels[k]).slice(0, 32)}`).join(',')
}

/**
 * 计数器自增。
 * @param {string} name 指标名（约定 *_total / *_hits 等后缀自描述）
 * @param {object|null} labels 低基数标签
 * @param {number} [delta=1] 增量
 */
export function incr(name, labels = null, delta = 1) {
  const lk = labelKey(labels)
  let byLabel = counters.get(name)
  if (!byLabel) {
    byLabel = new Map()
    counters.set(name, byLabel)
  }
  const key = lk || '_'
  const cur = byLabel.get(key) || 0
  const d = Number.isFinite(delta) ? delta : 1
  byLabel.set(key, cur + d)
}

/**
 * 直方图观察（记录一次耗时/数值样本）。
 * @param {string} name 指标名（约定 *_ms 后缀表示毫秒耗时）
 * @param {number} value 本次观测值
 * @param {object|null} labels 低基数标签
 */
export function observe(name, value, labels = null) {
  const v = Number(value)
  if (!Number.isFinite(v)) return
  const lk = labelKey(labels)
  let byLabel = histograms.get(name)
  if (!byLabel) {
    byLabel = new Map()
    histograms.set(name, byLabel)
  }
  let h = byLabel.get(lk || '_')
  if (!h) {
    h = { count: 0, sum: 0, min: v, max: v, recent: [] }
    byLabel.set(lk || '_', h)
  }
  h.count++
  h.sum += v
  if (v < h.min) h.min = v
  if (v > h.max) h.max = v
  // 环形截断：只保留最近 RING_MAX 条样本（shift 512 长度数组开销可忽略）
  if (h.recent.length >= RING_MAX) h.recent.shift()
  h.recent.push(v)
}

/** 已排序样本上的分位数（nearest-rank 法） */
function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[idx])
}

/** 单个直方图 entry 序列化（分位数基于最近环形样本） */
function histEntry(h) {
  const sorted = [...h.recent].sort((a, b) => a - b)
  return {
    count: h.count,
    avgMs: h.count ? Math.round(h.sum / h.count) : 0,
    minMs: Math.round(h.min),
    maxMs: Math.round(h.max),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  }
}

/**
 * 全量快照（GET /api/metrics 消费）。
 * 结构：{ process, counters: {name: {labelKey: value}}, histograms: {name: {labelKey: entry}} }
 */
export function snapshot() {
  const countersOut = {}
  for (const [name, byLabel] of counters) {
    const m = {}
    for (const [lk, v] of byLabel) m[lk] = v
    countersOut[name] = m
  }
  const histogramsOut = {}
  for (const [name, byLabel] of histograms) {
    const m = {}
    for (const [lk, h] of byLabel) m[lk] = histEntry(h)
    histogramsOut[name] = m
  }
  const mu = process.memoryUsage()
  return {
    process: {
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      rssMb: Math.round(mu.rss / 1024 / 1024),
      heapUsedMb: Math.round(mu.heapUsed / 1024 / 1024),
    },
    counters: countersOut,
    histograms: histogramsOut,
  }
}
