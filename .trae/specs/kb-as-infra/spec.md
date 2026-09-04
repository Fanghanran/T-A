# 知识库「升级为全局基础设施」规格说明书

## 1. Problem / 背景

当前项目把 **知识库** 作为一个**独立的聊天智能体**（Sidebar 里与「面试题检索」并列，id=`knowledge-base`），通过 `POST /api/chat agentName=knowledge-base` 走独立的 RAG 对话。但用户的定位是：

> 知识库不是一个单独的智能会话；它是**给所有功能提供知识支撑的基础设施**，只要包含知识管理（文档 + 分类 + 标签 + 录入）即可，不应该作为一等公民智能体出现。

定位不一致带来的具体问题：

1. 前端 Sidebar 导航把「知识库」和「面试题检索」平级，用户会认为「知识库是一种聊天方式」
2. KnowledgeBasePage 左文档管理 + 右 RAG 聊天，页面"又当管理员又当聊天用户"，职责不清
3. 面试题检索「先查结构化题库、不够再查知识库」的兜底逻辑写在 `index.js /api/chat` 硬编码里；未来加新功能（简历问答、面经总结等）都要复制这段"先 A 后 B"的组合代码，知识库无法作为统一的检索层被复用
4. 零散的面经 / 面试补充知识只能写成 md 文件再上传，缺少"直接填个表单录入一条"的轻量入口
5. 分类/标签完全依赖文档上的字符串字段，从管理视角虽然够用但缺少明确的"前后端字段一致性约束"

## 2. Users & Goals

| 角色                          | 目标                                                                  |
| --------------------------- | ------------------------------------------------------------------- |
| **知识管理员**（用户主用）             | 上传 md/txt，手动录入零散知识；按分类/标签筛选；看列表/详情/删除；看到「上传后我有 N 篇、X 类、Y 标签」的统计     |
| **功能开发**（写新功能的调用方 / 未来自己维护） | 调一个"统一知识检索 API"就能拿到「结构化题目结果 + 知识库切片结果」，不用自己写 embed + 查 vectra + 拼注解 |
| **终端用户**（使用面试题检索等功能的人）      | 当结构化题库命中不足时，能继续看到知识库的 Recall 卡片，回答不空洞；**但终端用户不会直接点进一个"知识库聊天"入口**    |

## 3. Goals（本次必须达成）

* **G-A1 导航定位纠正**：知识库从 Sidebar「智能体列表」移除，改为**独立的一级管理入口**（Header 顶栏或 Sidebar 顶部"管理区域"），AppShell 不再以 `isKnowledge === (currentAgent.id === 'knowledge-base')` 为条件切换页面。

* **G-A2 纯管理页（A1）**：`KnowledgeBasePage` 不再包含任何聊天相关组件/状态（`useChatWithAnnotations`、`MessageList`、`ChatInput`、Tab "智能问答"、`chatLoading` 全部移除）。页面 = 文档上传 + 手动录入 + 分类/标签过滤 + 文档列表 + 详情预览 + 语义检索结果面板。

* **G-B1 扁平分类（B1）**：保留现状扁平字符串 `category`、字符串数组 `tags`，不引入独立分类库/树形分类；但**写链路和读链路统一只认** **`category`** **字符串名**，不用 `categoryId` 等第二套命名。

* **G-C1 手动录入单条知识（C2）**：新增"新建知识"交互与后端接口，提交标题 + markdown 正文 + 分类 + 标签后，流程与上传文件完全一致（sliceIntoChunks → embedTexts → vectorStore.createDocument / addChunks）。

* **G-D1 统一知识检索 API（D2）**：新增 `POST /api/search/query`，以 `scope` 控制检索哪些数据源，所有功能统一调用这个接口。`/api/chat` 中的面试题检索分支、未来新功能都走这个接口，不再各自手写"embed + 查 vectorStore + 调 questionBank.search + 拼注解"的组合代码。

