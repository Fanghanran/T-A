// 【必须放在第一行】加载同目录下的 server/.env，保证用户用 `node index.js` 而不是 `npm start`
// 启动时也能读到 LLM_API_KEY / LLM_BASE_URL 等配置；否则会"看起来配了 .env 但模型一直不参与回答"。
import './env.js'

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import express from 'express'
import cors from 'cors'
import pinoHttp from 'pino-http'

// ── 基础设施 ──
import { logger } from './lib/logger.js'
import { errorHandler } from './lib/errors.js'
import { requestTrace } from './lib/requestTrace.js'
import { corsOptions, securityHeaders, adminAuth, rateLimiters } from './lib/security.js'
import * as principal from './lib/principal.js'
import { runWithActor } from './lib/management/audit.js'
import {
  llmMode,
  embeddingMode,
  llmConfig,
  embeddingConfig,
  llmAvailable,
  embedAvailable,
} from './lib/config.js'

// ── 存储层（bootstrap 前置初始化）──
import * as milvus from './lib/milvusStore.js'
import * as store from './lib/vectorStore.js'
import { embedTexts } from './lib/embed.js'

// ── 路由层（app 唯一消费者；路由内部再各自依赖 lib 领域模块）──
import { healthRouter } from './routes/health.js'
import { metricsRouter } from './routes/metrics.js'
import { sessionsRouter } from './routes/sessions.js'
import { interviewRouter } from './routes/interview.js'
import { knowledgeRouter } from './routes/knowledge.js'
import filesRouter from './routes/files.js'
import { docProcessorRouter } from './routes/docProcessor.js'
import { resumeRouter } from './routes/resume.js'
import { chatRouter, initAgentRegistry } from './routes/chat.js'
import { agentsRouter } from './routes/agents.js'
import { authRouter } from './routes/auth.js'
import sttRouter from './routes/stt.js'
import managementRouter from './lib/management/manager.js'

// ── 工作流注册副作用导入：确保路由处理请求前，工具/工作流均已注册到管理注册表 ──
import './lib/tools/docTools.js'
import './lib/tools/knowledgeTools.js' // 知识工具注册（与 docTools 同惯例：入口统一触发）
import './lib/workflows/docWorkflow.js'
import './lib/workflows/docPlanWorkflow.js'

/**
 * index.js —— 应用入口（组装 + 启动，不含任何业务逻辑）
 *
 * 分层架构（依赖只允许自上而下，scripts/check-layers.mjs 静态断言）：
 *   L0 基础设施   env / config / logger / errors / requestTrace
 *   L1 存储       milvusStore / vectorStore / sessionStore / questionBank
 *   L2 算法       chunker / embed / queryRewriter
 *   L3 LLM        llm
 *   L4 领域       docProcessor / unifiedSearch
 *   L5 注册表     management/registry（工具与工作流元数据的唯一来源）
 *   L5.5 编排语义 intents（意图判定，依赖 registry）
 *   L6 工具层     tools/*（实现 + 注册）
 *   L7 工作流层   workflows/*（编排工具；只经 registry.resolveRunner 调用工具）
 *   L8 HTTP       routes/* + management/manager（express Router）
 *   L9 入口       index.js（本文件，只做组装与启动）
 *
 * 本文件职责：express 实例化 → 全局中间件 → 挂载各域路由 → 404/错误兜底 →
 * Milvus 前置初始化 → 端口绑定（含 TIME_WAIT 重试）。
 */

// 强制 stdout/stderr 使用 UTF-8，解决 Windows PowerShell 终端中文乱码
process.stdout.setDefaultEncoding('utf8')
process.stderr.setDefaultEncoding('utf8')

const app = express()
// 请求追踪 + 结构化请求日志（必须在路由前注册；genReqId 复用上游 x-request-id 头）
app.use(requestTrace())
app.use(pinoHttp({ logger, genReqId: (req) => req.id || randomUUID() }))
app.use(securityHeaders)
app.use(cors(corsOptions()))
app.use(express.json({ limit: '8mb' }))

// Public health endpoint remains unauthenticated.

