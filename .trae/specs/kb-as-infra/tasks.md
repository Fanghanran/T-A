# 实现任务清单（Tasks）

> 规格：`.trae/specs/kb-as-infra/spec.md`
> 
> 依赖顺序：T1（后端基础 API）→ T2（前端导航/页面骨架）→ T3（手动录入组件）→ T4（面试检索分支统一迁移）→ T5（联调与回归验证）
>
> 高优先级项必须在前；中/低可穿插。所有任务的 TR（测试要求）类型只能是 `rule` 或 `rubric`，与 spec 中 AC 对应。

---

## Task 1: 后端基础 API —— 手动录入 + 统一检索封装（AC-R4 / R5 / R6 / R8 / NFR-4）

**Priority:** high
**Status:** pending
**Dependencies:** 无
**Files:** 新增 `server/lib/unifiedSearch.js`；修改 `server/index.js`

### 内容
1.1 新增 `server/lib/unifiedSearch.js` 导出 `unifiedSearch({ q, scope, techStack, category, tag, topK, difficulty, company })`：
   - 顶层 try/catch 隔离：questionBank 失败不影响 knowledge，反之亦然；返回 `{ questionResults: {total,searchMs,items}|null , knowledgeResults: {total,searchMs,items}|null }`
   - scope 分派：'question' → 只跑 QB；'knowledge' → 只跑 KB；'all' → 两边并发 `Promise.allSettled`
   - 分类/标签参数两边一致传透（category 给 `store.search({category})` 也给 `questionBank.search({category})`，tag 同理）
   - topK 钳制到 [1,20]，默认 5

1.2 新增 `POST /api/search/query` 路由：
   - 调 unifiedSearch，顶层返回 `{ searchMs, scope, topK, questionResults, knowledgeResults }`
   - searchMs 用 `performance.now()` 自己计时

1.3 新增 `POST /api/knowledge/documents/manual` 路由：
   - 输入校验：title（1~200）、content（10~500000 字符，按 length 宽松限制不精确按字节）、tags 长度 0..10
   - 复用上传流程：createDocument({title, category, tags, size:Buffer.byteLength(content,'utf8'), content, source: req.body.source ?? 'manual'}) → splitIntoChunks(content) → embedTexts(chunks.texts) → await store.addChunks(doc.id, chunkList, vectors, {category,tags})
   - 响应 201：doc 对象（与上传 endpoint 返回完全同形状）

1.4 在 `GET /` 根描述里加上新 endpoints（/api/search/query、/api/knowledge/documents/manual）。

### 测试要求（TR）

| ID | 类型 | 通过条件 | 证据来源 |
|---|---|---|---|
| T1-R1 | rule | `node --check server/index.js && node --check server/lib/unifiedSearch.js` 退出 0 | Shell stdout |
| T1-R2 | rule | `curl -X POST /api/search/query -H 'content-type: application/json' -d '{"q":"React memo","scope":"all"}'` 返回体顶层 5 个字段齐全；questionResults 和 knowledgeResults 都是 `{total,searchMs,items}` 形状对象（非 null） | curl 响应 JSON + jq 断言 |
| T1-R3 | rule | scope='question' → knowledgeResults===null；scope='knowledge' → questionResults===null | curl JSON 断言 |
| T1-R4 | rule | `curl -X POST /api/knowledge/documents/manual -H 'content-type: application/json' -d '{"title":"","content":"xx"}'` → 400；`{"content":""}` → 400；`{title,content,tags:[1,2,3,4,5,6,7,8,9,10,11]}` → 400（tags 超限） | curl HTTP code |
| T1-R5 | rule | 手动录入成功（201）后，紧接着 `GET /api/knowledge/documents` items 里包含该 doc 的 id 且 source==='manual'；`POST /api/knowledge/search {query: title}` top1 就是该 doc 的 chunk 且 score≥0.8（hash embed 下相同种子匹配度高） | 连续两个 curl 结果断言 |
| T1-R6 | rule | unifiedSearch 内部（函数级）注入一个 Vectra 错误（临时把 store.search 替换为 throw），对 `scope='all'` 的调用返回的 questionResults.items 仍为正常数组长度，knowledgeResults 只是空数组 —— 函数不 throw | Node 脚本（临时 polyfill 覆盖 store.search 后调用 unifiedSearch） |
| T1-Q1 | rubric | 复用率评分（阈值 ≥ 7/10）：<br>10 分=index.js /api/chat 面试分支零行手写 embed + questionBank.search + store.search，全部替换成调用 unifiedSearch；<br>6 分=面试分支只调用 unifiedSearch 但注解另手写；<br>3 分=面试分支还是手写两套检索代码。 | index.js 代码审查（此 TR 要到 T4 才生效，但在本 Task 里先预留 unifiedSearch 形状以供后续调用） |

