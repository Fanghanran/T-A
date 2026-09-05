# Interview Agent — 架构规范

> 本文档是项目的**强制性架构约束**，所有新增和修改的代码必须遵守。  
> 违反规则的 PR 不应合入；`check-layers.mjs` / ESLint / 测试 / 构建能自动检查的部分已机器化守卫，其余靠 Code Review 把关。  
> **最后校准：2026-08-31**（已反映架构重构与全量优化的真实落地状态）。

---

## 一、项目总览

```
trae/
├── src/                    # 前端（React + Vite + React Router + Tailwind + shadcn/ui）
│   ├── components/         # UI 组件（按业务域分子目录）
│   ├── hooks/              # 自定义 Hook（状态与副作用的唯一出口）
│   ├── lib/                # 纯函数工具、API 客户端、常量、智能体注册表
│   ├── pages/              # 页面组件（仅组合 Hook + Component，不含业务逻辑）
│   ├── App.jsx             # 根组件（BrowserRouter + ThemeProvider + ErrorBoundary）
│   ├── main.jsx            # 入口（挂载 React）
│   └── index.css           # 全局样式 / CSS 变量主题
├── server/                 # 后端（Node.js + Express）
│   ├── index.js            # 入口（L9）
│   ├── env.js              # 环境变量读取（L0）
│   ├── lib/                # 分层业务模块（L0–L7）
│   │   └── agents/         # 智能体注册表（L5）与内置智能体（L4）
│   ├── routes/             # HTTP 路由（L8）
│   ├── test/               # Node 内置测试（node --test）
│   └── data/               # 运行时数据（gitignore）
├── tests/                  # 前端 Vitest 测试
├── docs/                   # 设计文档 + ADR（docs/adr/）
├── Dockerfile              # frontend / backend 双 target 部署
├── milvus-compose.yml      # 本地 Milvus 依赖（固定版本 + 环境变量凭据）
└── ARCHITECTURE.md         # 本文档
```

技术栈：前端 **React 18 + Vite 5 + React Router 7 + Tailwind + shadcn/ui + Vercel AI SDK 3**；后端 **Node 22 + Express + Milvus + SQLite(better-sqlite3) + Pino**。

---

## 二、后端分层架构（强制执行）

后端采用 **10 层严格分层**，依赖只允许**自上而下**，由 `scripts/check-layers.mjs` 自动检查（当前 **42 个模块 / 140 条依赖边**）。

| 层 | 职责 | 模块 | 允许引用 |
|----|------|------|----------|
| **L0** 基础设施 | 环境、配置、日志、错误、追踪、安全、缓存、共享工具 | `env.js` `config.js` `logger.js` `errors.js` `requestTrace.js` `security.js` `tunables.js` `cache.js` `mathUtils.js` `textUtils.js` `streamUtils.js` `llmProvider.js` | 无内部依赖 |
| **L1** 存储 | 数据持久化（Milvus / SQLite / JSON） | `milvusStore.js` `vectorStore.js` `sessionStore.js` `questionBank.js` | L0 |
| **L2** 算法 | 纯计算 / 无外部服务调用 | `chunker.js` `embed.js` `queryRewriter.js` | L0–L1 |
| **L3** LLM | 大模型流式调用 | `llm.js` | L0–L2 |
| **L4** 领域 | 业务编排（跨模块协调） | `docProcessor.js` `unifiedSearch.js` `chunkAudit.js` `agents/builtin/*` | L0–L3 |
| **L5** 注册表 | 工具/工作流注册与发现 + 智能体注册表 | `management/registry.js` `management/audit.js` `agents/agentRegistry.js` | L0 |
| **L5.5** 意图 | 用户意图解析 | `intents.js` | L0–L5 |
| **L6** 工具 | 注册的具体工具实现 | `tools/docTools.js` | L0–L4（禁止引用 L7） |
| **L7** 工作流 | LLM 驱动的多步骤编排 | `workflows/*` | L0–L5（**禁止直接引用 L6**，必须经 `registry.resolveRunner`） |
| **L8** HTTP | 路由、请求处理、响应序列化、智能体分发 | `routes/*` `management/manager.js` | L0–L7 |
| **L9** 入口 | Express 组装、中间件挂载、启动 | `index.js` | 全部 |

