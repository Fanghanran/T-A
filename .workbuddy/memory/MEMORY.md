# 项目长期笔记 · Interview Agent

面向求职者的**本地私有知识库 + 面试题库 RAG 助手**。单用户、无登录、数据不出本机。

## 技术栈
- 前端：React 18 + Vite + Tailwind + shadcn/ui + Vercel AI SDK（`src/`，无 react-router，`AppShell` 用 `view` state 三态切换）
- 后端：Node + Express（`server/`，`index.js` 单文件 57KB 承载全部 30 条路由，`lib/` 12 个模块）
- 存储：SQLite（会话/消息/标注，better-sqlite3）+ Milvus（向量，1024 维）+ Elasticsearch（BM25 第三通道）
- 模型：本地 Ollama，`qwen3:14b` 生成 + `bge-m3` 向量化（dim=1024），端口 3000

## ⚠️ 环境硬约束
**Windows，没有 VS C++ Build Tools。** 所有需要编译原生 C++ 的依赖都装不上（faiss-node 即因此放弃）。
今后引入任何新依赖，优先选纯 JS/TS 实现或提供预编译二进制的包。

### ⚠️ 必须用 Node 24 跑后端（不是 Node 22）
`better-sqlite3` 的原生模块是用 **Node 24（ABI 137）** 编译的。用 Node 22（ABI 127）启动会报：
```
ERR_DLOPEN_FAILED ... NODE_MODULE_VERSION 137 vs 127
```
后果很隐蔽：后端**能起来、检索问答都正常**，但会话接口全挂（`SESSION_DB_UNAVAILABLE`），
因为 sessionStore 走进了只读降级分支 —— 只看健康检查发现不了。

- 正确启动：`"C:/Program Files/nodejs/node.exe" --env-file-if-exists=.env index.js`（v24.17.0）
- 若重装/升级 Node，需 `npm rebuild better-sqlite3` 或重装该包以对齐 ABI

## 服务启动顺序（后端强依赖 Milvus）
1. Milvus：`docker compose -f milvus-compose.yml up -d`（三容器 healthy）
2. Ollama：本地服务，需有 qwen3:14b + bge-m3
3. Elasticsearch：`docker compose -f docker-compose.yml up -d elasticsearch`（`ES_ENABLED=on` 时必需，约 5 秒就绪）
4. 后端（Node 24）→ 5. 前端 `npm run dev`

## 向量数据库选型
| 阶段 | 选型 | 状态 |
|---|---|---|
| 最初 | faiss-node | ❌ 放弃，需编译原生 C++ |
| 中间 | vectra | ✅ 已退役（2026-08-29 迁移完成，依赖已移除） |
| **当前** | **Milvus 3.0** | ✅ 已上生产链路 |

- **Milvus 部署**：容器 `milvus-standalone/etcd/minio` 全 healthy，19530(gRPC) + 9091(health)，**免 token**（compose 未配认证）
- SDK `@zilliz/milvus2-sdk-node@3.0.5`，与 Server 3.0 版本线对齐，实测 11 项能力全通过
- 存储结构：集合 `kb_documents`（doc_id PK + title_vector）+ `kb_chunks`（chunk_id PK + **text_vector + question_vector 双向量**）
- embedding 维度 **768**（nomic-embed-text），由 `milvus.init(embedTexts)` 运行时探测，不写死
- 原 `data/knowledge/vectra-index/`、`documents.json`、`chunks.json`、`seq.json` 已不再是数据源（文件保留作历史备份）

### 迁移后已知数据现象（非 bug）
- `sample-notes.md` 等存在**重复上传的同名文档**（多个 doc_id 同一 title），故检索结果会出现多条 `xxx § 1`
- 67 个切片中 66 个已有 questions 检索锚点（迁移前仅 1 个）

## 本次重构的关键坑（复用价值高）
1. **Milvus 强制每个 collection 至少一个向量字段** —— 纯标量集合会直接拒绝创建。解法：`kb_documents` 加 `title_vector` 承载（顺带预留文档级语义检索）
2. **Milvus 3.0 的 `getCollectionStatistics().row_count` 恒为 0**（flush 后依然），不可依赖 → 改用强一致 `query` 只取主键计数
3. **AI SDK 的 `streamText().text` 在 abort/流中断时可能永久 pending**，`AbortController` 兜不住 → 必须 `Promise.race` 加硬超时。`queryRewriter.js` 此前因此会让整个检索链路静默挂死
4. **写入后立即可查需 `consistency_level: 'Strong'`**，否则刚插入的切片搜不到（RAG「上传完马上问」是常态）
5. **双路融合分数不能用累加**：`max + min×0.5` 会让分数顶到 1.0 饱和、排序失效。改用 `max(t, qt, ((t+qt)/2)×1.15)`

## 核心断点速查（✅ 已修 / ❌ 仍开放）
1. ✅ **题库死链路 —— 2026-08-30 已修**：`load()` 空题库时自动灌入 `SEED_QUESTIONS`（现 18 题）；新增 `POST/DELETE /api/interview/questions` 录入接口。面试题检索的题库一路现已真正供料
2. ✅ **PDF/DOCX —— 2026-08-30 已支持**：`pdfjs-dist@6.3.289` + `mammoth@1.12.2`（均纯 JS）。`docProcessor.extractDocumentTextAsync()` 承载；PDF 扫描件会明确提示需 OCR。
   ❌ **XLSX / PPTX / ODF / RTF 仍不支持** —— 非面试资料主流格式，需要时再引库（同样须选纯 JS 实现）
