/**
 * config —— LLM / Embedding 连接配置
 *
 * 通过环境变量统一配置，支持任何 OpenAI 兼容端点：
 * MiMo（小米）/ DeepSeek / Moonshot / Qwen / 智谱 / 本地 Ollama(vLLM) / 官方 OpenAI 等。
 *
 * 原理：这些服务的 API 与 OpenAI 一致，用 @ai-sdk/openai 的 createOpenAI
 * 显式传入 baseURL + apiKey + modelName 即可接入，无需改代码。
 *
 * 无 API Key 或显式 LLM_STUB=1 时，自动降级 stub，保证全链路可跑。
 *
 * 另导出切片 / 查询改写的调优配置（chunkerConfig / queryRewriterConfig），
 * 其可调值来自 tunables.js，支持管理端在线修改热生效。
 */

import { tunables } from './tunables.js'

/** 解析布尔环境变量 */
function bool(v) {
  return v === undefined ? false : /^(1|true|yes|on)$/i.test(String(v).trim())
}

/** 强制 stub（调试用，或不想调任何外部服务时） */
const STUB = bool(process.env.LLM_STUB)

/* ---------- 对话 / RAG 生成 ---------- */
// 兼容旧变量 OPENAI_API_KEY，避免破坏既有用法
const llmApiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
// baseURL 留空 → createOpenAI 默认走官方 OpenAI；设了则走兼容端点
const llmBaseUrl = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || ''
const llmModel = process.env.LLM_MODEL || 'gpt-4o-mini'

/* ---------- Embedding（可与 LLM 不同端点；不配则与 LLM 共用） ---------- */
const embedApiKey =
  process.env.EMBED_API_KEY || llmApiKey || process.env.OPENAI_API_KEY || ''
const embedBaseUrl =
  process.env.EMBED_BASE_URL || llmBaseUrl || process.env.OPENAI_BASE_URL || ''
const embedModel = process.env.EMBED_MODEL || 'text-embedding-3-small'

/** 真实 LLM 是否可用（非 stub 且有 apiKey） */
export const llmAvailable = !STUB && !!llmApiKey

/** 真实 Embedding 是否可用（非 stub 且有 apiKey） */
export const embedAvailable = !STUB && !!embedApiKey

/** LLM 模式描述（用于健康检查与启动日志）；未配置 = 'unconfigured'（Fail-Fast，ADR-009） */
export const llmMode = llmAvailable
  ? `${llmBaseUrl ? 'openai-compatible' : 'openai'}:${llmModel}`
  : 'unconfigured'

/** Embedding 模式描述 */
export const embeddingMode = embedAvailable
  ? `${embedBaseUrl ? 'openai-compatible' : 'openai'}:${embedModel}`
  : 'unconfigured'

/** 供 llm.js 使用 */
export const llmConfig = {
  apiKey: llmApiKey,
  baseUrl: llmBaseUrl,
  model: llmModel,
}

/** 供 embed.js 使用 */
export const embeddingConfig = {
  apiKey: embedApiKey,
  baseUrl: embedBaseUrl,
  model: embedModel,
}

/**
 * 切片器配置（chunker.js · 三层语义切片）
 *
 * 与 docs/切片策略优化计划.md 一致：
 *   maxChars：单个 chunk 的目标字数（第一层规则切完后仍然超限 → 触发生语义细切）
 *   hardMaxChars：兜底硬上限（即使语义上不断，也不能超过这个字数，防止代码块/表格撑爆上下文）
 *   minChars：单个 chunk 最小字数，低于此值自动向上合并（避免碎块）
 *   semanticStdK：语义断点阈值 = mean - K × std（K 越大断点越少、K 越小断点越多）
 *   semanticMinSimilarity：阈值兜底下限，低于此相似度一律视为断点
 *   contextSentences：上下文扩展（preContext/postContext）取前后几句（约 50~100 字）
 *   questionsPerChunk：入库时 LLM 为每个 chunk 预生成几个典型问题（检索锚点）
 *
 * 实际值来自 tunables.js（运行时可经 /api/management/tunables 在线修改、热生效）；
 * 此处保留同名导出以维持既有引用点不变 —— 消费方均在调用时读属性。
 */
export const chunkerConfig = tunables.chunker

/**
 * Query 改写配置（queryRewriter.js · 上下文压缩 + 多查询生成 + 降级）
 *
 * 前 4 个调优项来自 tunables.js（getter 委托 → 在线修改热生效），
 * 其余为静态实现细节（缓存大小 / 限流 / 权重），不开放在线调整。
 */
export const queryRewriterConfig = {
  // Ollama 响应超时（ms）：超过直接降级为原始 query 检索，不阻塞用户。
  // 实测（本地 qwen2.5-coder:14b，2026-08-29）：改写一次需 3s+，原值 3000 几乎必然触发
  // 超时降级 —— 每次查询白等 3 秒，而 Milvus 检索本身仅约 50ms（改写占了 98% 耗时）。
  // 降到 1200 可显著减少无效等待；若换成响应更快的模型，可调大让改写真正生效。
  get rewriteTimeoutMs() {
    return tunables.rewrite.rewriteTimeoutMs
  },
  // 总开关：置为 false 可完全关闭改写（走纯原始 query 检索）
  get rewriteEnabled() {
    return tunables.rewrite.rewriteEnabled
  },
  // 生成几个检索查询（含主查询）
  get queriesPerRequest() {
    return tunables.rewrite.queriesPerRequest
  },
  // 对话历史上下文窗口：最多保留几轮（> 3 轮则压缩早期内容）
  get historyTurns() {
    return tunables.rewrite.historyTurns
  },
  // 送给改写 LLM 的上下文预算（近似 token）。
  // 计量口径：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。
  // 注意：此前按「字符」截断（500 字符），中文恰好够用，但英文只折合约 125 token、
  // 白白浪费 3/4 预算。改为 token 计量后中英文都合理。
  maxPromptTokens: 500,
  // 字符硬上限，防极端 case（如单个超长 token 串）
  maxPromptChars: 2000,
  // 质量校验：生成的 query 必须满足长度范围，且不含拒绝式输出
  minQueryChars: 5,
  maxQueryChars: 200,
  // 多路检索合并权重：按 query 列表顺序降权
  queryWeights: [1.0, 0.8, 0.6],
  // 重写结果缓存最大条目（LRU 内存缓存，刷新页面后清空）
  rewriteCacheSize: 64,
  // 并发限流：同一时刻最多多少条 query 改写在排队（超过直接降级）
  maxConcurrency: 3,
  maxPending: 10,
}
