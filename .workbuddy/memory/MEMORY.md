# 项目长期笔记 · Interview Agent

面向求职者的**本地私有知识库 + 面试题库 RAG 助手**。单用户、无登录、数据不出本机。

## 技术栈
- 前端：React 18 + Vite + Tailwind + shadcn/ui + Vercel AI SDK（`src/`，无 react-router，`AppShell` 用 `view` state 三态切换）
- 后端：Node + Express（`server/`，`index.js` 单文件 57KB 承载全部 30 条路由，`lib/` 12 个模块）
- 存储：SQLite（会话/消息/标注，better-sqlite3）+ JSON（文档/切片元数据）+ vectra（向量）
- 模型：本地 Ollama，`qwen2.5-coder:14b` 生成 + `nomic-embed-text` 向量化，端口 3000

## ⚠️ 环境硬约束
**Windows，没有 VS C++ Build Tools。** 所有需要编译原生 C++ 的依赖都装不上（faiss-node 即因此放弃）。
今后引入任何新依赖，优先选纯 JS/TS 实现或提供预编译二进制的包。

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

## 数据现状
- 知识库：**13 篇文档 / 31 切片**（2026-08-30 清理 5 组同名重复后，原 26 篇 / 67 切片）
- 重复清理的完整备份：`server/data/dedup-backup-*.json`（含正文，可还原）
- 题库：18 题（SEED_QUESTIONS 自动灌入）
- 会话：SQLite，21 会话 / 69 消息

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
