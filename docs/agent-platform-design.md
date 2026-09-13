# 通用 Agent 平台改造 · 设计书

> 版本 v1 · 2026-09-12 · 基于 Interview Agent 现有骨架（server/lib 分层 + 插件式注册表 + Milvus/ES 双路检索 + RBAC）
> 目标：从「面试领域专用助手」演进为「可配置、可扩展的通用 Agent 平台」——新增一个领域智能体从「写代码」降为「填配置」。

---

## 0. 现状盘点（改造的出发点）

| 层 | 现有资产 | 通用化差距 |
|---|---|---|
| 智能体 | 前端 `agentRegistry`（元数据）+ 后端 `agentRegistry`（handler）双注册表；4+1 内置 agent | 定义硬编码在 `agentDefinitions.js` / `routes/chat.js`；prompt 硬编码在 `llm.js` 各 stream 函数；加 agent 必须改代码 |
| 模型 | `models.js` 三级路由（agents[agentId] > roles > defaults）+ 模型管理页 | agent 级路由已有，缺 per-task 分档 UI 化 |
| 工具 | `toolRegistry` / `workflowRegistry`（启停 + dependsOn + 统计 + 通用管理页） | 工具是内置 JS 函数；无参数 schema；无外部工具源 |
| 知识 | Milvus kb_documents/kb_chunks 双向量 + ES BM25 + 融合检索 + owner 隔离 | 单库；category 语义绑定面试域；question 锚点策略不可配 |
| 记忆 | kb_memory（长期事实）+ session_memory（滚动摘要） | 按 agent 记忆，无用户级跨 agent 共享记忆 |
| 调度 | 工作流路由（关键词/意图分类）+ reactPlanner / docPlan 多步工作流 | 无 LLM supervisor 派发 |
| 平台 | RBAC（12 权限点 + 角色矩阵）、tunables 热参数、audit、管理页体系 | 权限粒度到页面，不到 agent/工具 |

---

## 1. 总体路线（五期）

```
P1 Agent Spec 配置化 ──► P2 知识库实体化 ──► P3 工具生态（Tool Spec + MCP）
                                                      │
                            P4 Supervisor 调度 ◄───────┘
                                      │
                            P5 平台化收尾（agent 级 RBAC / 用户记忆 / 评测回归 / 工程拆分）
```

每期独立可交付、可回退；P1 决定后续所有接口的形状，本设计书详细展开 P1，P2-P5 给出接口预留与验收标准。

---

## 2. P1 —— Agent Spec 配置化（本期开工）

### 2.1 Agent Spec Schema v1

```jsonc
{
  "id": "code-reviewer",          // [必填] 唯一标识；^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$；创建后不可改
  "name": "代码评审",              // [必填] 显示名（1~50 字）
  "description": "审查代码质量",   // 显示描述（Header/侧栏 tooltip）
  "icon": "bot",                  // 图标 key（前端 ICON_MAP 白名单，默认 'bot'）
  "aliases": ["review"],          // 路由别名（@提及/意图匹配用）
  "enabled": true,                // 停用后侧栏置灰、路由兜底到 default
  "builtIn": false,               // 种子 agent 标记：不可删、不可改 id；handler 绑定内置实现
  "runtime": "chat",              // [必填] 执行通道：
                                  //   'chat' — 直连对话（systemPrompt 生效）
                                  //   'rag'  — 检索增强（复用知识库链路 + persona 融合）
                                  //   内置 agent 为 'builtin'（handler 指向既有实现，不暴露此值）
  "systemPrompt": "",             // runtime=chat：完整人设；runtime=rag：追加在知识库助手规则之后
  "modelRole": "",                // 模型路由角色（默认 chat.general；可指定已有 role）
  "knowledge": { "categories": [] }, // P2 生效：绑定的知识库分类 scope（P1 存储不消费）
  "structuredInput": false,       // 前端结构化输入（技术栈多选）开关
  "greeting": "",                 // 开场白（P1.5 前端消费）
  "suggestions": [],              // 建议问题（P1.5 前端消费）
  "createdAt": "...", "updatedAt": "..."
}
```

**校验规则**：id/name/runtime 必填；systemPrompt ≤ 4000 字；aliases ≤ 8 个且全局唯一（含内置 name/aliases 冲突检测）；suggestions ≤ 5 条。

### 2.2 存储：`data/management/agents.db`（SQLite）