### 硬性规则

1. **禁止反向依赖**：低层不得 import 高层（如 L1 不得引用 L3）。
2. **禁止工作流–工具直连**：L7 必须通过 `toolRegistry.resolveRunner(name)` 调用工具。
3. **lib 不得引用 routes 或 index.js**。
4. **禁止循环依赖**。
5. **新增模块必须登记到 `check-layers.mjs` 的 `LAYERS` 映射表**，否则检查脚本报错。

### 新增模块归属判断

- 纯 I/O 封装（数据库、文件）→ L1
- 纯计算 / 算法（无副作用或仅调 L1）→ L2
- 调 LLM API → L3
- 跨多个 L2/L3 模块协调 → L4
- 注册表 / 发现机制 → L5
- 新增工具 → L6；新增工作流模式 → L7

### 关于 `agents/` 的特殊约束

- `agents/agentRegistry.js`（L5）必须是**纯数据结构**，禁止 import 任何 L4 及以上模块。
- `agents/builtin/*`（L4）可引用 L0–L3；`doc-processor` 因其 handler 需要 L7 工作流与 L5 注册表，其 handler **内联在 `routes/chat.js`（L8）注册**，并把 L5+ 依赖经 `ctx` 注入，从而 builtin 文件本身保持 L4 合规。
- 新智能体只需 `agentRegistry.registerAgent({ id, name, aliases, handler })`，无需改 `routes/chat.js` 的分发逻辑。

---

## 三、后端编码规范

### 3.1 模块结构

每个 `lib/` 模块必须遵循：模块级 JSDoc（含**依赖层**）→ 按层分组 import → 私有状态 → 内部辅助（不导出）→ 文件末尾统一 `export`。

### 3.2 错误处理

- **统一使用 `AppError` 体系**（`lib/errors.js`）：`NotFoundError` / `BadRequestError` / `ServiceUnavailableError`。
- Route handler 用 `try/catch` + `next(err)`，由全局 `errorHandler` 统一响应。
- **禁止吞掉错误**：不允许 `.catch(() => {})`。至少记录 `log.warn`。
- 降级策略（如 embedding 失败回退 hash 向量）必须在函数内显式注释说明。

### 3.3 日志

- 使用 `childLogger(moduleName)` 创建子 logger，禁止直接 `console.log`。
- 级别：`error`（需人工介入） / `warn`（降级、重试） / `info`（关键业务事件） / `debug`（开发，生产关闭）。

### 3.4 共享工具提取规则

当同一段逻辑出现在 **2 个及以上模块** 时，必须提取到唯一实现。**已落地的统一位置（L0/L2）**：

| 重复代码 | 归属 | 放置位置 |
|----------|------|----------|
| LLM provider 创建与缓存 | `getChatModel()` / `resetChatModel()` | `lib/llmProvider.js` |
| `stubStream` 模拟流式输出 | `stubStream()` | `lib/streamUtils.js` |
| `prependAnnotation` 注解前缀 | `prependAnnotation()` | `lib/streamUtils.js` |
| `cosineSimilarity` 余弦计算 | `cosineSimilarity()` | `lib/mathUtils.js` |
| `stripToJson` JSON 提取 | `stripToJson()` | `lib/textUtils.js` |
| TTL/LRU 缓存 | `TtlLruCache` | `lib/cache.js` |

> 历史提示：以上重复已在重构中消除（原 `llm.js` / `docProcessor.js` / `queryRewriter.js` / `docWorkflowShared.js` / `chunker.js` 各自的副本已删除并改为 import）。新代码写之前先 `grep` 确认是否已有实现，**同一功能只允许一份实现**。

### 3.5 存储层规范

