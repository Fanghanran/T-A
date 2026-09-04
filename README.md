# Interview Agent UI + RAG 后端

Interview Agent 是一个前后端分离的 Node/React 知识库与面试助手：前端使用 React 18 + Vite，后端使用 Node.js + Express，向量检索使用 Milvus，LLM/Embedding 使用 OpenAI 兼容接口。

## 架构概览

- `src/`：React 页面、组件、Hooks 与 API 客户端；开发服务器默认 `5173`。
- `server/`：Express API；默认绑定 `127.0.0.1:3000`。入口为 `server/index.js`，路由位于 `server/routes/`，领域与基础设施位于 `server/lib/`。
- `milvus-compose.yml`：本地 Milvus standalone（etcd + MinIO + Milvus）依赖，数据写入 Docker named volumes。
- `docs/adr/`：认证安全、智能体插件、缓存一致性等关键决策。

请求链路为 `Page → Hook → src/lib API → /api → Express route → lib`。Vite 开发代理将 `/api` 转发到 `http://127.0.0.1:3000`；生产部署可分别运行前端静态站点与后端 API，或按 `Dockerfile` 的两个 target 构建。

## 环境要求

- Node.js 22+（后端依赖 `pdfjs-dist`/`utilium` 要求 Node 22；后端 `npm start` 使用 `--env-file-if-exists`）
- npm 9+
- Docker Desktop / Docker Compose（运行 Milvus）

## 本地启动

先启动 Milvus：

```bash
docker compose -f milvus-compose.yml up -d
curl http://127.0.0.1:9091/healthz
```

启动后端（另一个终端）：

```bash
cd server
copy .env.example .env       # PowerShell 可用 Copy-Item
npm install
npm start                    # http://127.0.0.1:3000
```

启动前端：

```bash
npm install
npm run dev                  # http://localhost:5173
```

也可在 Windows 使用 `./start-services.ps1` 启动已存在的 Ollama 容器与项目 Milvus Compose；该脚本不会创建或删除用户资料和运行时数据。

## 配置

复制 `server/.env.example` 为 `server/.env`。LLM/Embedding 配置包括 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`EMBED_*`；无 Key 时 LLM 使用 stub、Embedding 使用本地 hash 向量。Milvus 连接由 `MILVUS_ADDRESS`（默认 `127.0.0.1:19530`）配置。

安全相关配置：

- `AUTH_MODE=disabled|token`。生产环境应使用 `token` 并设置高强度 `ADMIN_TOKEN`；管理 API `/api/management/*` 才需要管理员令牌。
- `CORS_ORIGINS` 为逗号分隔的浏览器 Origin 白名单。生产环境未设置时不允许跨源浏览器请求；本地开发可使用 `http://localhost:5173`。
- LLM、上传、搜索、管理接口分别由 `RATE_*_LIMIT` 与 `RATE_*_WINDOW_MS` 控制，限流为进程内 IP 计数器，多实例部署应迁移到共享限流存储。
- 上传默认受扩展名、MIME 与 10MB 大小限制保护。

## 智能体 registry

`server/lib/agents/agentRegistry.js` 是聊天智能体的插件注册表。当前内置：

- `default-chat`：通用对话兜底。
- `interview-retrieval`（别名“面试题检索”）：题库与知识库双路召回。
- `knowledge-base`（别名“知识库”）：查询改写、多 query 检索与 RAG。
- `doc-processor`（别名“文档处理”）：文档处理工作流。

`POST /api/chat` 通过 `agentName` 按 id、name 或 alias 解析智能体；新增插件应提供 `{ id, name, description, aliases, handler(ctx) }`，并遵守 `ARCHITECTURE.md` 的分层约束。

## API 速查

- `GET /api/health`：健康检查与存储统计。
- `POST /api/chat`：`{ messages, agentName, techStack?, sessionId? }`，返回 Vercel AI SDK data stream。
- `POST /api/knowledge/documents`：multipart 上传文档。
- `GET /api/knowledge/documents`、`GET /api/knowledge/documents/:id`、`DELETE /api/knowledge/documents/:id`：文档列表、详情、删除。
- `POST /api/knowledge/search`、`POST /api/knowledge/ask`：语义检索与 RAG 流式回答。
- `POST /api/search/query`：题库 + 知识库统一检索。
- `/api/management/*`：工具、工作流、调优参数与审计管理，受管理员认证与管理限流保护。

完整端点说明、请求体和响应示例见 `server/README.md`；架构、错误格式、请求追踪和流式协议见 `ARCHITECTURE.md`。

## 构建与检查

```bash
npm run build
cd server && node scripts/check-layers.mjs
```

Docker 构建：

```bash
docker build --target frontend -t interview-agent-ui .
docker build --target backend -t interview-agent-api .
```

前端 target 是 Nginx 静态站点；后端 target 运行 `server/index.js`，仍需通过 `MILVUS_ADDRESS` 连接外部 Milvus。生产环境请使用密钥管理系统注入环境变量，不要把 `.env` 或令牌写入镜像。