* **G-D2 注解格式保持不变**：统一检索内部负责把 questionResults / knowledgeResults 拼成现有的 annotations 格式（`2:` 开头的 JSON 行，engine 字段区分 `interview`/`knowledge`），保证前端 `SearchProcessPanel`、`useChatWithAnnotations` **零改动**即可正常渲染。

* **G-O1 向后兼容**：保留 `GET /api/knowledge/categories`、`listDocuments`、`deleteDocument`、`vectorStore.search` 等现有 REST 签名；`/api/knowledge/search`（纯检索返回片段）继续可用（供管理页的"语义检索预览"用）。

## 4. Non-Goals（本次明确不做）

* ❌ 不引入真实 LLM 与真实 embedding 模型；继续使用 `hash`/`stub` 模式，验证数据通路即可。

* ❌ 不升级为独立的分类 CRUD/标签 CRUD；保留"文档上的扁平字符串字段"。

* ❌ 不做树形分类、标签颜色/合并、分类权限。

* ❌ 不删除 `/api/chat agentName=knowledge-base` 和 `/api/knowledge/ask` 这两个 RAG 流式端点（代码保留、前端不再有入口；未来要加"调试用 RAG 测试面板"时能直接复用）；但 Sidebar/Agent 列表里的 `knowledge-base` 必须置为不可选 `available:false` **并从 UI 中隐藏**（或干脆从 AGENTS 数组移除）。

* ❌ 不做批量导入（CSV/JSON）。

* ❌ 不做 Rerank / 交叉打分 / 权重配置；统一检索内部按 scope 简单拼接。

## 5. 功能需求（Functional Requirements）

### FR-A. 前端导航与页面结构

* **FR-A1 Sidebar 结构改造**：Sidebar 分成上下两个独立区域

  * 上方「主功能」：只放聊天类智能体（目前只有面试题检索 available:true；简历分析/模拟面试 available:false 保留）。

  * 下方「管理」：单独一个"知识库"入口，和上方的 agent 列表在视觉上明显分隔（加 Section 标题「管理」、用不同的图标/颜色）。点击该入口 → 切换到 KnowledgeBasePage，**不改变** **`currentAgent`** **状态**。

* **FR-A2 AppShell 双形态路由**：AppShell 维护一个显式状态 `view: 'chat' | 'knowledge'`，而不是靠 `currentAgent.id === 'knowledge-base'` 推断。当 view='chat'，主区域按 `currentAgent` 渲染 ChatPage；当 view='knowledge'，直接渲染 KnowledgeBasePage，且 Header 标题改为"知识库管理"。

* **FR-A3 AGENTS 列表清理**：从 `AGENTS` 常量里移除 id='knowledge-base' 那一项；`KNOWLEDGE_AGENT_ID` 常量可以保留（给 `runtimeAnnotations` map 的 chatId 用），但不再作为导航项的依据。

* **FR-A4 KnowledgeBasePage 改造（纯管理）**：

  * 删除顶部的 `TabButton`（智能问答 / 文档管理这组切换），整页直接是"管理主视图"。

  * 删除 `useChatWithAnnotations`、`MessageList`、`ChatInput`、`chatLoading`、`chatError` 相关的所有代码与 import。

  * 保留工具栏（语义检索输入框 + 检索按钮 + 上传按钮），并**新增一个"新建知识"按钮**打开手动录入弹窗。

  * 保留左栏（分类/标签过滤 + 文档列表）与右栏（检索结果 or 文档详情预览）的双栏布局。

### FR-B. 扁平分类与字段一致约束

* **FR-B1 字段唯一命名**：所有写链路（上传、手动录入）只接受 `category: string`（无 categoryId），所有读链路（列表、分类聚合、listCategories）也只基于文档对象的 `category` 字符串名。

* **FR-B2 非空不强求**：category 允许为空（归到"未分类"统计项，前端显示为"未分类"徽章/选项）。

* **FR-B3 列表过滤一致**：`GET /api/knowledge/documents?category=前端` 的查询参数 `category` 与文档对象的 `category` 字段做**严格相等**匹配（不做前缀/模糊），与 listCategories 中返回的 `name` 完全一致。