---

## Task 2: 前端导航 / 页面骨架改造（AC-R1 / R2 / R3 / R9 / R10 / AC-Q1 / Q5）

**Priority:** high
**Status:** pending
**Dependencies:** T1（上传/列表接口不变，无需等 T1 完成；但 T1 先过了语法检查更稳）  
**Files:** 修改 `src/lib/constants.js`、`src/components/layout/Sidebar.jsx`、`src/components/layout/AppShell.jsx`、`src/pages/KnowledgeBasePage.jsx`

### 内容
2.1 从 `AGENTS` 数组里**删除** `{ id:'knowledge-base', ... }` 那一项；`KNOWLEDGE_AGENT_ID` 常量保留。
2.2 `Sidebar.jsx` 改为两块导航：
   - 顶部 Section 标题「智能体」→ 渲染 `AGENTS.map(agent) <button>`（原代码）
   - 底部 Section 标题「管理」→ 新增单一按钮项「知识库」（BookOpen 图标），高亮条件由父组件传 `activeView==='knowledge'`（不是 active 的 agent），点击回调改为父组件传的 `onNavigateKnowledge()`（不是 onSelectAgent）
   - 两个 Section 之间用 Separator + 留白（视觉上明显分隔）
2.3 `AppShell.jsx` 改成：
   - 新增显式状态 `view: 'chat' | 'knowledge'`（默认 'chat'）
   - `handleSelectAgent(agent)` 同时置 `view='chat'`
   - 新增 `handleNavigateKnowledge()` → `view='knowledge'`，**不修改 currentAgent**（currentAgent 保持上一个聊天智能体不变）
   - 主区域渲染：`view==='knowledge'` 渲染 KnowledgeBasePage；否则渲染 ChatPage（按 currentAgent）
   - Header 的 agent 名：view==='knowledge' 时构造一个"虚拟 agent 描述" `{name:'知识库管理', icon:BookOpen, description:'全局知识管理中心'}` 传给 Header，Header 不用改
2.4 `KnowledgeBasePage.jsx` 纯管理改造：
   - 删除 `useChatWithAnnotations` import + 调用；删除 `MessageList`、`ChatInput` import；删除相关状态
   - 删除顶部 TabButton（智能问答 / 文档管理）切换；直接渲染"文档管理"视图
   - 在顶部工具栏（搜索框 + 检索按钮 + DocumentUploader）**最末尾加一个"新建知识"按钮**，点击 `setManualDialogOpen(true)`；此时只是按钮 + 空的 state，**真正弹窗组件放在 Task 3**。
   - 保留其余所有代码：左栏过滤+文档列表、右栏检索结果/文档详情预览。
   - `onLoadingChange` 只上报 `kb.busy`（不再 + chatLoading）

### 测试要求

| ID | 类型 | 通过条件 | 证据来源 |
|---|---|---|---|
| T2-R1 | rule | `AGENTS` 数组内 `id==='knowledge-base'` 项不存在 | Grep 结果：`AGENTS` 对象内无该 id |
| T2-R2 | rule | KnowledgeBasePage 源码无 `useChatWithAnnotations`、`MessageList`、`ChatInput`；无 Tab "智能问答" 相关 JSX | Grep 3 个关键词 + 人工读源码 diff |
| T2-R3 | rule | 前端构建（`npm run build` 或 `vite dev` 加载）无 React warning；启动后点击 Sidebar「管理 / 知识库」，React DevTools 里 currentAgent 仍然是 `interview-retrieval`（上一个选中的智能体），不会被替换为 knowledge-base | 运行时状态检查 |
| T2-R4 | rule | `view==='knowledge'` 时 Header 标题显示「知识库管理」（不是 agent 名），管理页内容完整（上传按钮、新建按钮、搜索、过滤、列表）；切回面试题检索时内容正常切换。 | 肉眼 |
| T2-Q1 | rubric | AC-Q1 职责边界清晰度（阈值 ≥ 7）：看 Sidebar 分区标题、视觉分隔、Header 标题是否合理、view 与 currentAgent 正交程度 | 代码审查 + UI 截图 |
| T2-Q2 | rubric | AC-Q5 代码改动最小化（阈值 ≥ 8）：ChatPage / SearchProcessPanel / useChatWithAnnotations / StreamingMessage 源码 0 diff | Git 概念性 diff 检查 |

---

## Task 3: 手动录入弹窗组件 + API 客户端接入（AC-R4 / R5 / R10 / AC-Q3 / Q4）

**Priority:** medium
**Status:** pending
**Dependencies:** T1（后端 manual 接口存在）、T2（管理页工具栏已空 state）
**Files:** 新增 `src/components/knowledge/ManualEntryDialog.jsx`；修改 `src/lib/knowledgeApi.js`、`src/hooks/useKnowledgeBase.jsx`、`src/pages/KnowledgeBasePage.jsx`

