# ADR-006：模型管理系统（多模型路由 · 运行时可配 · 含 Embedding 重建）

## 状态

**已接受设计 · 暂缓实施（Proposed — 未开工）**（2026-09-03）
落地路线见 `docs/ROADMAP.md` §3.1 / §4（里程碑 M1）。

## 背景

后端当前只跑**单一对话 LLM + 单一 Embedding**：`config.js` 启动时读 `LLM_*/EMBED_*` 冻结为 `llmConfig/embeddingConfig`，`llmProvider.js` 与 `embed.js` 各持一个模块级单例 `_model`，11 个 LLM 调用点全部零参 `getChatModel()`。已知痛点：

- mock-interview 小模型「抱歉无法理解」顽固前缀，只有换更强模型能消除（`ARCHITECTURE.md` 附录 A #3）。
- 换更强对话模型后，检索改写要生效还得同步调大 `rewriteTimeoutMs`——即模型与超时/成本互相牵制，硬编码单模型无法按角色分档。
- 后续不会所有任务共用一个模型：改写/摘要/抽取等“粗活”可用便宜快模型，主推理/评分/简历分析用强模型。

## 决策（用户已确认，三项均为最完整档）

1. **配置形态**：管理页可视化、**运行时热改**（`data/management/models.json` 覆盖式持久化，仿 `tunables`/`registry`，不靠改 .env/重启）。
2. **选择粒度**：**三级** —— 请求级覆盖 > 智能体绑定 > 角色(role)绑定 > 全局默认（默认=现有单模型，**零迁移**）。
3. **Embedding 纳入完整管理**（多 profile + 换模型重建工具 + 启动维度校验）。

### 核心机制
- 新 `lib/models.js`（L0）：`resolveProfile({agentId, role, kind, overrideId})`，优先级 `overrideId > routes.agents[agentId] > routes.roles[role] > routes.defaults[kind] > 内置 default`；`getChatModel(sel)/getEmbedModel(sel)` 按 profileId 做 **keyed 缓存** + `resetProfileCache()`。
- 现有调用点从 `getChatModel()` 改为 `getChatModel({role, agentId})`；**system-prompt 与 model 解耦，prompt 不变**。
- `ROLES` 常量集中映射 11 个调用点：`chat.rag / chat.interview / chat.resume / chat.interview.qa / chat.interview.scorecard / chat.general / chat.doc.analyze / chat.doc.react / chat.doc.plan / chat.rewrite / chat.annotations / embed.index / embed.query`。
- 数据模型 `models.json`：`profiles[]`（`id/kind/label/baseUrl|baseUrlRef/apiKeyRef|apiKeyInline/model/params/dim?/enabled`）+ `routes{roles,agents,defaults}`。密钥 `apiKeyRef`（环境变量名）优先，inline 值读取脱敏（复用 `••••(len=)`）。
- **熔断/降级按 profile 独立**：坏模型只影响其绑定角色，不再全局传染（此点同时服务 ADR-008 的多智能体可靠性）。
- 管理端点挂 `/api/management/*`（自动得 adminAuth+限流+审计）：`GET/POST/PATCH/DELETE /models`、`POST /models/test`（探活；embed 返回 dim）、`PUT /models/routes`（改绑定→`resetProfileCache` 热生效）、`POST /embedding/reindex` + `GET /embedding/jobs/:id`。
- 前端 `ModelsSection` 仿 `TunablesSection`（可折叠+分组卡+行内编辑+“已改/默认”）：Profile 表、路由矩阵、Embedding 重建（`ConfirmDialog` 二次确认 + 轮询进度）；复用现有基元，无新依赖。

### 向后兼容
启动时把现有 `LLM_*/EMBED_*` 自动登记为 `default-chat`/`default-embed` 并绑为各 kind 默认；未配置时行为与今天完全一致，零迁移。

## 后果

- 正面：不同角色/智能体可用不同模型；坏模型只熔断其角色（可靠性红利）；运行时可调，无需重启；密钥不落明文回传；为 ADR-007（记忆的摘要/提炼用快模型）与 ADR-008（按 profile 分片熔断）提供底座。
- 权衡/风险：
  - **换 embedding 模型 = 破坏性重建**（维度不同须重算全量向量）：采用兄弟集合 `kb_chunks_<id>` → 分批重 embed → 计数校验 → 原子翻转活动指针 → 保留旧集合可回滚，默认 dry-run。
  - 改动面较大（约 6 后端新/改 + 2~3 前端新文件、8~10 现有文件小改）；阶段化推进，M1 不碰 embedding 重建即可独立上线。
  - 进程内 provider 缓存 keyed 化：多实例部署仍不共享，见 ADR-008。

## 明确不做（本设计）
成本/token 计费聚合、按负载自动降级路由、多租户模型隔离、在线 fine-tune 管理。