### FR-C. 手动录入单条知识

* **FR-C1 后端录入接口**：`POST /api/knowledge/documents/manual`，JSON body:

  ```ts
  {
    title: string                 // 必填，长度 1~200
    content: string               // 必填，markdown 字符串，长度 10~500,000
    category?: string             // 选填，默认 ''
    tags?: string[]               // 选填，默认 []，每项长度 ≤ 20，最多 10 项
    source?: string               // 选填，默认 'manual'；若填写则覆盖（前端可传 "面经"、"内部文档"等）
  }
  ```

  处理流程 = `createDocument({title, category, tags, size:byteLength(content), content, source: body.source ?? 'manual'})` → `splitIntoChunks(content)` → `embedTexts(...)` → `store.addChunks(doc.id, chunkList, vectors, {category, tags})`。响应同上传接口：`201 {doc object}`。

* **FR-C2 校验**：title/content 缺失返回 `400 { message: "缺少 xxx" }`；tags 超 10 项返回 400。

* **FR-C3 前端录入弹窗组件**（新增 `components/knowledge/ManualEntryDialog.jsx`）：

  * 用 shadcn `Dialog` + `Input` + `Textarea`（若项目尚无 Textarea，用现有的 UI Input 扩展一个 textarea 样式组件，或直接写样式化 `<textarea>`）+ 分类/标签输入（复用 `CategoryTagFilter` 的选项作为 autocomplete 建议；category 下拉选已有分类或"新增"自定义输入；tags 多选 chip）。

  * 提交成功后，管理页自动 `refresh() + loadFacets()` 刷新列表与分类/标签计数，并清空弹窗内容关闭。

### FR-D. 统一知识检索 API

* **FR-D1 新端点**：`POST /api/search/query`，JSON body：

  ```ts
  {
    q: string                                // 必填，自然语言查询
    scope: 'question' | 'knowledge' | 'all'  // 默认 'all'
    techStack?: string[]                     // 面试题用，默认 []
    category?: string                        // 可选：两边都按 category 过滤
    tag?: string                             // 可选：标签过滤
    topK?: number                            // 可选：每个数据源独立 topK，默认 5，合法范围 1..20
    difficulty?: string                      // 仅面试题有效
    company?: string                         // 仅面试题有效
  }
  ```

  响应（JSON，非流式，因为是纯检索）：

  ```ts
  {
    searchMs: number,
    scope: string,
    topK: number,
    questionResults: {
      total: number,
      searchMs: number,
      items: Array<questionBank.search item shape>   // 每个 item 含 rank/score/category/title/answer 等
    } | null,          // scope='knowledge' 时为 null
    knowledgeResults: {
      total: number,
      searchMs: number,
      items: Array<vectorStore.search return shape>  // 每个 item 含 {id,docId,title,snippet,score∈[0,1],category,tags,heading}
    } | null,          // scope='question' 时为 null
  }
  ```

* **FR-D2 内部实现约束**：

  * 复用 `questionBank.search()` 与 `embedTexts([q]) → store.search()`，不重写任何检索内部逻辑。

  * `category` 参数：**同时**传给 questionBank（`{ category }`）与 store（`{ category }`）；`tag` 参数同理。保证两边过滤口径一致，方便未来"按分类统一检索"。

  * 任一检索失败（throw）→ 该数据源的 `items: [] + searchMs: 0`，**不影响另一个数据源**（隔离降级），顶层 `searchMs` 正常返回。

* **FR-D3 面试题检索 /api/chat 分支改调统一 API**：

  * 原 `questionBank.search + 不足时 embed + store.search + 各自 console.log` 全部替换为一次 `POST /api/search/query { q, scope: 'all', techStack, topK: LIMIT }`。

  * `results` 取 `body.questionResults.items`，`ragChunks` 取 `body.knowledgeResults.items`，其余的 `searchMs/ragSearchMs` 按 body 里对应字段填。

  * **注解与 LLM 调用保持不变**：继续把 `results` 和 `ragChunks` 通过 `prependAnnotation` 写到两条 `2:` 行，engine 分别是 `interview` / `knowledge` → 前端 SearchProcessPanel 零改动。

  * （可选实现方式：因为是同进程，不必真的走 HTTP fetch；可以把"统一检索"抽成一个后端函数 `lib/unifiedSearch.js unifiedSearch({q,scope,...})` 同时供 `/api/search/query` 路由和 `/api/chat` 分支调用，减少本机 HTTP 开销。优先推荐这个实现。）

