import { Router } from 'express'
import { snapshot } from '../lib/metrics.js'
import { listReflections, reflectionStats } from '../lib/sessionStore.js'
import { listAudit } from '../lib/management/audit.js'

/**
 * routes/metrics —— 可观测性端点（L8 HTTP 层）
 *
 * GET /api/metrics：进程内运行指标快照，供运维巡检与脚本消费。
 *  - 检索延迟：search_latency_ms（按 scope 分标签）+ search_total
 *  - LLM 耗时：llm_generate_ms（按 op 分标签）/ llm_stream_total
 *  - Embedding：embed_ms / embed_total / embed_texts_total
 *  - HyDE 触发率：hyde_evaluations vs hyde_triggered；缓存命中：hyde_cache_hits / hyde_cache_misses
 *  - HTTP：http_requests_total（method + 状态码分段）
 *
 * 指标均为纯计数/延迟统计（无用户数据、无密钥、无端点 URL），与 /api/health
 * 同级公开；进程内内存态，重启清零。
 */
export const metricsRouter = Router()

metricsRouter.get('/api/metrics', (_req, res) => {
  res.json(snapshot())
})

// P1 反思回路：最近反思记录 + 统计总览（按 owner 隔离在查询时由前端会话侧过滤，
// 记录本身为单用户 local 口径，与 /api/health 同级公开）
metricsRouter.get('/api/reflection/list', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    res.json({ items: listReflections(limit), stats: reflectionStats() })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

// P2 ReAct 规划轨迹：从审计日志过滤 react.* 条目（react.step 每步 / react.run 汇总）。
// 时间倒序，limit 截断；runs=true 时只返回 run 汇总行（管理页轨迹查看器列表用）。
metricsRouter.get('/api/react/steps', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100))
    const runsOnly = req.query.runs === 'true'
    const items = listAudit(2000)
      .filter((e) => (runsOnly ? e.action === 'react.run' : e.action.startsWith('react.')))
      .slice(0, limit)
    res.json({ items })
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})
