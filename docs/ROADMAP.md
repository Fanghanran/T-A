# 统一实施路线图（ROADMAP）

> 本文件是「整理现有全部计划 + 规划后续实施」的存档，由只读规划阶段产出。
> **本文件本身不含任何实现**；各里程碑开工前需逐项批准。
> 最后更新：2026-09-03

---

## 0. 文档定位
- 汇总当前项目的**已完成基线**、**关键发现**、**已确认并落盘 ADR 的三套设计**、**建议实施顺序与依赖**、**环境约束**。
- 三套设计（模型管理 / 会话记忆 / 多智能体并行·多用户）的正式 ADR **已落盘**（见 §3 链接与 `docs/adr/006~008`）；本文仍为**索引与排期**，各设计的**实现仍按里程碑暂缓**，开工前逐项批准。

---

## 1. 已完成基线（均已代码+文档落地核实）

| 领域 | 现状 | 证据 |
|---|---|---|
| 后端分层 | L0–L9 严格分层 + `check-layers` 静态守卫，纳入 `check:all` | `server/scripts/check-layers.mjs`、`ARCHITECTURE.md` |
| 智能体插件化 | 后端 `agentRegistry` + 6 内置 agent；前端 `agentRegistry`，4 agent 全 `available:true` | `server/lib/agents/`、`src/lib/agentDefinitions.js` |
| 向量存储 | vectra → Milvus 迁移完成；双向量 text_vector + question_vector，运行时维度探测 | `server/lib/milvusStore.js`、`vectorStore.js` |
| 切片写耐久 | 写完 flush+强一致核实才置 indexed、空切片拒入、启动/health 孤儿对账、reindex 自愈 | ADR-004、`server/lib/vectorStore.js`、`routes/knowledge.js` |
| 会话存储 | SQLite WAL + checkpoint 加固 + 优雅关闭（SIGTERM/SIGINT 先 flush 再排空） | `server/lib/sessionStore.js`、`index.js` |
| 检索质量 | Query 改写（超时降级/质量校验/LRU/并发门控）+ 多路加权合并 | `queryRewriter.js`、`unifiedSearch.js` |
| 安全 | 认证/CORS 白名单/分层限流/requestId 校验/AppError；会话 `sessionId↔agentName` 绑定；`PROTECT_SESSIONS` 开关；chat body 收口（单条 32k / resumeText 200k / jd 20k 等） | ADR-001、`security.js`、`routes/chat.js`、`index.js` |
| 质量门禁 | ESLint(含 react-hooks)+Prettier+Vitest+node --test+分层+构建，统一 `check:all`；CI 工作流文件存在 | `package.json`、`.github/workflows/ci.yml` |
| 前端健壮性 | 4 个 hook 请求序号竞态防护、`runtimeAnnotations` LRU 上限、原生 confirm 清零、上传统一 `request()`、大文件拆分、vendor `manualChunks`、仪表盘/文档懒加载 | 最近一轮债务清偿（`ARCHITECTURE.md` 附录 A） |
| 检索与应答质量 | 混合检索（近重复折叠+单文档配额+2-gram 覆盖率加权）+ FAQ 直接应答 prompt（修复「答非所问」），详见 [`adr/010`](./adr/010-hybrid-retrieval-faq-answer.md) | ADR-010、`unifiedSearch.js`、`llm.js` |
| 新智能体 | 简历分析 + 模拟面试（单次 JSON 报告卡，向后兼容插件化接入） | ADR-005、`server/lib/agents/builtin/`、`ResumeReportPanel`/`InterviewScorecardPanel` |

---

## 2. 关键发现（需正视，影响后续一切）