### FR-E. 保留 & 清理旧「知识库智能体」代码

* **FR-E1 保留但不导航**：`/api/chat agentName=knowledge-base` 分支代码不动（避免破坏你以后可能想直接调它的 REST 客户端），但 `AGENTS` 数组里已经移除 `knowledge-base` 项，所以前端不会有入口。

* **FR-E2 KNOWLEDGE\_AGENT\_ID 常量保留**：不移除（它还在 `runtimeAnnotations` 的 chatId 生成里间接使用），仅不再是导航项。

* **FR-E3 /api/knowledge/ask 保留**：供管理页"调试/快速问答"可能的未来扩展使用，本次先不启用对应的 UI。

## 6. 非功能需求（Non-Functional Requirements）

* **NFR-1 性能**：统一检索接口 `scope=all` 时总耗时 P95 ≤ 结构化检索 + 知识库检索各自独立耗时之和 + 20ms（即不引入明显的额外开销）。

* **NFR-2 健壮性**：知识库检索出错（Vectra 抛错）时，面试题检索的用户仍然能看到结构化结果；反之亦然。不允许一个数据源的异常导致整次回答 500。

* **NFR-3 类型一致性**：手动录入返回的 doc 对象字段（id/title/category/tags/size/content/source/uploadedAt）与上传文档一致，前端 `useKnowledgeBase` 接收到的 doc 对象形状唯一。

* **NFR-4 可维护性**：`/api/search/query` 的实现抽成独立的 `lib/unifiedSearch.js` 函数模块，路由层 `/api/search/query` 与 `/api/chat interview-retrieval` 分支都 import 同一个函数使用，不允许复制粘贴 questionBank.search 与 vectorStore.search 的组合代码。

* **NFR-5 启动一致性**：新增录入接口、统一检索接口、与旧接口同样在 `store.whenLoaded()` 之后才能正常返回；路由 handler 均为 async 并包 try/catch，异常交给统一错误中间件返回 500 JSON。

* **NFR-6 无破坏性改动**：旧的 `/api/knowledge/documents/:id`、`/categories`、`/tags`、`/search`、`/delete` 响应结构不变；前端 `knowledgeApi.js` 旧方法零修改即可继续工作。

## 7. 假设与约束 / 依赖

* **依赖**：`splitIntoChunks()`、`embedTexts()`、`store.createDocument/addChunks/search/deleteDocument/flushSync`、`questionBank.search/listQuestions/stats`、`streamInterviewAnswer/prependAnnotation` 这些现有模块的 API 不变。

* **约束 1**：前端 UI 组件库现状不变（Tailwind + shadcn/ui 风格，现有的 Button/Dialog/Input/Badge/Card 可复用）；不新增任何第三方 npm 依赖（dialog/shadcn 里已可用）。

* **约束 2**：不引入前端路由库（react-router 等），沿用 AppShell 内部状态切换 view 的现有方案。

* **约束 3**：向量库仍是 Vectra（纯 JS HNSW，vectra-index 文件夹持久化），本次不改动 `vectorStore.js` 的 addChunks/search/deleteDocument 方法签名与实现（它们的测试已经跑通）。

* **约束 4**：分类是扁平字符串，category/tag 的搜索结果里的过滤仍走现有的 `store.search({category, tag})` 参数与 `questionBank.search({category, tag})` 参数——不扩展复杂的过滤语法。

## 8. 开放问题（已解决 / 确认对齐）

* ✅ 已确认：页面形态 = A1（纯管理页）