### 内容
3.1 `knowledgeApi.js` 新增 `createManualEntry({title, content, category, tags, source})`：`POST /documents/manual`（application/json，经 `postJson`）。

3.2 新增 `ManualEntryDialog.jsx` 组件：
   - Props：`{ open, onOpenChange, existingCategories, existingTags, onSubmit, submitting }`
   - 表单字段：
     - `title`：`Input` 必填 1–200
     - `category`：Combobox 样式——`Input` + 下方 chips（chips 从 existingCategories 来，点击 chip 填入 input；也允许用户手输新分类）
     - `tags`：chip 输入——已有 tags 显示为可选 chips，支持多选；用户另可手输（回车新增 chip，最多 10 项）
     - `content`：`<textarea>`（多行，因为项目 UI 目录里没有 Textarea shadcn 组件，直接用原生 `<textarea>` 加 Tailwind 样式 `className="flex min-h-[220px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"` 即可，和 Input 风格一致）
   - 前端非空校验（表单提交前拦截 title/content 空 + toast/inline 错误提示），后端再校验作为双保险
   - `onSubmit` 回调：`(values) => Promise<boolean>` — 父组件调用 KB hook 后，成功关闭弹窗。

3.3 `useKnowledgeBase.jsx` 新增方法：
   - `createManual(values)`：调 knowledgeApi.createManualEntry，成功后 `refresh() + loadFacets()`，返回 true/false
   - 暴露 `createManual` 和 `submitting`（= 上传 + 录入合并为 `busy = loading || searching || uploading || previewLoading || creating`）

3.4 `KnowledgeBasePage.jsx` 里把空 state 的 `manualDialogOpen` 和 `ManualEntryDialog` 真正接上：
   - `open={manualDialogOpen} onOpenChange={setManualDialogOpen}`
   - `existingCategories={kb.categories.map(c=>c.name)} existingTags={kb.tags.map(t=>t.name)}`
   - `onSubmit={kb.createManual}`
   - `submitting={kb.creating}`（或 busy，只要按钮 loading 有反馈）

### 测试要求

| ID | 类型 | 通过条件 | 证据来源 |
|---|---|---|---|
| T3-R1 | rule | `node --check` 全通过；前端 `vite` 构建不报错 | Shell stdout |
| T3-R2 | rule | 管理页点「新建知识」按钮 → 弹窗打开；留空 title 提交：前端拦截（弹窗不关，无请求发出）；填好 title + content，category 选已有分类 → 提交 → 弹窗关 → 文档列表新增 1 条 → 分类计数面板的该分类 count +1 | UI 手动操作 3 步 |
| T3-R3 | rule | 录入 category="全新分类"（此前不存在），提交成功后 listCategories 结果新增 `{name:'全新分类', count:1}` | 调用 `GET /categories` 断言 |
| T3-R4 | rule | 录入 tags 为 11 项时，前端表单禁止提交（按钮禁用，或提交时前端拦截并提示 "最多 10 个标签"） | UI 操作 |
| T3-Q1 | rubric | AC-Q3 使用体验（阈值 ≥ 7）：表单字段是否清楚、分类/标签建议是否联动已有项、错误是否内联显示、成功是否 toast + 自动刷新 | 手动操作记录 |
| T3-Q2 | rubric | AC-Q4 分类/标签字段一致性（阈值 ≥ 8）：写入文档对象的 `category` 字符串与 listDocuments 的 `?category=xxx` 查询、listCategories 返回值三者都是同一个值 | 写入 curl → listCategories curl → 过滤 curl 三者字符串相等断言 |

---

## Task 4: 面试检索迁移到统一检索 + 降级隔离验证（AC-R7 / R8 / AC-Q2）

**Priority:** high
**Status:** pending
**Dependencies:** T1（unifiedSearch 存在）、T2/T3 不直接影响本任务（可并行）
**Files:** 修改 `server/index.js` /api/chat interview-retrieval 分支

### 内容
4.1 `/api/chat` `agentName==='interview-retrieval'` 分支整体替换：
   - 删除原手写的 `questionBank.search` 与 条件 embed + store.search 代码
   - 直接 `const u = await unifiedSearch({ q, scope: 'all', techStack, topK: LIMIT, category: undefined, tag: undefined, difficulty, company: undefined })`
   - `results = u.questionResults?.items ?? []`；`searchMs = u.questionResults?.searchMs ?? 0`
   - `ragChunks = u.knowledgeResults?.items ?? []`；`ragSearchMs = u.knowledgeResults?.searchMs ?? 0`
   - console.log 保持原有风格（按题目/知识库分别打印命中条数/分数），但从 u 内字段取值
   - `streamInterviewAnswer` 调用签名不变

