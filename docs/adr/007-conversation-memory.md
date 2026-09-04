# ADR-007：会话记忆机制（会话内滚动摘要 + 跨会话事实向量库）

## 状态

**已接受设计 · 暂缓实施（Proposed — 未开工）**（2026-09-03）
落地路线见 `docs/ROADMAP.md` §3.2 / §4（里程碑 M2，**依赖 ADR-006 模型管理**）。

## 背景

当前“会话”本质是**无状态请求 + SQLite 持久化历史 + 每轮重放滑动窗口**（`getContextWindow`：最近 6 轮 / 6000 字）。由此带来两类遗忘：

- **会话内长对话遗忘**：超过约 6 轮/6000 字的早期约定会被窗口截掉。
- **跨会话不记人**：新开会话不记得用户画像（如“在准备前端面试、熟悉 SSR”）。

项目已有可复用底座：`unifiedSearch` 向量检索、`embed.js`（半开熔断 + hash 降级）、`milvusStore.ensureCollection`、`queryRewriter` 的 `ConcurrencyGate`、`stripToJson`、`tunables` 热更新分组、`llm.js` 的 `buildHistoryContext` 注入范式。

## 决策（用户已确认）

- **两层都要，分阶段交付**。
- 长期记忆写入策略：**LLM 提炼结构化事实 + 向量化**（非原始消息全量入库）。

### 短期层（会话内）：滚动摘要
- `sessionStore` 追加表（`CREATE TABLE IF NOT EXISTS`，零迁移风险）：
  ```sql
  CREATE TABLE IF NOT EXISTS session_summary (
    session_id TEXT PRIMARY KEY,
    summary TEXT,
    until_msg_seq INTEGER,   -- 复用现有单调 msg_seq 作锚点，只摘要「上锚点之后、窗口之外」的轮次
    updated_at TEXT
  );
  ```
- 每 `summaryEveryTurns` 轮，用「旧摘要 + 被截轮次」经 LLM 压缩成 ≤400 字，注入 prompt。

### 长期层（跨会话）：事实记忆库
- 新 Milvus 集合 `kb_memory`（复制现有 `ensureCollection` 模式）：
  `mem_id(PK)/scope('session'|'global')/session_id/agent_name/kind('fact')/text(2048)/content_hash/ts/text_vector`。
- **scope 语义**：`global`=用户画像/偏好（跨智能体、跨会话）；`session`=会话特定事实；由提炼 LLM 对每条标注。
- **去重**：sha256 规范化内容 `content_hash` 强一致查重 + 相似度 ≥0.95 跳过。

### LLM 契约（集中在 llm.js，generateText + stripToJson，镜像评分卡既定取舍）
- `extractMemories({turns})` → `{memories:[{text, scope}]}`：只收**持久有用**信息（身份/技术背景/偏好/目标/长期项目），无则空数组，解析失败静默跳过。
- `summarizeSession({prevSummary, droppedTurns})` → ≤400 字纯文本。
- 二者走 `ConcurrencyGate` + 超时降级；模型选择复用 ADR-006 的 role（`memory.extract`/`memory.summarize` 可绑便宜模型）。

### 管道（挂点在 chat.js，异步、绝不阻塞对话）
- **读（每轮、毫秒级）**：`memoryService.recall()` → 摘要读 `session_summary` + 事实检索 `kb_memory`（filter `(session_id==sid || scope=='global')`，topK 默认 4、字符预算 800）→ `ctx.memory` → `buildMemoryContext()` + `MEMORY_RULE`（“记忆仅背景参考、不得复述、不得虚构、与当前对话冲突以对话为准”）→ 注入各 `stream*`。
- **写（每轮结束、fire-and-forget）**：`onAssistantDone` 后 `onTurnEnd()`：距上次提炼 ≥N 轮则提炼→去重→embed→upsert；窗口外未摘要轮次够则更新滚动摘要；同一 sid in-flight 去重。
- **降级矩阵**：LLM 不可用→跳过提炼/摘要（消息在 SQLite 不丢，下轮补）；`embedMode()=='hash'`→跳过向量写入（hash 向量是噪声），摘要照常；任何异常 log.warn 不上抛。

### 配置与管理
- `tunables` 新增 `memory` 组（热更新）：`enabled` / `recallTopK` / `factBudgetChars` / `summaryBudgetChars` / `extractEveryTurns` / `summaryEveryTurns` / `maxFactsPerExtract`。
- `GET /memory/stats`、`POST /memory/clear`、`POST /documents/:id/reindex` 复用；`/api/health` 暴露 `orphanDocuments` 类指标同理加 `memory` 概要。

## 后果

- 正面：会话内“记得早期约定”、跨会话个性化；失败只 log 不阻塞主链路，下轮自然补；两层独立开关可分别上线/回退。
- 权衡/风险：
  - 提炼依赖小模型质量（同 ADR-005 取舍）：严格 JSON 契约 + 失败跳过 + 一键关。
  - **记忆污染**（错误事实长期误导）：scope 隔离 + 相似去重 + 管理端清除 + “以当前对话为准”规则。
  - **多用户下 `scope:'global'` 是越权点**：升级为 per-user global，见 ADR-008；在 ADR-008 落地前记忆仅供单用户本地使用。
- 依赖：提炼/摘要调用 LLM，受益于 ADR-006 的角色模型选择（便宜模型做提炼、强模型做主答）。

## 明确不做（本设计）
原始消息全量向量入库、记忆编辑 UI、重试队列、多机共享记忆（与 ADR-008 一并考虑）。
