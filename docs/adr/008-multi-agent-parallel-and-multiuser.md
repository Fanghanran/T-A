# ADR-008：多智能体并行 与 多用户（隔离 · 公平 · 边界）

## 状态

**部分实施：M4 多智能体并行（2026-09-05）+ M5a 核心隔离（2026-09-05）已实施；M5b（记忆 per-user 迁移/配额/审计）待开工**

M4 实施记录（与设计稿的差异以本节为准）：
- 前端：`chatRegistry`（React Context）为每个已打开智能体保留一个常驻 ChatPage 窗格，URL `/chat/:agentId` 是焦点的唯一来源；后台窗格 `display:none` 保持挂载（独立 useChat 实例 / AbortController / 会话列表 / techStack），流式继续、互不打断。设计稿的 `Map<agentId:sid>` 简化为**每智能体一个窗格**（会话粒度切换在窗格内部完成）；techStack 从全局状态改为实例级（切换不再重置）。
- 并发上界：`streamGate.js` `MAX_CONCURRENT_STREAMS=3`，在 useChat 的 fetch 包装层统一抢/放槽位，超限直接抛错提示（useChat error 态展示）。
- 未读与在途指示：后台窗格流式结束 → 侧栏对应智能体显示未读计数徽标；后台流式进行中显示脉点（title 提示）。
- 后端：每请求 `AbortController` + `res.on('close')`（`!writableEnded` 时 abort）→ 4 个对话 stream 函数 / 评分卡 / 简历分析 / 文档双工作流全部 `abortSignal` 穿线到 `streamText`/`generateText`；`pipeStream` 对上游错误（含 abort）显式收尾防未处理 error 逃逸。
- 熔断分片：embedding 熔断按 profile 分片已在 M1（ADR-006）落地；LLM 侧无全局熔断器（Fail-Fast 直报），无需分片。
- 限流：chat 限流 key 从 per-IP 细化为 per-(IP, agentName)。
- 并发 gate：`ConcurrencyGate` 升级为两级（全局总量 + 单 caller 配额=全局一半），rewrite 链路以智能体 id 为 caller（unifiedSearch 新增 `caller` 参数）；embed/reindex 现无 gate（无需升级）。
- 实测（2026-09-05，浏览器 + HTTP e2e）：双/三智能体并行流互不打断、后台完成正确计数未读、第 4 路发送被上界拦截并提示、客户端中途断开 → 服务端日志出现「上游流错误，提前收尾」（abort 信号到达 LLM）、两智能体限流各自独立计数（remaining 均 29）。

### B. M5a 核心隔离实施记录（2026-09-05）

- **principal 抽象**（`lib/principal.js` L0）：`AUTH_MODE=disabled`（默认，单一 local 用户，现状零回归）→ `user-token`（请求带 `Authorization: Bearer` / `x-user-token`，令牌只存 sha256，签发明文仅显示一次）→ jwt 留升级位。userId 白名单校验（字母数字下划线连字符），同时作为 Milvus 过滤表达式防注入。管理端点 `GET/POST/DELETE /api/management/users`（adminAuth 保护；user-token 模式下管理端强制要求 ADMIN_TOKEN）。
- **SQLite 迁移**：`schema_version` 表 + 幂等 ALTER（`sessions.owner_id`，存量归 local，v1）；全部会话读写函数显式要求 ownerId（缺参即抛，无默认值——杜绝静默漏传），SQL 按 `owner_id` 过滤。
- **Milvus**：三集合（kb_documents/kb_chunks/kb_memory）加 `owner_id` 标量 + INVERTED 索引；旧 schema 集合由 `ensureCollection` 容错跳过缺失索引，管理端 `POST /storage/owner-rebuild`（默认 dry-run）执行「备份→drop→重建→原行回插（owner=local，向量原样保留不重嵌）→flush→核实」，实测 3 文档/164 切片/12 记忆全量保留。user-token 模式下旧 schema 启动即 fail-fast。
- **过滤覆盖清单**（漏一处即越权，逐项核对）：sessions CRUD/消息/上下文窗口/记忆游标 ✓；documents 列表/详情/状态/删除/编辑/批量操作/分类标签治理 ✓；chunks 列表/同步/删除/查重扫描与清理 ✓；向量检索（含多 query 改写后逐 query）✓；记忆召回/提炼去重（scope:'global' 已升级为 per-user global 语义，按 owner 过滤）✓；上传 prepare/commit 缓存与 job 按 owner 隔离 ✓；doc-processor（REST + ReAct 工具 CommitToStore）✓。系统级例外（admin 遥测，无内容泄露）：/api/health、启动对账、listMemories。
- **跨用户访问语义**：返回 404（资源不存在）而非 403 —— 不泄露存在性；`/api/health` 保持开放（探针），management 保持 adminAuth。
- **前端**：api 层自动附加用户令牌（localStorage），401 时广播 `auth:required` → 全局令牌输入对话框；管理页新增「用户管理」区（签发/吊销）。
- **验收**（2026-09-05 实测）：27/27 隔离矩阵全绿（无令牌 401、跨用户会话/文档读写 404、检索内容隔离、吊销即时生效、管理端 ADMIN_TOKEN 保护）；disabled 模式 `check:all` 全绿零回归（检索/文档/健康全正常）。