```sql
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT NOT NULL DEFAULT 'bot',
  aliases       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  enabled       INTEGER NOT NULL DEFAULT 1,
  built_in      INTEGER NOT NULL DEFAULT 0,
  runtime       TEXT NOT NULL DEFAULT 'chat', -- chat | rag | builtin
  builtin_ref   TEXT NOT NULL DEFAULT '',     -- built_in 时指向 builtin handler id
  system_prompt TEXT NOT NULL DEFAULT '',
  model_role    TEXT NOT NULL DEFAULT '',
  knowledge     TEXT NOT NULL DEFAULT '{}',   -- JSON（P2 消费）
  structured_input INTEGER NOT NULL DEFAULT 0,
  greeting      TEXT NOT NULL DEFAULT '',
  suggestions   TEXT NOT NULL DEFAULT '[]',   -- JSON array
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

**Seed 迁移**（启动时执行，幂等）：把现有 5 个内置 agent 写入表（`built_in=1, runtime='builtin', builtin_ref=<现有id>`），已存在则跳过。前端图标沿用现有（search/file-text/users/scissors/bot）。

### 2.3 后端架构：builtin 与 spec 的合并注册

```
┌─ agentStore.js（新）────────────────┐
│ agents.db CRUD + seed + listForFrontend() │
└──────────────┬───────────────────┘
               │ spec 列表（含 built_in → builtin_ref）
┌──────────────▼───────────────────┐
│ routes/chat.js 启动注册改造：          │
│   built_in spec → 既有 handler（不变）  │
│   自定义 spec → genericHandler(spec)   │
└──────────────────────────────────┘
```

**genericHandler**（新文件 `lib/agents/genericAgent.js`）：
- `runtime='chat'`：`streamChat` 扩展接受 `systemPrompt` 覆盖默认人设（llm.js 加可选参数，默认行为零回归）
- `runtime='rag'`：复用 `knowledgeBaseAgent` 链路，`systemPrompt` 作为 persona 追加到知识库助手规则后（`withPersona(base, persona)`）

**注册时序**：`routes/chat.js` 模块加载时 `await agentStore.load()` → 遍历 spec 注册（同步注册表 API 不变，注册动作包一层 async init，由 `index.js` 在监听端口前 await）。

### 2.4 API 设计

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/agents` | 登录即可（jwt 有效） | 前端 registry 数据源：`{ version, items[] }`（不含 system_prompt；含 enabled；按 sort_order） |
| GET | `/api/management/agents` | `mgmt.agents` | 管理列表（全字段） |
| POST | `/api/management/agents` | `mgmt.agents` | 新建（id/name/runtime 必填；id 冲突 400） |
| PATCH | `/api/management/agents/:id` | `mgmt.agents` | 部分更新（built_in 仅允许 name/description/aliases/enabled/sort_order；id 不可改） |
| DELETE | `/api/management/agents/:id` | `mgmt.agents` | 删除（built_in 403；有会话历史时软删 → enabled=0 并提示） |

- **RBAC**：`PERM_CATALOG` 增加 `{ key: 'mgmt.agents', label: '智能体管理', group: '系统管理' }`（admin `*` 自动含；历史角色不含新点，需管理员手动勾选——符合现有语义）
- **版本号**：`GET /api/agents` 返回 `version = max(updated_at)`；管理页保存成功后写 `localStorage['agentsVersion']`，AppShell 对比不同则重拉注册表并刷新 Sidebar

### 2.5 前端设计

**注册表改造**（`agentRegistry.js`）：
- 新增 `loadAgentsFromServer()`：fetch `/api/agents` → 逐个 `registerAgent({ ...spec, icon: ICON_MAP[spec.icon] })`；`ICON_MAP` 为白名单映射（bot/search/file-text/users/scissors/…约 16 个 lucide 图标）
- `agentDefinitions.js` 的静态注册保留为**降级兜底**：服务端拉取失败时用内置定义（离线可用）
- 挂载时机：`AppShell` 挂载时调用；`agentsVersion` 变更时重挂（Sidebar 订阅）

**管理页**（`/management/agents`，`AgentsManagePage.jsx`）：
- 卡片列表：图标 + 名称 + runtime 徽章（内置/对话/检索）+ 启用开关 + 描述
- 编辑弹窗：名称 / 描述 / 图标选择器（ICON_MAP 网格）/ 别名（chips 输入）/ runtime 单选（自定义 agent 二选一）/ systemPrompt 多行（带字数）/ structuredInput 开关
- 内置 agent：仅「启用开关 + 名称/描述/别名」，无删除按钮（置灰 + tooltip）
- 删除：confirm 弹窗；后端软删逻辑如 2.4
- Sidebar 系统管理组插入「智能体管理」（ShieldCheck→Bot 图标，`canPerm('mgmt.agents')` 过滤）——目录级权限规则自动生效