- **Milvus**：所有向量操作通过 `milvusStore.js`，上层通过 `vectorStore.js` 的缓存接口访问。禁止绕过缓存直接操作 `milvusStore`。
- **SQLite**：所有会话操作通过 `sessionStore.js`。使用预编译语句 + WAL。**db 不可用时读操作安全降级返回空，写操作返回明确 `SESSION_DB_READONLY` / `SESSION_DB_UNAVAILABLE` 错误**，禁止在 `db===null` 时执行 `exec/prepare`。
- **JSON 文件**：原子写入（写 `.tmp` 后 `rename`），禁止直接覆盖。
- **内存缓存**：所有 `Map` 类缓存必须走 `lib/cache.js` 的 `TtlLruCache`（TTL + 最大条目 + 可选字节上限 + 定时清理 `unref()`）。禁止无界增长的 `Map`。

### 3.6 安全基线（已实现，由 `lib/security.js` 提供）

| 能力 | 现状 | 环境变量 |
|------|------|----------|
| CORS | 已改为 Origin 白名单；生产未配置时默认拒绝跨域 | `CORS_ORIGINS` |
| 认证 | `AUTH_MODE=token` 时管理端点校验令牌；生产 + `ADMIN_TOKEN` 自动启用 | `AUTH_MODE` `ADMIN_TOKEN` |
| 限流 | 进程内分层限流（聊天 / 上传 / 搜索 / 管理） | `RATE_CHAT_*` `RATE_UPLOAD_*` `RATE_SEARCH_*` `RATE_MANAGEMENT_*` |
| 安全响应头 | 已注入基础安全头 | — |
| 请求校验 | chat/knowledge query 长度与结构校验 | — |
| requestId | 仅接受 `[A-Za-z0-9._-]{1,128}`，否则生成 UUID，防止日志注入 | — |

- `/api/management/*` 在入口统一挂载限流 + 认证；健康检查保持公开。
- 文件上传：扩展名白名单 + 大小限制（10MB）+ 内容类型校验。
- **生产部署必须显式设置 `ADMIN_TOKEN`、`AUTH_MODE=token`、`CORS_ORIGINS`，不得把开发默认值当作生产安全边界。**
- 限流器为进程内实现，**多实例部署需外置共享存储**。

---

## 四、前端架构规范

### 4.1 目录职责

```
src/
├── components/
│   ├── ui/           # 原子组件（Button, Dialog, Badge...）—— 无业务逻辑，纯样式+交互
│   ├── layout/       # 布局组件（AppShell, Sidebar, Header）
│   ├── chat/         # 聊天域组件
│   ├── knowledge/    # 知识库域组件
│   ├── management/   # 管理域组件
│   └── agents/       # 智能体特有组件
├── hooks/            # 自定义 Hook —— 状态获取与副作用的唯一出口
├── lib/
│   ├── api.js        # ⭐ 唯一 HTTP 客户端（所有请求必须经此）
│   ├── knowledgeApi.js      # ✅ 已使用 request()
│   ├── sessionApi.js        # ✅ 已使用 request()
│   ├── docProcessorApi.js   # ✅ 已使用 request()
│   ├── managementApi.js     # ✅ 已使用 request()
│   ├── agentRegistry.js     # 智能体注册表（前端插件化扩展点）
│   ├── agentDefinitions.js  # 内置智能体注册（副作用 import）
│   ├── chunkPresets.js      # 上传切片预设常量
│   ├── documentListUtils.js # 文档列表工具/常量
│   ├── constants.js         # 从 agentRegistry 派生 AGENTS + 其他常量
│   ├── runtimeAnnotations.js# 注解独立存储（⚠️ 见附录：无界 Map 待收敛）
│   ├── utils.js
│   └── logger.js
└── pages/            # 页面组件 —— 只组合 Hook + Component（路由级懒加载）
```

### 4.2 数据流规则（强制）

```
Page（视图）→ Hook（状态/副作用）→ lib/*.js（API 客户端）→ 后端 REST
```