// ── 路由挂载（顺序无关：各 Router 内部使用绝对路径）──
app.use(healthRouter) // / 、/api/health（健康探针不要求用户主体）
app.use(metricsRouter) // /api/metrics（运行指标快照：纯计数/延迟统计，与 health 同级公开）
app.use(authRouter) // /api/auth/*（公开认证端点；爆破限流在 routes/auth.js 内按端点下沉——me 不占爆破桶）
app.use(sttRouter) // /api/stt（语音转文字：转发 OpenAI 兼容转写端点）
// M5a 用户主体守卫（ADR-008）：AUTH_MODE=disabled 时所有请求视为 local 单一用户（零回归）；
// M5b：把当前 principal 放进 AsyncLocalStorage，使请求链路中任意深度的
// appendAudit 都能自动带上 ownerId（16 处调用点无需改动）。
// 放在 /api 守卫之前：管理路由不走该守卫，这里统一解析一次即可。
// disabled 模式恒为 local；user-token 模式下令牌缺失/无效为 null，审计回落 local。
app.use((req, res, next) => {
  const p = principal.principalOf(req)
  runWithActor(p, () => next())
})

// user-token / jwt 模式下除 health/management/auth 外的 /api 路由必须携带有效凭据，
// 跨用户数据互相不可见。management 路由走 adminAuth，auth 路由本身就是认证入口。
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/management')) return next()
  if (req.path.startsWith('/auth')) return next()
  if (principal.usersEnabled()) return principal.requireUser(req, res, next)
  req.principal = { userId: principal.LOCAL_USER_ID }
  next()
})
// 会话接口默认开放给已识别用户（本地单机）；公开部署时设 PROTECT_SESSIONS=1 追加管理员认证
const protectSessions = /^(1|true|on|yes)$/i.test(String(process.env.PROTECT_SESSIONS || ''))
app.use(...(protectSessions ? [adminAuth] : []), sessionsRouter) // /api/sessions/*
app.use(interviewRouter) // /api/interview/*
app.use(knowledgeRouter) // /api/knowledge/* + /api/search/query
app.use(docProcessorRouter) // /api/doc-processor/*
app.use(resumeRouter) // /api/resume/*（简历解析，供简历分析智能体）
app.use(chatRouter) // /api/chat
app.use(agentsRouter) // /api/agents（前端智能体注册表数据源）
app.use(filesRouter) // /api/files/*（v3 文件管理：文件树 / 切片目录 / 正文 / 原件下载）
app.use('/api/management', rateLimiters.management, adminAuth, managementRouter) // 管理接口受管理员认证与限流保护
// ---------- 404 兜底：未匹配路由返回 JSON ----------
app.use((req, res) => {
  res.status(404).json({ message: '未找到该路由', path: req.path })
})

// ---------- 统一错误处理（AppError 体系 + 结构化日志 + 统一响应格式）----------
app.use(errorHandler)

/* ===================== 启动 ===================== */

const BASE_PORT = Number(process.env.PORT) || 3000
// TCP TIME_WAIT 通常最多 60s（2*MSL），这里设 5×10s = 等 50s，基本覆盖绝大多数 Ctrl+C 后再启动的场景
// 如想禁用等待：$env:PORT_RETRY=off ; npm start
const DISABLE_RETRY = /^(off|false|0|no)$/i.test(String(process.env.PORT_RETRY || ''))
const MAX_RETRIES = DISABLE_RETRY ? 0 : 5
const RETRY_WAIT_MS = 10_000
let retries = 0
// 保存 HTTP server 引用，供 SIGTERM/SIGINT 优雅关闭
let httpServer = null

// 明确绑定到 IPv4 127.0.0.1：
// - 与 vite.config.js proxy target 'http://127.0.0.1:3001' 锁定同主机，避免代理 IPv6 解析不一致
// - Windows 上默认 app.listen(port) 会先尝试绑定 IPv6 ::，导致 localhost 连不上 / Vite 代理抛 AggregateError[ECONNREFUSED]
const LISTEN_HOST = process.env.HOST || '127.0.0.1'