**聊天链路消费**：
- ChatPage 已按 `agent.id` 从 registry 取元数据——无需改
- system prompt：走后端 genericHandler，前端零改动

### 2.6 不做 / 后置（明确边界）

- greeting / suggestions 的聊天 UI 消费（P1.5）
- knowledge.categories 的检索消费（P2）
- modelRole 的管理页 UI（模型管理页继续负责模型路由；spec 字段保留）
- 多 agent 工具（P3）；supervisor 派发（P4）

### 2.7 验收标准（P1 DoD）

1. 管理页新建 `runtime=chat` 自定义 agent（自定 prompt），刷新后侧栏出现，可直接对话且人设生效
2. 新建 `runtime=rag` agent，对话时走知识库检索链路（引用卡片正常）且 persona 融合生效
3. 停用内置 agent（如模拟面试）→ 侧栏置灰；重新启用恢复
4. 内置 agent 不可删除/不可改 id；别名与内置冲突时 400
5. RBAC：无 `mgmt.agents` 权限的角色看不到「智能体管理」菜单且 API 403
6. 服务端拉取失败时前端降级到内置定义（离线可登录可用）
7. 后端测试全绿；E2E 覆盖 CRUD + 权限 + 降级

---

## 3. P2 —— 知识库实体化（接口预留）

- 新表 `knowledge_bases(id, name, description, owner_scope, created_at)`；`kb_documents`/`kb_chunks` 加 `kb_id` 列（默认迁移到「默认库」）
- Agent Spec `knowledge.categories` 扩展为 `knowledge: { kbIds: [] }`；检索链路 `unifiedSearch` 加 `kbIds` 过滤参数
- 知识管理页升级：库切换 tab + 库管理（建/删/改名）
- **验收**：两个 agent 绑定不同库，互不可见对方文档

## 4. P3 —— 工具生态（Tool Spec + MCP）

- Tool Spec：`{ name, description, parameters: JSONSchema, requiredPerm, timeoutMs, sandbox }`；`toolRegistry` 条目升级，旧内置工具包一层适配
- **MCP 聚合器**（`lib/tools/mcpClient.js`）：stdio/SSE 两型；启动时按配置连接，`tools/list` 动态注册进 toolRegistry（`source: 'mcp:<server>'`）；管理页可启停单个工具
- agent loop：`lib/agents/loop.js` 统一多轮工具调用（原生 FC 优先，降级 ReAct 文本协议）；工具事件经 SSE `9:` 行下发前端渲染
- **验收**：接入一个文件系统 MCP server，自定义 agent 能多轮调用并给出最终回答

## 5. P4 —— Supervisor 调度

- supervisor agent（内置，可停用）：LLM 意图分类 → 从 spec 列表选择目标 agent → 派发（携带原始 query + 上下文）
- 前端：并行窗格已支撑；supervisor 派发时在目标窗格顶部显示「由 XX 智能体接手」事件条
- 兜底：分类置信度低 / 无匹配 → default agent
- **验收**：同一输入框自然语言触发不同领域 agent，无需手动切换

## 6. P5 —— 平台化收尾

- RBAC 权限点扩展：`agent.<id>` / `tool.<name>`，Agent Spec 增 `requiredPerm`；Sidebar 按角色过滤 agent 列表（现有 canPerm 机制直接复用）
- 用户级记忆：`user_memory(user_id, fact, confidence, agent_scope)`；跨 agent 注入（withMemory 已有挂点）
- 评测回归：题库泛化为 QA 评测集（JSONL）；`npm run eval` 跑检索召回率 + 回答断言
- 工程：`routes/chat.js` 按智能体族拆分；事件总线（agent 生命周期 → audit）

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 前端注册表时序（登录前 /api/agents 未就绪） | AppShell 挂载后拉取 + 内置定义兜底；`version` 机制收敛一致 |
| 自定义 prompt 注入（用户写越权 prompt） | 长度限制；system prompt 仅影响该 agent 自身；RBAC 限制编辑权限 |
| agents.db 与 session/accounts 库多文件管理 | 沿用 data/management/ 目录惯例 + sqliteBrowse 自动发现 |
| 内置 agent 行为回归 | builtin handler 不动；seed 仅写入元数据；测试全绿为门槛 |