1. **Page 组件不得直接调用 `fetch` 或 `api.js`**。所有数据获取必须通过 Hook。
2. **Component 不得直接调用 API**。数据通过 props 从 Page 传入。
3. **Hook 是副作用的唯一容器**。`useEffect`、`fetch`、事件订阅只允许出现在 Hook 中。
4. 例外（唯一允许 `fetch` 的底层文件）：`lib/api.js`（统一客户端实现）与 `hooks/useChatWithAnnotations.jsx`（SSE 流式拦截）。其余一律禁止裸 `fetch`。

### 4.3 API 层统一（已完成）

所有 HTTP 请求均通过 `lib/api.js` 的 `request()`：自动附加 `x-request-id`、统一 `AppError` 归一化、204/流式响应统一处理。`docProcessorApi.js`、`managementApi.js`、`knowledgeApi.js`、`sessionApi.js` 与 `ChatInput` 的文件上传（FormData 直接透传）均已迁移到 `request()`。

### 4.4 Hook 设计规范

#### 单一职责

每个 Hook 只负责一个数据域，单 Hook **≤ 200 行**；状态变量超过 **8 个**时拆分或引入 `useReducer`。

原 `useKnowledgeBase`（560 行）已拆分为编排器 + 7 个子 Hook：

```
useDocumentList      列表 / 过滤 / 排序 / 分页 / 批量选择标识
useDocumentFacets    分类 / 标签聚合
useDocumentStats     统计（文档数 / 切片数 / 分类分布）
useDocumentPreview   文档详情预览 / 切片查看
useDocumentSearch    语义检索
useDocumentMutations 上传 / 手动录入 / 删除 / 编辑
useBatchOperations   批量删除 / 改分类 / 加标签 / 去标签（内部统一 runBatch）
```

`useKnowledgeBase` 现在仅负责编排（组合子 Hook + 初始化 + `refreshAll` + 合并 `busy/error`），**对外接口与拆分前完全一致**，消费者无需修改。

#### Hook 返回结构

返回对象（非数组），字段命名稳定；编排器必须保持向后兼容的扁平返回。

### 4.5 组件设计规范

| 类型 | 行数上限 | 说明 |
|------|----------|------|
| UI 原子组件 (`ui/`) | 100 行 | 纯样式 + 交互，无业务 |
| 业务组件 (`chat/`, `knowledge/`) | **300 行** | 超过必须拆分子组件 |
| Page 组件 | **200 行** | 只做组合，不含逻辑 |
| Hook | **200 行** | 见 4.4 |

**已落地的拆分**：
- `ManagementPage` → `ToggleSwitch` / `SectionTitle` / `RegistryRow` / `CollapsibleSection` / `TunablesSection`
- `DocumentList` → `Checkbox` / `PageButtons` / `DocumentRow` / `BatchToolbar` + `documentListUtils.js`
- `DocumentUploader` 常量 → `chunkPresets.js`
- `ChatPage` → `useSessionList` / `useChatHistory` / `useDocProcessor`（页面仅组合）
- `KnowledgeBasePage` → `SearchResultsPanel` + `BatchPromptDialog`

**拆分触发条件**：文件内定义多个组件、JSX 嵌套 >3 层、组件含 `useEffect`+大量状态、同时处理列表渲染与操作逻辑。

### 4.6 状态与路由

- **路由**：`App.jsx` 包裹 `<BrowserRouter>`，`AppShell` 定义 `/chat/:agentId`、`/dashboard`、`/knowledge`、`/management`、`/audit`；页面用 `React.lazy()` + `Suspense` 按路由拆分。新增智能体只需 `registerAgent()`，自动进入侧边栏与 `/chat/:id`。
- **状态**：不使用全局状态库。页面级状态由 Hook 管理，props 下发。跨页共享的服务端数据（如统计）应复用同一 Hook/`useDocumentStats`，禁止在多个页面各自重复请求。
- **请求缓存（建议引入）**：为幂等 GET 增加轻量 in-flight 去重与 TTL，并为列表/预览/检索/会话加载增加**请求序号或 AbortController**，防止旧响应覆盖新状态。

#### 禁止事项

- 禁止在渲染函数中执行副作用（API 调用、定时器、`console.log`）。
- 禁止用 `useRef` 存会触发重渲染的状态。

### 4.7 错误处理