落地路线见 `docs/ROADMAP.md` §3.3 / §4：M4 多智能体并行（已完成）、M5 多用户/多实例（条件性、暂缓）。

## 背景

需求拆成两个不同问题，现状各自有边界：

- **多智能体并行（一个用户同时让多个 agent 各跑各的）**：前端是**单 `currentAgent`**，切 agent 会重建 hook、打断上一个在途流、`techStack` 全局 reset；后端本身无状态、按 sessionId 隔离、已加 `sessionId↔agentName` 绑定，但**共享资源无隔离**——一个坏 embedding 触发**全局**熔断会拖垮所有 agent，限流是**全进程 per-IP**。
- **多用户（多人共享一实例）**：项目**从未引入用户/租户体系**（早期计划“明确不做”），但 `scope:'global'` 记忆（ADR-007）、会话、文档、缓存、限流都假定单用户本地。

数据/LLM 层的“会话隔离”已具备（每会话独立 `session_id`/messages/摘要、`useChat({id})` 缓冲隔离、已加竞态序号守卫）；缺口在**前端单实例**与**后端全局共享资源**。

## 决策与分阶段（两项可独立推进）

### A. 多智能体并行

**前端**：单 activeAgent → **ChatRegistry `Map<agentId:sid, ChatState>`**（每 chat 独立 `messages/status/techStack/AbortController/unread`）；`useChat({id})` 本就按 id 隔离缓冲，多实例可**同时流式**；切 `focusChat` 只切可见性不 abort 他流；后台流完成打 `unread`；侧栏从“当前 agent 的会话”改为**跨 agent 活动会话聚合**。并发上界 `MAX_CONCURRENT_STREAMS`（本地 Ollama 弱，限流防连接耗尽）；沿用各 hook 的 seq/cancelled 守卫。

**后端**（依赖 ADR-006）：
- Embedding/LLM **熔断/降级按 profile 分片**（不再全局传染）。
- 每请求 `res.close` → **abort 上游 LLM**（否则并行多流僵尸请求吃满 Ollama 队列——并行场景最关键一条）。
- 并发 gate（rewrite/embed/reindex）从“全局一个”升级为 **按 caller 配额 + 全局总量两级**（公平）。
- 限流 key 从 per-IP 细化为 per-(IP,agent)/per-user。

### B. 多用户（更大地基，条件性/暂缓）

- **principal** 抽象：`userId`(+可选 `tenantId`)；认证三档递进且**对单用户零回归**：`disabled`=单一系统用户 `local`（现状不变）→ `user-token` → `jwt`（本期**不做 OAuth**，只留抽象）。
- 数据隔离：`sessions` 加 `owner_id`（**引入 `schema_version` + 幂等 ALTER**，补齐此前“无迁移框架”缺口）；所有会话/文档/切片/记忆/模板/审计读写按 owner 过滤。
- Milvus：集合加 `owner_id` 标量 + INVERTED 索引，**检索 filter 强制带 owner**；**同集合多租户靠 metadata，绝不每用户建集合**（维度/成本爆炸）。
- ADR-007 的 `scope:'global'` 记忆**重定义为 per-user global**（否则跨用户读画像 = 越权）。
- 配额与公平：per-user 文档/切片/入库速率/并发流/每日 token 预算；LLM/embedding 网关按 principal 轮转。
- 可观测：日志/审计带 `userId`；管理页“活动 chat / 各 user 用量 / per-user 错误率”。

## 后果

- 正面（并行）：单用户可同时跑多 agent、互不打断；坏模型/慢模型被隔离到其角色，不再拖垮全局。
- 正面（多用户）：具备越权防护与公平性；单用户 `local` 零回归。
- 权衡/风险：
  - **多流并行会放大上游并发压力**：必须配每流 abort + 前端并发上界，否则本地 Ollama 排队雪崩。
  - **多用户是破坏性数据改造**：owner 过滤遗漏即越权，需专项测试（跨 user 读写 403）；`schema_version` 迁移需幂等。
  - **进程内资源仍是单实例假设**：真·多实例需先外置限流/缓存失效/`uploadJobs`/registry（见 ROADMAP M5 前置清单），本 ADR 只覆盖“单实例多用户”，不覆盖“多机”。
- 依赖：并行(M4) 依赖 ADR-006；多用户(M5) 依赖 ADR-006 + ADR-007(owner 化的 global)。

## 明确不做（本设计）
第三方 OAuth 登录、每用户独立 Milvus 集合、分布式限流/熔断、多机水平扩展与共享状态外置（另立 ADR）、token 计费聚合。