1. **项目未纳入 git**（无 `.git` 目录）。后果：`ci.yml` 与 `.gitignore` 形同虚设，**无法按 PR 触发门禁、无法回滚**，违反 `ARCHITECTURE.md` 第九节自身规范。→ 列为 **M0**（最高优先、低风险）。
2. **文档漂移**：
   - `ARCHITECTURE.md` 质量门禁表曾标 CI「待补」，与附录「已完成」矛盾（需校准）。
   - `docs/` 若干历史计划文档仍以 **Vectra** 表述（已换 Milvus），行号失效，属历史规格未标注归档。
   - `server/_e2e_*`、`_check_orphans` 等临时脚本散在根目录，未纳入 `npm`/CI、未归档。
3. **单实例假设遍布**（进程内资源，多实例前必须外置）：限流 `rateLimiters`、`TtlLruCache`、agent/tool registry、`uploadJobs` 内存 Map。多处 ADR 已点名。
4. **环境约束**：Windows 无 C++ Build Tools → 新依赖必须纯 JS 或带预编译（`better-sqlite3` 已走 npmmirror 预编译，见 `server/.npmrc`）；Milvus 有 OOM(137) 历史，`restart` 策略已加。

---

## 3. 已落盘的三套设计（ADR 已成文，实现仍按里程碑暂缓）

### 3.1 模型管理 → 已落盘 [`adr/006-model-management.md`](./adr/006-model-management.md)
**动机（已落地的痛点）**：mock-interview 小模型顽固前缀「换更强模型可消除」（附录 A#3）；换更强模型需调大 `rewriteTimeoutMs` 才生效。当前所有任务共用单一 LLM/Embedding（`config.js` env 定死 + `llmProvider.js`/`embed.js` 各单例 `_model`，11 个调用点零参 `getChatModel()`）。

**已确认决策（用户选定）**：
- 配置形态：**管理页可视化、运行时热改**（`data/management/models.json` 覆盖式持久化，仿 tunables/registry，不靠改 .env/重启）。
- 选择粒度：**三级** —— 请求级覆盖 > 智能体绑定 > 角色(role)绑定 > 全局默认（默认=现有单模型，零迁移）。
- Embedding：**完整纳入**（多 profile + 换模型重建工具 + 启动维度校验）。

**要点**：新 `lib/models.js`(L0) `resolveProfile({agentId,role,kind,overrideId})` + keyed provider 缓存 + `resetProfileCache`；`ROLES` 常量映射 11 个调用点；密钥 `apiKeyRef` 优先 + 读取脱敏；熔断/降级**按 profile 独立**（坏模型只影响其角色）；管理端点挂 `/api/management/*`；前端 `ModelsSection` 仿 `TunablesSection`。
**硬约束**：换 embedding 模型/维度 = **破坏性重建向量集合**（兄弟集合 → 重 embed → 校验计数 → 原子翻转 → 保留旧集合回滚，先 dry-run）。

### 3.2 会话记忆 → 已实施（M2 交付，2026-09-05） [`adr/007-conversation-memory.md`](./adr/007-conversation-memory.md)
**原现状**：仅固定窗口（最近 6 轮 / 6000 字，`getContextWindow`），长对话遗忘、新会话不记人。
**已确认决策**：两层、分阶段；写入用 **LLM 提炼事实 + 向量化**。
- 短期层（会话内）：**滚动摘要**（`session_memory` 表，摘要/提炼双游标，每 N 轮压缩被截轮次，注入 prompt）。
- 长期层（跨会话）：**事实记忆库**（Milvus `kb_memory`，scope='session'|'global'，`content_hash` 强一致去重，每轮检索 topK 注入）。
- 全链路异步、绝不阻塞对话；失败语义按 ADR-009（召回失败 warn 继续、提炼失败游标不前进下轮重试）；`tunables.memory` 组热更新；管理端 `memory/stats` + `memory/clear`。
- 实现与设计差异（如相似度去重未做、独立 memory 角色未拆）见 ADR-007 状态节「实施记录」。
**依赖**：摘要/提炼要调 LLM → 依赖 M1 的模型选择能力（给提炼/摘要配「快/便宜」模型）。