- **全局兜底**：`ErrorBoundary` 捕获渲染错误，`useGlobalError` 捕获未处理异常。
- **Hook 层**：所有 API 调用 `try/catch`，错误存入 Hook 的 `error` 状态。
- **组件层**：内联提示（`role="alert"`），不使用 `alert()`。
- **禁止 `window.confirm()` / `window.prompt()`**，统一用 shadcn/ui `Dialog`（已提供 `BatchPromptDialog` 范式）。

### 4.8 无障碍（A11y）基线

1. 交互元素可键盘访问（`tabIndex`、Enter/Space）。
2. 图标按钮 / 开关有可读 `aria-label`（如 `aria-label="启用工具 xxx"`）。
3. 表单输入有关联 `<label>` 或 `aria-label`。
4. 动态内容区域有 `aria-live`（聊天消息列表用 `aria-live="polite"`）。
5. Tabs 使用 `role="tablist/tab/tabpanel"` + `aria-selected`（`DocumentPreview` 已改造）。
6. 状态不只靠颜色传达。
7. 弹窗打开焦点移入、关闭焦点返回触发元素；禁止嵌套交互元素（外层 `role=button` 内含 `button`）。

---

## 五、跨端协议规范

- **错误响应统一**：`{ error: { code, message, requestId } }`；生产不透传内部路径/供应商错误。
- **请求追踪**：前端 `request()` 附加 `x-request-id`；后端 `requestTrace` 校验/生成并贯穿日志（`x-request-id` 仅接受 `[A-Za-z0-9._-]{1,128}`）。
- **流式响应**：聊天端点使用 Vercel AI SDK Data Stream Protocol（SSE）；流式响应禁止混入非协议文本；前端流式消费统一在 Hook（`useChatWithAnnotations`）处理，组件只接收 `messages`。
- **新端点必须同步**：更新 OpenAPI/README 接口契约 + 错误码 + 测试。

---

## 六、代码质量门禁（已落地）

### 6.1 命令（根目录 `package.json`）

```bash
npm run check:all     # = build + test:run + lint + format:check + check:server
npm run build         # vite build（含路由代码分割）
npm run test:run      # Vitest
npm run lint          # ESLint
npm run format:check  # Prettier
npm run check:server  # server 测试 + 分层检查
```

### 6.2 后端（`server/package.json`）

```bash
npm --prefix server test          # node --test（Node 内置 runner）
npm --prefix server run check:layers   # 分层检查
```

| 检查项 | 工具 | 状态 |
|--------|------|------|
| 前端 lint | ESLint | ✅ 已配置 |
| 前端格式化 | Prettier | ✅ 已配置 |
| 前端测试 | Vitest | ✅ 已配置 |
| 后端测试 | Node test runner | ✅ 已配置 |
| 后端分层检查 | `check-layers.mjs` | ✅ 纳入 `check:all` |
| 构建验证 | `vite build` | ✅ 纳入 `check:all` |
| CI（GitHub Actions） | `.github/workflows/ci.yml`（Node 22，跑 `check:all`） | ✅ 已配置 |
| 类型检查 | JSDoc（暂不强制 TS） | ⬜ 可选 |

**提交前最低门禁**：`npm run check:all` 必须全绿；后端改动额外确保 `node scripts/check-layers.mjs` 通过。

---

## 七、命名规范

| 类型 | 规则 | 示例 |
|------|------|------|
| React 组件 / 文件 | PascalCase | `DocumentList.jsx` |
| Hook / 文件 | camelCase，`use` 前缀 | `useDocumentList.jsx` |
| 工具/常量/API/注册表 | camelCase | `knowledgeApi.js` `agentRegistry.js` |
| 后端模块 | camelCase | `vectorStore.js` `streamUtils.js` |
| 路由文件 | camelCase | `chat.js` `knowledge.js` |
| 测试文件 | 源文件名 + `.test.js` | `core.test.mjs` `api.test.js` |
| 常量 | UPPER_SNAKE_CASE | `MAX_CHUNK_SIZE` |
| API 路径 | kebab-case | `/api/knowledge/documents` |
| 环境变量 | UPPER_SNAKE_CASE | `ADMIN_TOKEN` `CORS_ORIGINS` |

