import { Router } from 'express'
import { snapshot } from '../lib/metrics.js'

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