### 3.3 多智能体并行 / 多用户 → M4 已实施（2026-09-05）/ M5 暂缓 [`adr/008-multi-agent-parallel-and-multiuser.md`](./adr/008-multi-agent-parallel-and-multiuser.md)
**两个不同问题**：
- 多智能体并行：✅ 已实施——前端 `chatRegistry` 常驻多窗格（每智能体一个 ChatPage 实例，URL 决定焦点，后台窗格流式继续）+ `streamGate` 并发上界（3）+ 未读徽标/在途脉点；后端每流 `res.close`→abort 上游 LLM、chat 限流 per-(IP,agent)、rewrite 两级并发闸门（全局+单 caller 配额）。实施差异见 ADR-008 状态节。
- 多用户：`principal`(userId/tenantId) 抽象（`disabled`=单一 local，零回归）+ `sessions` 加 `owner_id` + `schema_version` 幂等迁移 + Milvus 强制 owner 过滤 + 记忆/配额 per-user + 公平调度 + 审计带 userId。**注意**：现记忆 `scope:'global'` 在多用户下是越权点，须改为 per-user global。**维持暂缓**。
**边界**：后端已按 sessionId 隔离、已加 sid↔agent 防串。多用户属**架构级、暂缓**（维持“不引入租户体系”决定，仅留设计与未来开工清单）。

#### M5 开工方案（默认值已定，待明确开工指令后执行）

前置依赖（M1/M2/M4）已满足，随时可开工。因属安全关键 + 破坏性数据改造（此前被明确暂缓），执行前需一次明确「开工 M5」指令；以下默认值已按 ADR-008 与工程保守性选定：

- **切片**：先 **M5a 核心隔离**（principal 抽象 + `schema_version` 幂等迁移 + `sessions`/文档 `owner_id` + Milvus 三集合 owner 标量与强制过滤 + 跨用户 403 专测矩阵 + `disabled` 模式零回归验证）→ 再 **M5b**（记忆 `scope:'global'` 迁移为 per-user、per-user 配额、审计带 userId、管理页用量视图）。
- **认证**：principal 抽象先行落地，`AUTH_MODE=disabled` 为默认（现状零回归）；同批实现 `user-token` 档（管理页签发/吊销 token），jwt 留升级位。不做 OAuth（ADR 既定）。
- **迁移**：SQLite `schema_version` 幂等 ALTER，存量数据归属 `local` 用户；Milvus owner 标量 = 集合重建（走既有「备份→重建→原子翻转」流程，默认 dry-run）。
- **验收**：跨用户读写 403 矩阵全绿 + `disabled` 模式 `check:all` 与既有端到端零回归 + owner 过滤覆盖清单（sessions / documents / chunks / memory / audit 逐项核对）。

---

## 4. 里程碑与依赖顺序

```
M0 工程地基 ─→ M0.5 落盘 ADR(006/007/008)
                      │
                      ├─→ M1 模型管理 ──┬─→ M2 会话记忆
                      │                 └─→ M4 多智能体并行
                      └─  M3 残留债务（可与 M1/M2 并行穿插）
                                              │
                                          M5 多用户/多实例（暂缓·条件性）
```