注释规范：模块头注释必须写明**依赖层**；写"为什么"而非"做了什么"；`TODO(负责人): 描述 — 截止日期`。

---

## 八、测试规范

### 8.1 必测模块

| 模块 | 测试重点 |
|------|----------|
| `chunker.js` | 三层切片正确性、边界（空文件/超长行/混合标题/delimiter/硬上限/上下文） |
| `embed.js` | 熔断器状态转换（closed→open→half-open→closed）、hash 降级 |
| `queryRewriter.js` | LRU 命中/失效、超时降级、并发门控 |
| `vectorStore.js` | 内容哈希去重、缓存一致性 |
| `unifiedSearch.js` | 分数融合权重、多查询合并、过滤后排序 |
| `sessionStore.js` | CRUD、WAL 恢复、迁移、不可用降级 |
| `cache.js` | TTL 过期、LRU 淘汰、字节上限 |
| `agentRegistry` | 注册/注销/别名解析 |
| `mathUtils` / `textUtils` | 余弦边界、JSON 抠取边界 |

### 8.2 规则

- 测试文件放 `server/test/`（后端）与 `tests/`（前端），与源文件镜像。
- 覆盖正常 + 边界 + 错误路径。
- **禁止访问真实外部服务（Milvus、LLM、Embedding）——使用 mock**。集成测试单独用可选 profile。

---

## 九、Git 规范

- 分支：`main` / `feat/xxx` / `fix/xxx` / `refactor/xxx`。
- 提交信息：Conventional Commits（`feat/fix/refactor/docs/test/chore(scope): 描述`）。
- `.gitignore` 必须包含：`node_modules/` `dist/` `.env` `server/data/` `*.timestamp-*` `*.log`；前端 `*.local`。

---

## 十、架构决策记录（ADR）

重大技术决策以 ADR 记录在 `docs/adr/`（格式：状态 / 背景 / 决策 / 后果）：

- `docs/adr/001-auth-security.md` — 配置化认证与 CORS/限流
- `docs/adr/002-agent-plugin-registry.md` — 前后端智能体插件化注册表
- `docs/adr/003-cache-consistency.md` — TTL/LRU 缓存与存储一致性
- `docs/adr/004-chunk-write-durability.md` — 切片写入「写完核实 + 启动对账」的持久化策略
- `docs/adr/005-resume-mock-interview-agents.md` — 简历分析/模拟面试智能体接入与单次 JSON 结构化报告取舍
- `docs/adr/006-model-management.md` — 模型管理系统（多模型路由·运行时热改·三级选择·含 Embedding 重建）〔已实施〕
- `docs/adr/007-conversation-memory.md` — 会话记忆机制（会话内滚动摘要 + 跨会话事实向量库）〔已实施〕
- `docs/adr/008-multi-agent-parallel-and-multiuser.md` — 多智能体并行与多用户（隔离·公平·边界）〔M4 + M5a 已实施 · M5b 待开工〕
- `docs/adr/009-fail-fast-no-silent-degradation.md` — 禁止静默降级 · Fail-Fast 策略（hash 假向量/stub 假回答/假会话全部改为显式报错）〔已实施〕
- `docs/adr/010-hybrid-retrieval-faq-answer.md` — 混合检索（近重复折叠+单文档配额+2-gram 覆盖率加权）与 FAQ 直接应答〔已实施〕

> 三份「暂缓实施」的设计与实施排期总览见 `docs/ROADMAP.md`。

---

## 十一、部署与运行边界

