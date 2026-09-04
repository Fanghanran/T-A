# ADR-008：多智能体并行 与 多用户（隔离 · 公平 · 边界）

## 状态

**已接受设计 · 暂缓实施（Proposed — 未开工）**（2026-09-03）
落地路线见 `docs/ROADMAP.md` §3.3 / §4：M4 多智能体并行（依赖 ADR-006）、M5 多用户/多实例（条件性、暂缓）。

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