| 里程碑 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| **M0 工程地基** | `git init` + 首次提交（恢复 CI/回滚）；校准 ARCHITECTURE 与 docs Vectra 漂移；归档 `_e2e_*` 临时脚本；可补 `docs/adr/` 记录 vectra→Milvus 迁移 | 低 | — |
| **M0.5 ADR 落盘** | ✅ 已完成：006/007/008 三份 ADR 已写入 `docs/adr/`，并接入 `ARCHITECTURE.md` 索引（本文 §3 互链） | 低（纯文档） | M0 |
| **M1 模型管理** | ✅ 已完成（2026-09-04）：`models.js`(L0) + keyed 缓存 + 调用点走 `getChatModel({role,agentId})` + 管理 CRUD + 前端 `ModelsSection`；env 种子零迁移 | 中 | M0.5 |
| **M2 会话记忆** | ✅ 已完成（2026-09-05）：`memoryService`(L4) + `session_memory` 滚动摘要 + `kb_memory` 事实库（embed 走 M1 profile）+ ADR-009 失败语义 + `memory/stats`·`memory/clear` 端点 | 中 | **M1** |
| **M3 残留债务** | ✅ 已完成（2026-09-05）：lint 警告 33→0、3 处 hook 豁免正式化、`GET /documents/:id/status` + API client、commit-journal 评估结论落盘 ADR-004 | 低 | 可与 M1/M2 并行 |
| **M4 多智能体并行** | ✅ 已完成（2026-09-05）：前端 chatRegistry 常驻多窗格 + streamGate 上界(3) + 未读/脉点；后端每流 abort 上游 + 限流 per-(IP,agent) + 两级并发闸门 | 中高 | **M1** |
| **M5 多用户/多实例** | principal 抽象 + owner_id + Milvus owner 过滤 + 共享限流/缓存失效/uploadJobs 外置/registry 外部化 + `PROTECT_SESSIONS` 默认开 | 高（安全关键，需专测） | M1 + M4；**条件性/暂缓** |

---

## 5. 关键约束与不做项

- **换 embedding = 破坏性重建**：默认 dry-run + 保留旧集合回滚。
- **多实例前必须先外置进程内状态**（限流/缓存/jobs/registry），否则会假共享成功。
- **不破坏单用户**：`disabled` 身份=单一 local，所有 owner 过滤对 local 全通过，零回归。
- **新依赖**：Windows 无 C++ Build Tools → 纯 JS/预编译优先（BullMQ/需 Redis 的方案在多实例里程碑再评估）。
- **明确不做（防蔓延）**：第三方 OAuth、每用户独立集合、分布式限流/熔断、token 计费聚合、在线 fine-tune 管理、多机水平扩展（后者另立 ADR）。

---

## 6. 每里程碑验证方式（开工时执行，本文件登记不执行）
- 通用：`npm run check:all`（build + 前端测试 + lint + format + 后端测试 + `check-layers`）全绿；关键项补单测。
- M1：`models` 解析优先级单测 + 本地多模型手测（rewrite 绑快模型、resume 绑强模型，按角色命中不同模型）。
- M2：✅ 已实测（2026-09-05）：两轮对话后摘要滚动 + 事实入库（跨会话 hash 去重生效）；新会话「你还记得我是谁吗」命中全部注入事实；`memory/stats`·`memory/clear` 可用；`check:all` 全绿。30+ 轮长会话回归与 stub 降级演练留待日常使用观察。
- M3：✅ 已完成（2026-09-05）：lint 警告清零（0 errors 0 warnings）、3 处 eslint-disable 豁免全部以稳定依赖正式化、status 端点实测（强一致 chunkCount + orphan 检测 + 404）、commit-journal 评估结论（不采用 + 重新评估触发条件）落盘 ADR-004；`check:all` 全绿。
- M4：✅ 已实测（2026-09-05）：双/三智能体并行流互不打断（后台完成答案完整）、切换不打断、未读徽标与在途脉点生效、第 4 路发送被上界拦截提示、客户端断开 → 服务端日志确认 abort 到达 LLM、限流 per-(IP,agent) 独立计数；`check:all` 全绿。
- M5：越权/隔离专测（跨 user 读写 403）、公平调度、审计含 userId。

---

## 7. 备注
- 本 ROADMAP 为「保存计划、暂不实施」产物。后续说「开工 M0 / M1 …」再逐项进入实现。
- 三套设计的完整技术细节以各自正式 ADR 为准（006/007/008 **已落盘**，见 §3 链接）；本文件为**索引与实施排期**，实现仍按里程碑暂缓、开工前逐项批准。