- **运行时**：Node 22（满足 `pdfjs-dist` 等依赖要求）。开发默认前端 `5173`、后端 `127.0.0.1:3000`，Vite `/api` 代理指向 `http://127.0.0.1:3000`。
- **容器**：根 `Dockerfile` 提供 `frontend`（Nginx 静态）与 `backend`（Express）两个 target；后端容器设 `HOST=0.0.0.0`，通过 `MILVUS_ADDRESS` 连接独立 Milvus，应用镜像内不启数据库。
- **Milvus**：`milvus-compose.yml` 仅部署本地依赖，固定版本、etcd 使用容器服务名、凭据走环境变量。
- **本地脚本**：`start-services.ps1` / `stop-services.ps1` 使用项目根 compose，默认只管理本项目服务，不删除数据卷、不关闭 Docker Desktop/WSL。
- **优雅关闭**：SIGTERM/SIGINT 先 flush Milvus 再排空 HTTP（见 ADR-004）；SQLite WAL checkpoint 在退出钩子处理。

---

## 附录 A：已知技术债与后续计划

已完成的重构项（API 统一、Hook 拆分、组件拆分、共享工具去重、LLM provider 单例、Embedding 半开熔断、CORS/认证/限流/requestId、Dashboard 去重复请求、MessageList 滚动节流、预览缓存 TTL/LRU、会话 `__ephemeral__` 隔离、SQLite 降级、**请求竞态防护、注解 LRU 上限、chat body 校验收口、会话 agentName 绑定、GitHub Actions CI、原生对话框清零、上传统一 request()、大文件拆分（Uploader/DocPreviewDialog/DocumentPreview）、vendor manualChunks**）已从本清单移除。

**仍待处理：**

| # | 债务 | 影响 | 优先级 | 位置 |
|---|------|------|--------|------|
| 1 | ~~HTTP server 优雅关闭~~（**已做**：SIGTERM/SIGINT 先 flush 再排空，见 ADR-004） | — | ✅ | `server/index.js` |
| 2 | Milvus 写非同一事务（**已缓解**：写完 flush+强一致核实才置 indexed、空切片拒入、启动/health 孤儿对账、reindex 自愈；残留"核实前被杀→保持 pending"由对账兜底，见 ADR-004） | 数据一致性 | P2→低 | `lib/vectorStore.js` `lib/milvusStore.js` |
| 3 | mock-interview 开场带"抱歉无法理解"前缀（**已缓解**：prompt 加固后能稳定出题；前缀为 qwen2.5-coder 小模型顽固先验，换更强模型可消除） | 观感 | P3 | `server/lib/llm.js` |
| 4 | `useUploadForm` 351 行，略超 Hook ≤200 规范（内聚的上传管线，filesRef/strategyKey 贯穿全流程，再拆会碎片化） | 规范偏离（有意豁免） | P3 | `src/hooks/useUploadForm.jsx` |
| 5 | eslint 剩余 ~31 条真实 unused-vars warning（不阻断门禁，可择机清理） | 代码卫生 | P3 | `src/` |

---

## 附录 B：快速参考

### 新增一个后端模块

1. 确定层级（第二节表格）；2. `lib/` 下创建并遵循 3.1；3. 在 `check-layers.mjs` 的 `LAYERS` 登记；4. `node scripts/check-layers.mjs` 验证；5. 在 `server/test/` 补单元测试。

### 新增一个后端智能体

1. 在 `lib/agents/builtin/` 建 L4 handler（仅引用 L0–L3）；2. `agentRegistry.registerAgent({ id, name, aliases, handler })`；3. 若 handler 需 L5+ 依赖，改为在 `routes/chat.js` 内联注册并经 `ctx` 注入。

### 新增一个前端页面

1. `pages/` 下建组件（≤200 行）；2. `hooks/` 下建 Hook（≤200 行，用 `request()`，禁止裸 `fetch`）；3. `AppShell.jsx` 用 `React.lazy()` 注册路由；4. 补 ARIA 标注。

### 新增一个前端智能体

1. 在 `lib/agentDefinitions.js` 调 `registerAgent({ id, name, icon, available, structuredInput })`；2. 无需改 `Sidebar` / `AppShell` / `constants.js`。

### 新增一个 API 端点

1. 在 `routes/` 加路由；2. `try/catch` + `next(err)`；3. 入参校验；4. 挂限流/认证（按需）；5. 同步 README/OpenAPI + 测试。

### 提交前

```bash
npm run check:all
cd server && npm run check:layers
```