4.2 确保降级隔离：当 unifiedSearch 返回的 knowledgeResults.items（因为 Vectra 报错）是空数组时，streamInterviewAnswer 仍然只拿到 questionResults 并正常流式返回——整次 `/api/chat` 请求状态 200，不是 500。

4.3 （可选但推荐）把 `results`、`ragChunks` 拼成 annotation 的 `2:` 行的具体 JSON 结构，与原格式完全一致：每条 annotation 顶层 `engine` 分别是 `interview` / `knowledge`、其它字段沿用以前。在 unifiedSearch 里**不要**生成 annotation（纯返回数据），annotation 拼装留在 llm.js / streamInterviewAnswer 中的 prependAnnotation 里，保持职责分离。

### 测试要求

| ID | 类型 | 通过条件 | 证据来源 |
|---|---|---|---|
| T4-R1 | rule | `Grep -nE "questionBank\.search\(|store\.search\(|embedTexts\(" server/index.js` 不匹配任何行在 /api/chat 分支内部（它们只能出现在 /api/knowledge/search、/api/knowledge/ask、/api/search/query 路由及 unifiedSearch.js 中） | Grep 输出 |
| T4-R2 | rule | 启动后端（正常环境），前端提交面试题检索 "React memo" → 响应是 200 SSE，流里至少一条 `2:` 开头 annotation 行（可用 `curl -N` 抓取流前 N 行断言），且前端面板正常显示 Recall 卡片 | curl SSE + 前端肉眼 |
| T4-R3 | rule | 注入错误：在 unifiedSearch 里临时 `if (scope.includes('knowledge')) throw new Error('boom')`，前端发起"React memo"查询 → 仍返回 SSE 200，SearchProcessPanel 只有 interview 引擎区块，没有 knowledge 区块；整次请求不是 500 | 注入场景验证 |
| T4-Q1 | rubric | AC-Q2 统一检索复用率（阈值 ≥ 8/10）：unifiedSearch 被 /api/search/query 和 /api/chat 共同调用，不出现两套检索实现 | 代码审查 |

---

## Task 5: 端到端回归验证 + 文件清理 + 文档接口核对

**Priority:** medium
**Status:** pending
**Dependencies:** T1 + T2 + T3 + T4 全 done
**Files:** 无新增；删除残留临时自测脚本（若存在）

### 内容
5.1 完整后端启动验证：`node server/index.js` → `/api/health` 正常 → 三个新接口 `/search/query`、`/knowledge/documents/manual` 均可访问 → 旧接口 `/knowledge/documents`、`/categories`、`/tags`、`/search` 返回结构未变化（响应 JSON key 名一致）。

5.2 手动 E2E：
   - 启动前后端，Sidebar 管理区点「知识库」进入管理页
   - 「新建知识」：录入 title = "React memo 防重渲染" / content = "## memo 用法\nReact.memo 浅比较 props 相等时跳过子渲染..." / category = "React" / tags = ["性能优化","memo"] → 提交 → 列表出现 → 语义搜 "React memo 原理是什么" → top1 就是该文档 chunk，score≥0.8
   - 删除该文档 → 列表消失 → 重新搜索返回 0 条
   - 上传一个 md 文件 → 列表出现 + 向量库入库正常
   - 回到面试题检索，查询 "React memo" → 结构化不足 5 条时能看到知识库引擎的 Recall 卡片

5.3 确认项目中没有遗留的临时自测脚本（`__check_vectorstore.mjs` 等），若存在删除。

5.4 `node --check` 全项目所有修改过的 JS/MJS 文件；前端 `npm run build` 或至少 `npx vite build` 一次保证零语法错误 + 零 import 解析错误。

### 测试要求

| ID | 类型 | 通过条件 | 证据来源 |
|---|---|---|---|
| T5-R1 | rule | 3 个旧 REST：`GET /documents`, `GET /categories`, `POST /knowledge/search` 返回 JSON 顶层 key 与改造前一致（对比旧代码注释/已知契约） | curl 响应与契约对比 |
| T5-R2 | rule | 5.2 E2E 6 步每步均通过；尤其"语义搜索 top1 命中新录入"、"删除后搜不到"两步 100% 可重复 | 手动操作记录 |
| T5-R3 | rule | Vite build / Typecheck / Lint：0 error，无 React warning | Shell stdout |
| T5-Q1 | rubric | 整体流程顺滑度（阈值 ≥ 7）：导航切换、录入、上传、检索、删除、面试兜底均无卡顿/报错，视觉无明显退化 | 整体体验评估 |
| T5-Q2 | rubric | 代码质量（阈值 ≥ 7）：各模块职责清晰、命名一致、注释合理、统一检索封装干净不泄漏内部实现、未出现"补丁式兼容命名"（categoryId/category 混用等） | 代码审查 |
