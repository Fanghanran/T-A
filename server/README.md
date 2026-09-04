# Interview-Agent RAG 后端

Node.js 22 + Express 服务，提供文档处理、Milvus 向量检索、会话和 Vercel AI SDK data-stream。后端代码不依赖 Python；`server/index.js` 负责组装中间件和路由，业务模块位于 `server/lib/`，HTTP 路由位于 `server/routes/`。

## 快速启动

```bash
# 项目根目录：先启动 Milvus
cd ..
docker compose -f milvus-compose.yml up -d

cd server
copy .env.example .env       # PowerShell；bash 使用 cp
npm install
npm start                    # http://127.0.0.1:3000
```

Milvus 必须在后端启动前可访问。默认 SDK 地址为 `127.0.0.1:19530`，健康检查为 `http://127.0.0.1:9091/healthz`。Compose 使用固定的 Milvus 镜像版本和环境变量占位凭据；请通过根目录 `.env` 或 shell 变量覆盖公开端口和凭据。

## 配置

复制 `.env.example` 为 `.env`。LLM/Embedding 支持 OpenAI 兼容端点：`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`EMBED_API_KEY`、`EMBED_BASE_URL`、`EMBED_MODEL`。无 Key 时默认 LLM stub、Embedding hash，便于本地联调；`LLM_STUB=1` 可强制 stub。

基础设施变量：

| 变量 | 默认 | 说明 |
|---|---:|---|
| `PORT` | `3000` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址；容器部署应设 `0.0.0.0` |
| `MILVUS_ADDRESS` | `127.0.0.1:19530` | Milvus SDK 地址 |
| `NODE_ENV` | — | 生产环境配合安全配置 |

安全：`AUTH_MODE=token` + `ADMIN_TOKEN` 保护 `/api/management/*`；`CORS_ORIGINS` 是逗号分隔 Origin 白名单。LLM、上传、搜索、管理接口使用 `RATE_CHAT_*`、`RATE_UPLOAD_*`、`RATE_SEARCH_*`、`RATE_MANAGEMENT_*` 进程内限流。生产环境不要使用 disabled 认证或默认凭据。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查和统计 |
| POST | `/api/chat` | `{messages, agentName, techStack?, sessionId?}`，AI SDK data stream |
| POST/GET/DELETE | `/api/knowledge/documents[/:id]` | 上传、列表、详情、删除 |
| POST | `/api/knowledge/search` | 语义检索 |
| POST | `/api/knowledge/ask` | RAG data stream |
| POST | `/api/search/query` | 题库与知识库统一检索 |
| POST | `/api/resume/parse` | 简历文件解析（multipart，返回 `{title,text,format,chars}`，不落知识库） |
| `/api/management/*` | — | 工具、工作流、tunables、审计管理（需认证） |

上传默认支持 Markdown、文本、YAML、HTML、CSV/TSV、JSON、PDF、DOCX，大小上限 10MB。统一错误响应包含 `error.code`、`error.message` 和 `requestId`（具体路由的参数错误可能保留兼容的 `message` 字段）。

## 智能体与缓存

聊天智能体注册表为 `lib/agents/agentRegistry.js`，当前包含 `default-chat`、`interview-retrieval`、`knowledge-base`、`doc-processor`、`resume-analysis`（简历分析）、`mock-interview`（模拟面试）；请求按 id/name/alias 分发。工具与工作流另由 `lib/management/registry.js` 管理，并由管理 API 控制启停。

- `resume-analysis`：`/api/chat` 额外接受 body `{resumeText, jd?}`（resumeText 常由 `/api/resume/parse` 得到；有正文时消息文本视作 JD/目标）。输出 `resume_report` 注解 → 前端结构化报告卡（解析/优化建议/JD 匹配/基于简历的面试题/总评分）。
- `mock-interview`：多轮问答（`{techStack}` 定向、引用 questionBank 候选题）；结束传 `{interviewFinish:true}` 输出 `interview_scorecard` 评分卡。

`lib/cache.js` 提供 TTL/LRU；查询改写和文档预览缓存有上限/过期时间。Milvus/SQLite/JSON 是持久化事实来源，写入成功后清理相关缓存。缓存为进程内实现，多实例部署需共享缓存或失效广播。Embedding 维度由启动探测，换模型后需按启动错误提示重建集合。

## 目录

```text
server/
├── index.js                 # Express 入口、中间件、路由挂载、Milvus bootstrap
├── routes/                  # health/chat/knowledge/sessions/interview 等 HTTP 路由
├── lib/agents/              # 聊天智能体 registry 与内置插件
├── lib/management/          # 工具/工作流 registry、管理 API、审计
├── lib/cache.js             # TTL/LRU 缓存
├── lib/milvusStore.js       # Milvus 连接和向量集合
├── lib/vectorStore.js       # 存储门面与缓存
├── lib/docProcessor.js      # 文档解析、切片、入库
├── lib/sessionStore.js      # SQLite 会话
└── data/                    # 运行时数据（不要提交或删除用户资料）
```

## 检查与冒烟

```bash
node scripts/check-layers.mjs
curl http://127.0.0.1:3000/api/health
curl -N -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"你好"}],"agentName":"default-chat"}' http://127.0.0.1:3000/api/chat
```

关键设计决策见 `../docs/adr/`，总架构约束见 `../ARCHITECTURE.md`。