function tryListen(port) {
  const server = app.listen(port, LISTEN_HOST, () => {
    const line = '═══════════════════════════════════════════════════════════'
    const LLM_STATUS = llmAvailable ? '✅ 已接入真实模型' : '⚠️   未配置（对话/回答请求将返回 503 错误，不再降级为占位回答）'
    const EMB_STATUS = embedAvailable ? '✅ 已接入真实 Embedding' : '⚠️   未配置（上传/检索将返回 503 错误）'
    const mask = (s) => (s ? `${'*'.repeat(Math.min(6, s.length))}…(len=${s.length})` : '（未设置）')
    console.log(`\n${line}`)
    console.log(`[Interview-Agent RAG] 服务已启动: http://${LISTEN_HOST}:${port}`)
    console.log(`  绑定地址: ${LISTEN_HOST}  |  配置来源: server/.env + shell 环境变量`)
    console.log(`  LLM 模式      : ${llmMode}   ${LLM_STATUS}`)
    console.log(`    · baseURL   : ${llmConfig.baseUrl || '(官方 OpenAI)'}`)
    console.log(`    · model     : ${llmConfig.model}`)
    console.log(`    · apiKey    : ${mask(llmConfig.apiKey)}`)
    console.log(`  Embedding 模式: ${embeddingMode}   ${EMB_STATUS}`)
    console.log(`    · baseURL   : ${embeddingConfig.baseUrl || '(与 LLM 共用)'}`)
    console.log(`    · model     : ${embeddingConfig.model}`)
    console.log(`    · apiKey    : ${mask(embeddingConfig.apiKey)}`)
    if (!llmAvailable) {
      console.log(`\n  💡  配置真实模型的方法：编辑 server/.env 填写：`)
      console.log(`        LLM_BASE_URL=  （例如 Ollama：http://localhost:11434/v1  或  DeepSeek：https://api.deepseek.com/v1）`)
      console.log(`        LLM_API_KEY=   （Ollama 填 ollama；兼容服务填平台给的 Key）`)
      console.log(`        LLM_MODEL=     （例如 qwen2.5-coder:14b / deepseek-chat / gpt-4o-mini）`)
      console.log(`      填完重启后端即可；启动后如看到 LLM 模式 = 'openai-compatible:xxx' 即成功接入。`)
    }
    console.log(`  健康检查: GET /api/health`)
    console.log(`  上传示例: curl -F "file=@a.md" -F "category=前端" http://${LISTEN_HOST}:${port}/api/knowledge/documents`)
    console.log(`${line}\n`)
  })

  httpServer = server
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error('[启动错误] 未知错误:', err)
      process.exit(1)
    }

    retries++
    if (retries <= MAX_RETRIES) {
      const waitedSoFar = (RETRY_WAIT_MS * (retries - 1)) / 1000
      const totalMax = (RETRY_WAIT_MS * MAX_RETRIES) / 1000
      console.warn(
        `[警告] 端口 ${port} 暂不可用（大概率是上一次 Ctrl+C 后 socket 仍处于 TIME_WAIT，最多等 60s 自动释放）。\n` +
          `       已等待 ${waitedSoFar}s / 最长将继续等待约 ${totalMax}s（第 ${retries}/${MAX_RETRIES} 轮，每次 ${RETRY_WAIT_MS / 1000}s）。\n` +
          `       不想等直接按 Ctrl+C，然后执行上面"排查建议 1/2"结束占用进程或换端口。`,
      )
      setTimeout(() => tryListen(port), RETRY_WAIT_MS)
      return
    }

    // 重试耗尽 → 给出可直接复制运行的排查指令
    console.error(`\n[错误] 端口 ${port} 连续 ${MAX_RETRIES + 1} 次无法绑定（EADDRINUSE）。`)
    let pidInfo = ''
    try {
      const raw = execSync(`netstat -ano 2>nul | findstr :${port}`, { encoding: 'utf8' })
      const line = raw.split('\n').find((l) => l.includes('LISTENING'))
      if (line) pidInfo = line.trim().split(/\s+/).pop()
    } catch {
      /* netstat 失败时走降级 PowerShell 提示 */
    }
    console.error('')
    console.error('  排查建议（按优先级复制执行）：')
    if (pidInfo) {
      console.error(`    1. 一键结束占用进程（PID=${pidInfo}）：taskkill /PID ${pidInfo} /F`)
    } else {
      console.error('    1. PowerShell 查询占用者并结束：')
      console.error('         Get-NetTCPConnection -LocalPort 3000 -State Listen |')
      console.error('           ForEach-Object { $proc = Get-Process -Id $_.OwningProcess ;')
      console.error('             Write-Host "name=$($proc.ProcessName) pid=$($_.OwningProcess)" ;')
      console.error('             if ($proc.ProcessName -match "node") { Stop-Process -Id $_.OwningProcess -Force } }')
    }
    console.error(`    2. 换端口启动（推荐，最快）：`)
    console.error(`         后端:  $env:PORT=3001 ; cd server ; npm start`)
    console.error(`         前端:  修改 vite.config.js 中的 proxy target 改为 http://localhost:3001`)
    console.error(`    3. 若是 TIME_WAIT，等待 1 分钟再启动也会自动恢复。\n`)
    process.exit(1)
  })
}