* ✅ 已确认：分类方案 = B1（扁平字符串，独立分类库以后升）

* ✅ 已确认：录入方式 = C2（补手动录入单条知识）

* ✅ 已确认：检索 API = D2（统一 `/api/search/query`）

* ✅ 已确认：`/api/chat knowledge-base` 代码保留，但前端导航移除

* ⚠️ 预留：统一检索返回 `questionResults` 的 "item shape" 目前就是 questionBank.search 的返回（含 `rank`、`score`、`category`、`title`、`answer` 等），与前端 SearchProcessPanel 的 QuestionSlice 渲染是一致的——沿用不改动。

## 9. 验收标准（Acceptance Criteria）

### Rule 类（必须 100% 通过，二进制判断）

| ID     | 规则                                                                                                                                                                                                                          | 验证方式                                                            | <br />       | <br />                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | :----------- | :------------------------------------------------------------------------------------------ |
| AC-R1  | Sidebar 「智能体」主功能区 **不出现** "知识库" 项；下方"管理"区出现 1 个「知识库」入口，且点击不改变 `currentAgent`（不高亮面试题检索那一项）。                                                                                                                                  | 肉眼 + React DevTools 检查 AppShell `currentAgent` 前后不变             | <br />       | <br />                                                                                      |
| AC-R2  | `AGENTS` 常量中 **不存在** `id === 'knowledge-base'` 的项。                                                                                                                                                                          | `Grep -n "knowledge-base" src/lib/constants.js` 不出现在 AGENTS 数组项 | <br />       | <br />                                                                                      |
| AC-R3  | KnowledgeBasePage 源码中 **不包含** `useChatWithAnnotations`、`MessageList`、`ChatInput` 的 import 或引用；页面 0 个 Tab 切换组件。                                                                                                              | \`Grep -nE "useChatWithAnnotations                              | MessageList  | ChatInput" src/pages/KnowledgeBasePage.jsx\` 返回 0 匹配                                        |
| AC-R4  | `POST /api/knowledge/documents/manual` 成功写入后：① documents.json 新增 1 条（含 `source='manual'`）；② Vectra 向量库条数 = chunks 数量（和上传 md 文件完全一致）；③ 调用 `/api/knowledge/search` 能命中该新文档的切片（score ≥ 0.8）。                                   | 集成测试脚本 / 手动验证 3 点                                               | <br />       | <br />                                                                                      |
| AC-R5  | 手动录入的 title 为空 / content 为空 / tags 长度 11 时，后端必返回 `400` + `{message}`，且不写入 documents.json。                                                                                                                                   | Postman/curl 三次调用验证                                             | <br />       | <br />                                                                                      |
| AC-R6  | `POST /api/search/query`：`scope='all'` 时返回 JSON 顶层含 `questionResults` 和 `knowledgeResults`（均非 null，对象含 `{total,searchMs,items}`）；`scope='question'` 时 knowledgeResults===null；`scope='knowledge'` 时 questionResults===null。 | curl 3 次不同 scope，JSON 断言                                        | <br />       | <br />                                                                                      |
| AC-R7  | 当 Vectra 故意抛错（例如临时改 createRequire 指向不存在的包名）：面试题检索 `/api/chat` 仍能返回 200 + 结构化题目结果（流式正常），并仅注解中 `knowledge` 引擎的 items=0，**整次请求不是 500**。                                                                                        | 注入错误场景验证降级隔离                                                    | <br />       | <br />                                                                                      |
| AC-R8  | `/api/chat interview-retrieval` 分支调用栈中，**不再直接**调用 `questionBank.search()` 或 `store.search()` 或 `embedTexts()`——这些必须被封装进 `unifiedSearch` 函数；分支只调用 `unifiedSearch`。                                                           | \`Grep -nE "questionBank.search                                 | store.search | embedTexts" server/index.js\` 不匹配到 /api/chat 分支内部（只允许在统一检索封装函数 /api/search/query 之外的其他路由出现） |
| AC-R9  | 启动 `node server/index.js` 后 `/api/health` 正常返回 200；`GET /api/knowledge/documents` 仍返回 `{items,total,page,pageSize}`；`GET /api/knowledge/categories` 返回 `[{name,count}]` —— 旧契约零变化。                                          | curl 对比前后响应字段                                                   | <br />       | <br />                                                                                      |
| AC-R10 | 管理页点"新建知识"→填内容→提交成功后：文档列表自动多一条、分类面板的计数自动更新（若 category 非空）、所选分类过滤后能立即找到该文档。                                                                                                                                                  | 手动 UI 验证                                                        | <br />       | <br />                                                                                      |

### Rubric 类（质量维度，阈值 ≥ 7/10）

| ID    | 维度（0–10，阈值 ≥ 7）                                                                           | 低分锚点（≤ 3）                                                                                             | 中分锚点（5–6）                                                                                 | 高分锚点（≥ 8）                                                                                                                  | 证据来源                                                         |
| ----- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| AC-Q1 | **职责边界清晰度**：Sidebar「智能体 vs 管理」视觉分区、view 状态与 currentAgent 解耦                               | 仍用 currentAgent.id === 'knowledge-base' 推断页面；"管理"区和智能体区用同一套样式无分隔                                      | 独立 view 状态，但 Sidebar 分隔视觉不明显 / 标题缺                                                        | 明确的 Section 标题「智能体」「管理」、分隔线/留白、Header 标题按 view 切换、代码里 view 与 currentAgent 完全正交                                             | AppShell.jsx + Sidebar.jsx 代码审查                              |
| AC-Q2 | **统一检索复用率**：面试题检索调用方不手写"查 A 查 B"的拼接代码，unifiedSearch 一处改动两边升级                              | /api/chat 分支直接写 questionBank.search + embed + store.search 各一套，unifiedSearch 只是 /api/search/query 独自用 | 面试分支用了 unifiedSearch 但注解又自行拼了一遍未复用                                                        | `lib/unifiedSearch.js` 同时被 `/api/search/query` 路由和 `/api/chat` 分支调用；注解格式由一方生成                                              | unifiedSearch.js + index.js 调用点审查                            |
| AC-Q3 | **管理页使用体验**：录入/上传/删除/检索/预览的交互闭环流畅                                                         | 缺少"新建知识"按钮 / 弹窗，或按钮不可见 / 表单字段不清晰 / 成功后不刷新                                                             | 功能齐全但错误提示只弹 console / 分类建议不联动已有项                                                          | 表单非空校验前端就拦截（配合后端 400 双保险）、分类/标签用既有分类做建议 chips、提交成功 toast + 列表/面板自动刷新 + 错误内联显示                                              | UI 手动操作 + 控制台无 JS error                                      |
| AC-Q4 | **字段一致性（category/tag）**：写链路（上传/录入）与读链路（列表/过滤/统计）之间 0 命名漂移                                 | 上传用 categoryId、列表过滤用 categoryName、listCategories 又是第三个字段名                                             | 统一为 category，但 listDocuments 过滤是 `includes` 而 listCategories 用 `category` 精确 → 统计归类和筛选不一致 | 全链路只认 `category` 和 `tags` 两个字段名；写入/查询/listCategories 全部使用 `===` 严格匹配；"未分类"空字符串统一处理                                         | 代码审查 vectorStore.listDocuments/listCategories + index.js 写入处 |
| AC-Q5 | **代码变更最小化（不破坏既有测试通路）**：ChatPage、SearchProcessPanel、useChatWithAnnotations、流式响应注解解析链路 0 改动 | 为了适配改了 SearchProcessPanel 的 engine 字段或 annotations 解析，召回流程需要重测                                        | 只改前端导航/KB 页面，但 ChatPage 内一行非必要 import 被改动                                                 | 前端仅 AppShell/Sidebar/KnowledgeBasePage/新增组件/knowledgeApi（加 manual entry 方法）改动，聊天相关组件零 diff，后端 llm.js/prependAnnotation 零改动 | Git diff（概念性比较）                                              |