3. ✅ **vite proxy 端口 —— 2026-08-30 已修**：target 改为 3000
4. ✅ **question 向量索引 —— 2026-08-29 重构时已修**：text_vector + question_vector 双向量，66/67 切片有锚点，已接入检索
5. ✅ **api.js 死代码 + hook 零日志 —— 2026-08-30 已修**：两个 API 文件接入 `request()`；三个 hook 补 logger；ChunkPreviewPanel 的 onAdjust 已四层接通（ChatPage → MessageList → StreamingMessage → Panel）

## Agent 平台化（P1 已落地 · 2026-09-12）
- **Agent Spec 配置化**：智能体元数据/人设/runtime 全部落 `server/data/management/agents.db`（agents 表），6 个内置 seed 幂等；设计书 `docs/agent-platform-design.md`
- **运行时**：`agentStore`（CRUD + emitSpecChange 变更事件）→ `routes/chat.js syncAgentRuntime` 热注册/注销（新建/改/删/启停免重启）；自定义 agent 走 `genericAgent.js`（runtime=chat → streamChat 完整人设；rag → knowledgeBaseFlow 复用检索+引用，persona 追加）
- **API**：`GET /api/agents`（登录，前端数据源，不泄露 systemPrompt）；`/api/management/agents` CRUD（requirePerm('mgmt.agents')，内置仅展示层字段+启停，删除=软删停用）
- **前端**：`agentRegistry.loadAgentsFromServer()` 服务端化（静态定义降级兜底）+ `AgentsManagePage` + Sidebar/AppShell 接线
- **教训**：同一文件多个 Edit 并行调用会互相覆盖（最后写者存活）——同文件编辑必须串行
- 待办（P2+）：MCP 工具接入、Supervisor 调度、多知识库绑定、agent 级 RBAC 细化

## 数据现状
- 知识库：**4 篇文档 / 51 切片 / kb_vectors 51 向量**（2026-09-12 全量 reindex 后；v3 存储只看 kb_vectors，旧 kb_documents/kb_chunks 是 v2 遗留）
- ⚠️ **kb_vectors 曾被清空**（2026-09-11 Milvus 重启丢未 flush 向量）：症状 = 知识网络图 0 边 + 语义检索失效；修复 = 全量 reindex，已加 flush。**Milvus 重启后务必核对 kb_vectors 行数**
- 图缓存：`lib/graphCache.js` 共享模块，vectorStoreV3 数据变更自动失效（reindex 后图即时刷新，不再等 5 分钟 TTL）
- 重复清理的完整备份：`server/data/dedup-backup-*.json`（含正文，可还原）
- 题库：admin 18 题（存量迁移）；其他用户按 QUESTION_SEED 配置起步（当前 .env=off → 空题库）
- 会话：SQLite，按 ownerId 隔离

## 用户数据隔离（2026-09-12 落地）
- **语义**：所有业务数据按 `ownerId`（=账号 userId）隔离；`ownerId='*'` 是 **admin 聚合视图**（只读跨 owner，写入永远进自己名下）
- **覆盖**：知识库文档/切片（kb.db 锚点 + data/files/<owner>/ + Milvus kb_vectors）/ ES BM25 / RAG 检索 / 知识网络图 / 题库（data/interview/questions/<owner>.json）/ Wiki（data/knowledge/wiki/<owner>.json）/ 会话（原有）
- **接线点**：files.js、interview.js 路由读 scope=admin?'*':userId；chat.js ctx.ownerId 同规则；manager graph 用 **req.adminUserId/adminRole**（adminAuth 设置，管理挂载点没有 req.principal！）
- **存量迁移**：`server/scripts/manual/migrate-owner-local.mjs`（local→admin，幂等已跑：Milvus 304 向量删插 + kb.db + files 目录 + ES 重索引 + 题库/wiki 归位）
- **E2E**：`server/scripts/manual/_e2e_owner_isolation.mjs`（16 断言）

## 性能基线（实测，本地 14B 模型）
- Milvus 检索本身仅约 **50ms**；query 改写才是耗时大头
- 本地 qwen2.5-coder:14b 做 JSON 改写 3 秒跑不完 → `rewriteTimeoutMs` 已从 3000 降到 1200，并加 `rewriteEnabled` 总开关
- 优化后单次 RAG 请求：11.8s → **2.0s**
- 若换响应更快的模型，可调大 `rewriteTimeoutMs` 让改写真正生效（当前 rewritten 基本恒为 false）

## 常用命令（本环境特化）
- **构建必须用 `npx vite build --emptyOutDir false`** —— `npm run build` 会先清空 dist，该删除操作被安全策略拦截导致失败
- npm 装包需绕开沙箱：`npm_config_cache=D:/workplace/.npm-cache` 或 `--cache`（默认 `AppData\Local\npm-cache` 会 EPERM）
- 停服务用 PowerShell：`Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`（Git Bash 里 taskkill 的参数会被路径转义）

## 项目约定
- 后端降级设计贯穿始终：无 API Key 时 embedding 降 hash 向量（256 维 FNV-1a）、LLM 降 stub 摘录式输出，全链路仍可跑通
- 业务日志后端走 pino、前端走 `src/lib/logger.js` 的 `child(namespace)`，均受 DEBUG 开关门控
- 引用溯源不走 HTTP，经 SSE 的 `2:` annotation 行下发，前端 `useChatWithAnnotations` 拦截 fetch 剥离首行