/**
 * 启动前置：Milvus 是独立进程服务，必须先完成「连接 → 集合/索引就绪 → 全量加载缓存」
 * 再开始监听端口，否则请求进来时存储层尚未就绪。
 */
async function bootstrap() {
  try {
    const { dim } = await milvus.init(embedTexts)
    const s = await store.load()
    const { doc, chunk } = milvus.getCollections()
    console.log(
      `[Milvus] 已连接 ${process.env.MILVUS_ADDRESS || 'localhost:19530'} · ` +
        `${doc} + ${chunk} · dim=${dim} · 现有 ${s.documents} 篇 / ${s.chunks} 切片`,
    )
    // 一致性自检：孤儿文档（status=indexed 但 0 切片，多为存储被硬重启/未 flush 丢失）
    const orphans = store.listOrphanDocs()
    if (orphans.length > 0) {
      console.warn(
        `\n⚠️  [对账] 发现 ${orphans.length} 篇「已标记入库但 0 切片」的孤儿文档：` +
          orphans.map((o) => o.title || o.id).join('、'),
      )
      console.warn(
        `   修复：POST /api/knowledge/documents/:id/reindex（单篇） 或 POST /api/knowledge/orphans/reconcile（全量）。\n`,
      )
      // 可选：启动即自动对账重放（对本地单实例场景安全，正文已在 doc 行）
      if (/^(1|true|on|yes)$/i.test(String(process.env.RECONCILE_ON_BOOT || ''))) {
        for (const o of orphans) {
          try {
            await fetch(`http://${LISTEN_HOST}:${BASE_PORT}/api/knowledge/documents/${o.id}/reindex`, { method: 'POST' })
            console.log(`   ↻ 已重新切片入库：${o.title || o.id}`)
          } catch {
            /* 端口未监听时忽略，改由人工触发 */
          }
        }
      }
    }
  } catch (e) {
    if (e?.code === 'EMBED_UNAVAILABLE') {
      console.error('\n[启动失败] Embedding 未配置或不可用：', e.message, '\n')
      console.error('  配置方法：编辑 server/.env 的 EMBED_API_KEY / EMBED_BASE_URL / EMBED_MODEL 后重启。')
      console.error('  （向量检索与入库强依赖 Embedding，按 ADR-009 不再降级为 hash 假向量。）\n')
    } else {
      console.error('\n[启动失败] Milvus 初始化失败：', e.message, '\n')
      console.error('  请确认 Milvus 容器已启动：')
      console.error('    docker ps --filter name=milvus')
      console.error('  若未启动，在项目根目录执行：')
      console.error('    docker compose -f milvus-compose.yml up -d\n')
    }
    // 延迟退出：给 pino/sonic-boom 一拍 flush 时间，避免 exit 竞态崩溃
    setTimeout(() => process.exit(1), 150).unref?.()
    return
  }
  // P1：Agent Spec 注册（agents.db seed + 合并注册），失败内部已降级为内置直注册，不阻断启动
  await initAgentRegistry()
  tryListen(BASE_PORT)
}

/* ===================== 优雅关闭 ===================== */
// 收到终止信号时：先把内存 growing 段 flush 到对象存储（避免未落盘的写入随进程丢失），
// 再停止接收新连接并排空在途请求，最后退出。SIGINT(Ctrl+C) 与 SIGTERM(容器停止) 同路。
let _shuttingDown = false
function gracefulShutdown(signal) {
  if (_shuttingDown) return
  _shuttingDown = true
  logger?.warn?.(`[shutdown] 收到 ${signal}，开始优雅关闭…`)
  const timer = setTimeout(() => {
    logger?.warn?.('[shutdown] 排空超时，强制退出')
    process.exit(0)
  }, 10_000)
  timer.unref?.()
  ;(async () => {
    try {
      await milvus.flush().catch((e) => logger?.warn?.(`[shutdown] flush 失败：${e.message}`))
    } catch {
      /* ignore */
    }
    if (httpServer) {
      httpServer.close(() => {
        logger?.info?.('[shutdown] HTTP 已排空并关闭')
        process.exit(0)
      })
      // 不阻塞退出：给在途请求一个短暂窗口后由 timer 兜底
    } else {
      process.exit(0)
    }
  })()
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

bootstrap()
