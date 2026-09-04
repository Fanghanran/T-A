# 知识库管理功能增强（KB Management Enhance）实现计划

## Repository Research（调研结论）

### 1. 当前能力基线（A1+B1+C2+D2 已落地，"只有检索 + 新增"的实际缺口）

- **录入**：文件上传（.md/.markdown/.txt 3 种，见 [index.js#L162](file:///d:/workplace/trae/server/index.js#L162) `TEXT_EXT`） + 单条手动录入 `POST /documents/manual`（[index.js#L290-L324](file:///d:/workplace/trae/server/index.js#L290-L324)）。
- **检索**：`POST /knowledge/search` 纯语义（顶栏调用）+ `GET /documents` 列表的 `category/tag/q` 过滤（`q` 已做 title+content 双字段，[vectorStore.js#L332-L339](file:///d:/workplace/trae/server/lib/vectorStore.js#L332-L339)）。
- **管理**：`DELETE /documents/:id`（含 Vectra 向量删除，[vectorStore.js#L351-L372](file:///d:/workplace/trae/server/lib/vectorStore.js#L351-L372)）、`GET /documents/:id` 详情含 content 正文预览。
- **列表 / 分页**：`GET /documents` 有 `page / pageSize`（默认 20），返回 `{items, total, page, pageSize}`，但**没有排序参数**，插入序遍历 Map（文档越新越靠后）。
- **切片元数据**：`chunks[i]` 字段 = `{id, docId, text, heading, category, tags}`（[vectorStore.js#L15](file:///d:/workplace/trae/server/lib/vectorStore.js#L15) / [#L308-L316](file:///d:/workplace/trae/server/lib/vectorStore.js#L308-L316)）。其中 `heading` 来自 chunker 解析 markdown `#xxx`（[chunker.js#L39-L45](file:///d:/workplace/trae/server/lib/chunker.js#L39-L45)），**没有独立的"切片展示标题"字段**。
- **Document 元数据字段**：`{id, title, category, tags, size, uploadedAt, summary, content}`（[vectorStore.js#L266-L275](file:///d:/workplace/trae/server/lib/vectorStore.js#L266-L275)）—— 手动录入的 `source` 字段**未进入 doc**（[index.js#L317](file:///d:/workplace/trae/server/index.js#L317) 里写了 `source`，但 createDocument 形参里没接 `source`，它被静默丢掉了。这是一个已经存在的 bug，本次顺便修）。
- **健康统计**：`GET /api/health` 返回 `{ok, llm, embedding, documents, chunks, questions, byCategory}`（[index.js#L193-L202](file:///d:/workplace/trae/server/index.js#L193-L202)）—— `byCategory` 来自题库的分类统计（`questionBank.stats().byCategory`），**没有知识库侧的分类统计**。
- **预览组件**：[DocumentPreview.jsx](file:///d:/workplace/trae/src/components/knowledge/DocumentPreview.jsx) 只渲染完整 Markdown，没有 Tab 切换 "正文 / 切片"。
- **计数面板**：完全没有。

### 2. 缺口总结 → 对应本次要落地的 11 个子能力

| 编号 | 你勾选的需求 | 对应解决的缺口 |
|---|---|---|
| F1 | 修改文档元数据（title/category/tags/source） | doc 对象目前没 source；vectorStore 无 patch 元数据方法；无 PATCH 路由；无前端编辑表单 |
| F2 | 修改正文内容（重切片 + 重嵌入向量） | 无 replaceChunks / updateDocument 全链路；上传&手动录入都用 createDoc+addChunks 的一次性写入范式；编辑后切片数量变了要同步删旧向量 |
| F3 | 查看文档切片（需要一个独立切片标题，且不用 markdown 解析出的原 heading） | chunk 字段里只有 heading，无 displayTitle；无 `GET /documents/:id/chunks` 路由；预览面板无「切片 Tab」 |
| F4 | 列表排序 | `store.listDocuments` 无 sort 参数；`GET /documents` 路由无 sort；前端列表顶部无排序下拉 |
| F5 | 分页器 | 后端分页 API 已就绪；前端完全没画分页按钮 |
| F6 | 批量操作（批量删除 / 批量改分类 / 批量加标签） | 无 `/documents/batch` 路由；vectorStore 无 batchDelete/batchPatchMeta；列表无复选框 & Toolbar |
| F7 | 文档计数面板（含各分类数量图） | `/api/health` 知识库侧没聚合 byCategory；前端没顶部 dashboard 组件 |
| F8 | 上传文件类型扩展（目前只支持 md，你备注"当前只能上传md文件"） | `TEXT_EXT` 正则只认 md/markdown/txt；而且上传路由报错文案里写着「PDF/Word 需额外接入文本抽取库」，但其实 docx/html/csv/tsv 等纯文本类格式可以直接 decodeBuffer 文本化先放开 |
| F9 | 切片独立标题（不用 markdown heading） | chunk 里新增 `displayTitle` 字段，逻辑 = 「文档标题 + § + idx+1」；若用户以后想手工改，可在后续迭代暴露字段编辑，这次先生成好存进去，向后兼容 |
| F10 | source 字段修复（已经写入但被 createDocument 丢掉） | createDocument 形参加 `source` |
| F11 | Vite 构建 0 error 回归 | 之前引入 ManualEntryDialog 时踩过"没有 DialogHeader / 没有 Textarea 组件"坑，所有新增组件要按本项目 shadcn 子集对齐（DialogContent+div.header；自建 Textarea） |

---

## Files and Modules（要改的文件清单）

### 后端
- `server/lib/vectorStore.js`：加 `patchMeta` / `updateDocument`（含 replaceChunks → 删旧 chunk 向量 + 加新 chunk）/ `listChunksOf(docId)` / `statsByCategory()`（知识库侧分类统计）；`createDocument` 接入 `source` 字段；`addChunks` 给每个 chunk 写 `displayTitle` 字段
- `server/lib/chunker.js`：暂不改；`displayTitle` 在 `addChunks` 写入阶段拼出来（doc.title + idx），不污染切片算法本身
- `server/index.js`：
  - 扩展 `TEXT_EXT`，把纯文本能直接解码的类型加进来（.md/.markdown/.txt/.html/.htm/.csv/.tsv/.log/.json/.yaml/.yml）；PDF/DocX 保持报错文案提示需抽文本库（不做 OCR/解析）
  - 新增 4 条路由：`PATCH /documents/:id`（F1+F2 同一个 body，字段选填）、`GET /documents/:id/chunks`（F3）、`POST /documents/batch`（F6）
  - `GET /documents` 加 `sort` 参数（F4：`uploadedAtDesc` 默认 / `uploadedAtAsc` / `titleAsc` / `titleDesc` / `categoryAsc` / `sizeDesc`）
  - `GET /api/health` 新增 `knowledgeByCategory` 字段（F7）
  - `GET /` 端点清单更新（新路由说明）

### 前端 API & Hook
- `src/lib/knowledgeApi.js`：加 `patchDocument(id, payload)` / `getDocumentChunks(id)` / `batchDocuments({ids, op, ...})`；`listDocuments` 加 `sort` 形参
- `src/hooks/useKnowledgeBase.jsx`：
  - 加 `sort` 状态、`setSort`；`listDocuments` 调用透传 sort
  - 加 `page / pageSize / setPage` 暴露（目前已有内部 state，没 return 出来）
  - 加 `updateMeta`、`updateContent`（内部都走 `patchDocument` 一个方法，按 payload 区分）
  - 加 `selectedChunks` / `chunksLoading` / `loadChunks`
  - 加批量：`selectedIds` Set state / `toggleSelectId` / `clearSelection` / `batchDelete` / `batchSetCategory` / `batchAddTags` / `batchRemoveTag`
  - 面板统计：`stats` state（docs/chunks/categories/chunksByCategory）+ `loadStats`，初始化 & 每次写操作后 refresh

### 前端组件 / 页面
- `src/components/knowledge/KbStatsPanel.jsx`（新增 F7）：4 个卡片（文档总数 / 切片总数 / 分类数 / 标签数）+ 分类横向条形图（纯 Tailwind div，不用 chart lib）
- `src/components/knowledge/DocumentEditDialog.jsx`（新增 F1+F2）：复用 ManualEntryDialog 的表单结构，但有「仅改元数据 / 连正文一起改」两个模式；title/source/category/tags/（可选）content；校验规则同手动录入
- `src/components/knowledge/DocumentList.jsx`：每个条目加复选框；顶部加排序下拉；列表末尾加分页器（↑ 1 2 3 … ↓）；加「选中 N 条」Toolbar（批量删除 / 批量改分类 / 批量加标签 / 批量减标签）
- `src/components/knowledge/DocumentPreview.jsx`：头部加 2 Tab（「正文 · 默认」/「切片」），切片 Tab 下渲染 `selectedChunks`，每个块展示 `displayTitle` 大标题、heading、content、字符数；折叠展开（默认全部展开，和正文保持一致的阅读体验）
- `src/components/knowledge/CategoryTagFilter.jsx`：不动或最小改动（刷新按钮触发 `kb.loadStats + kb.refresh`）
- `src/pages/KnowledgeBasePage.jsx`：顶部加 `KbStatsPanel`；传新增 props 给 Filter/DocumentList/DocumentPreview；在预览栏上方「选中 doc 时」加一个「编辑文档」小按钮（启动 DocumentEditDialog）
- `src/components/knowledge/ManualEntryDialog.jsx`：不动（F10 createDocument 修了 source，手动录入的 source 会自动被落盘）

---

## Implementation Steps（按依赖顺序）

### Step 1：后端数据模型补齐（F9 / F10，最低层改起，必须先做）
- vectorStore.createDocument 形参加 `source`，默认 `'upload'` 或 `'manual'`；写入 doc 对象
- addChunks 给每个 push 到 `chunks` 数组的对象加 `displayTitle: \`${docTitle} § ${idx + 1}\``（idx 即 chunkList[i].idx，chunk 写入时的自增序号）；同时写入 Vectra metadata 携带 displayTitle 保持一致
- 向后兼容：chunk 旧数据没有 displayTitle 时，`listChunksOf` / 搜索返回里兜底拼一个（用 doc.title + 在该文档所有 chunks 中的位置序号），避免老数据崩
- `stats()` 旁边加 `statsByCategory()`：返回 `Array<{name, count, chunks}>`（chunks=该分类下总切片数）
- 不写接口，不启动服务，先纯 JS 语法检查（node --check）

### Step 2：后端 API 补齐（F1 F2 F3 F4 F6 F7）
- patchMeta(id, patch)：只改 doc Map 里的非 content 字段；如果改 category/tags，**同时遍历其 chunks 把 chunk.category/.tags 同步更新**（元数据一致性）；同步 scheduleSaveMeta；chunk 所属向量 metadata 的 category/tags 更新策略——本步只改 chunks.json 里的元数据；向量侧不过多改写（因为搜索返回时 chunk.category 优先于 vectra.metadata.category，[vectorStore.js#L442-L443](file:///d:/workplace/trae/server/lib/vectorStore.js#L442-L443)，所以只改 JSON 即可满足"过滤结果精确"），向量侧只在 updateContent（重切片）时整库删旧增新
- updateContent(id, newContent)：算 newChunkList + newVectors；先 listChunksOf 取旧 chunkIds；在 Vectra 里 `index.deleteItems(oldChunkIds)`；在内存 chunks 数组里删除 docId=id 的旧条目；再新 addChunks 的流程追加新 chunks；同时更新 doc.content / doc.size / doc.summary；整个操作包在 `beginUpdate → endUpdate` 事务里，失败回滚
- `GET /documents/:id/chunks`：返回 `{items:[{id, displayTitle, heading, text, chars}], total: n}`
- `GET /documents` 路由读 `sort` query，在 store 内部做稳定排序后再 slice 分页
- `POST /documents/batch` 路由：body 形如 `{ids: string[], op: 'delete' | 'setCategory' | 'addTags' | 'removeTag', ...payload}`，内部批量 vectorStore 调用
- `GET /api/health` 加 `knowledgeByCategory: store.statsByCategory()`；`GET /` 端点清单更新
- 启动服务（或已有长驻实例刷新热加载失败的话重启），curl 跑最小合约：PATCH meta → 读文档确认；PATCH content → chunks 数量变化；GET chunks 返回 displayTitle；batch delete 删除 2 条；sort 不同值顺序变化

### Step 3：扩展上传文件类型（F8）
- `TEXT_EXT` 正则扩展为 `/\.(md|markdown|txt|html?|csv|tsv|log|json|ya?ml)$/i`
- HTML/JSON/YAML 虽然不是纯知识最佳类型，但用户可能直接粘贴 API 文档/配置片段进来；decodeText 本来就能 decode 任意 buffer 到字符串；CSV 的内容是表格转 tabular 知识，也能被 chunker 切
- PDF/DOCX/PPTX 保持报错（"需要额外接入文本抽取库（如 pdf-parse / mammoth），当前示例不启用"），不引入新依赖
- 校验：上传一个 .json 或 .csv 文件应成功入库

### Step 4：前端知识 API + Hook 扩展
- knowledgeApi 新增 3 方法；listDocuments 加 sort
- useKnowledgeBase：补齐所有 state（sort、page、selectedIds、stats、selectedChunks、chunksLoading）和所有 action（toggleSelectId、clearSelection、updateMeta、updateContent、loadChunks、loadStats、batchXxx、setPage、setSort）
- `busy` 聚合要加上 `creating`/`updating`/`batchLoading`/`chunksLoading`
- 不动 ManualEntryDialog / CategoryTagFilter 组件的调用签名（向后兼容）

### Step 5：前端 UI 组件新增（KbStatsPanel + DocumentEditDialog）+ 预览加切片 Tab
- KbStatsPanel 4 卡 + 条形图（按分类排序，Top 5 显示 + "其余 N 类"聚合）
- DocumentEditDialog 两个模式：ModeA "仅元数据"（title/source/category/tags）；ModeB "元数据 + 正文"（加多 Textarea，带字符数 & ≥30字提示）。保存时 body 是否带 content 字段决定走 patchMeta 还是 updateContent 还是一起 patch
- DocumentPreview 加 2 Tab：正文（现有）/切片（新）。切片 Tab 中每个 chunk 一张 card，展开显示全部 text，左上 displayTitle 大字，右上 heading，右下字符数

### Step 6：DocumentList 复选框 + 工具栏 + 排序 + 分页器
- 条目左侧加 checkbox（`<input type=checkbox>` + CSS，不依赖 Radix checkbox 组件 — 项目没装 shadcn/ui checkbox）；全选/取消全选可选做（这次先做逐条勾选，不加全选）
- 顶部加排序 `<select>`，选项：上传时间新→旧、上传时间旧→新、标题 A→Z、标题 Z→A、分类 A→Z、体积大→小
- 列表底部加简易分页器：`< 第 page / totalPages 页 >`，page=1 时左箭头灰；到末页右箭头灰；每页 pageSize=20 不允许改（以后再加）
- 选中至少一条时，列表顶部出现"批量工具栏"卡片：选中 X 条 / 批量删除 / 批量改分类（下拉）/ 批量加标签（输入框 + 逗号切分）/ 批量减标签（输入框 + 逗号切分）/ 清空选择

### Step 7：KnowledgeBasePage 总装配
- 顶部工具栏下方插入 KbStatsPanel（仅在 `view=knowledge` 本页渲染，AppShell 不改）
- 顶部工具栏里原有的「上传 / 新建知识」顺序不变
- 预览 Tab 选中切片时确认 displayTitle 字段存在（老数据走兜底逻辑不崩）
- 预览栏右上角（close 按钮旁边）加「编辑」小按钮 = 打开 DocumentEditDialog，默认 ModeA
- onLoadingChange 与 busy 聚合正确 → Header 状态栏

### Step 8：验证 & 回归（下一节 Validation 全跑）
- E2E curl：新增/修改/删除/批量/排序/分类统计/切片标题都跑一遍
- Vite 构建 0 error
- 面试题智能体验证（不写代码，但必须测一遍：面试题智能体问一个知识库存在的知识点，annotation results 结构不变且 knowledgeResults 能返回兜底结果）

---

## Dependencies and Considerations（依赖与注意事项）
- **零新依赖**：所有 UI（统计条形图、分页器、Tab、checkbox）只用现有 Tailwind + Radix 基础组件（Dialog/Button/Badge/ScrollArea/Separator）+ 原生 `<select>/<input type=checkbox>`，不引 chart lib / Radix Tabs / Radix Checkbox，避免 shadcn 子集缺组件又踩"DialogHeader not exported"类坑
- **向后兼容**：
  - 旧 chunks 无 `displayTitle`：listChunksOf 兜底拼接 doc.title + 在 chunks.filter(docId) 的顺序位
  - 旧 doc 无 `source`：read/get 时字段不存在就是 undefined，前端判断 `doc.source || '—'` 即可
  - 旧列表调用没传 `sort`：默认 `uploadedAtDesc`，和今天的遍历序一致（新文档后序 = 倒序）
- **编辑时向量重算耗时**：一次 updateContent = N 次 embed + 1 次事务，50 块大概 5-10s。前端按钮进入 loading + 禁止重复提交；后端单次 PATCH 路由加 `express.json({ limit: '8mb' })`
- **面试兜底 SSE annotation 结构不变**：D2 里 unifiedSearch 输出格式 100% 不动。这次只改 patch/createDocument 的字段，搜索返回的 item 结构（id/docId/title/snippet/score/category/tags/heading）不变，所以面试页面零改动
- **category/tags 同步一致性**：patchMeta 改 category/tags → 同时写 doc + 属于它的每个 chunk 里的 category/tags 字段。否则 listChunks 里 category 显示和 doc 不一致

---

## Validation（实现后必跑验证，逐项✅）
### 后端接口合约
1. `POST /documents/manual {source: 'xxx'}` → 回读 doc，`doc.source === 'xxx'`（修复 F10）
2. `PATCH /documents/:id {title, category, tags, source}` → doc 字段全变更，且它的 chunks 列表查出来的 chunk.category / chunk.tags 同步变更（F1）
3. `PATCH /documents/:id {content: newText}` → doc.content/size/summary 更新，chunks 数量 = splitIntoChunks 的块数，且旧 chunk 的 id 不再出现在 `listChunksOf`（F2）
4. `GET /documents/:id/chunks` → 每块都有 displayTitle = `${doc.title} § N`（F9）；旧数据（无 displayTitle）返回的 displayTitle 也是这个格式（兜底生效）
5. `GET /documents?sort=titleAsc` / `sort=uploadedAtAsc` / `sort=sizeDesc` 三种顺序一致（F4）
6. `POST /documents/batch {ids, op:'delete'}` → 文档批量删除且 health documents 总数递减；`op:'setCategory'` 多个 doc 同类别修改成功（F6）
7. `GET /api/health` → 含 `knowledgeByCategory` 字段；分类数量和 `GET /categories` 结果一致（F7）
8. 上传 `.csv` / `.html` / `.json` 各一个 → 入库成功（F8）

### 前端构建/交互
9. `npm run build` → 0 error，0 warning
10. 打开知识库管理页 → 顶部显示 KbStatsPanel 4 卡片 + Top5 分类条形图
11. 列表排序下拉 6 种排序切换正确；分页器到第 2 页时数据是下一页
12. 勾选中 2 条文档 → 工具栏显示"已选中 2 条"；批量改分类后列表里两条都变新分类（不用刷新）
13. 预览面板切换到「切片」Tab → 每块有独立 displayTitle 大字、字符数、正文、heading
14. 点预览栏右上角的「编辑」 → ModeA 修改元数据 → 关闭后预览 doc.title/source/category/tags 即时刷新；再打开 ModeB 修改正文 → 切片 Tab 内容和块数跟着刷新

### 面试兜底（不回归）
15. 走面试题智能体问"React useEffect 依赖数组坑点" → SSE 中仍会 emit `2:` annotation，前端 KnowledgeChips 仍正常渲染（UI、字段结构、"知识库切片"字样都不变）

---

## Risks（风险与处置）
| 风险 | 影响 | 处置 |
|---|---|---|
| `updateDocument` 中 `deleteItems + addChunks` 中间进程崩溃：chunks.json 已删旧没写新 / 向量库已删旧没写新 → 数据不一致 | 文档丢失向量，检索不到 | **方案**：先 addChunks（写新 chunks + 写新向量），再 deleteItems（删旧向量+删旧 chunks），最后把 doc 的 content 替换。向量和 chunks JSON 都走事务或 debounced 连续写入；崩溃后启动时 load() 会把 Vectra 里"有向量但 chunks.json 里无"的项当孤儿，下次 addChunks 时 id 不冲突（自增 seq），属于安全的"占空间但不报错"状态，可人工清理 |
| 用户上传的 .html 体积 10MB（文件上限 multer 已允许 10MB） → 切片 1000+ 块 → embed 调用超时 | 一次上传/编辑卡顿、API 超时返回 | **处置**：multer limits.fileSize 保持 10MB；但在 upload/manual/edit 的入口，如果内容 > 2MB 时打印 warn；同时 embedTexts 超时已有（之前 D2 有超时兜底 throw 500 的路径），前端错误条正常展示；不做上限调整，避免破坏已有用户流程 |
| 批量操作选中 100+ 条删除 → `deleteItems([...ids])` 一次性事务太大 | Vectra 单次 endUpdate 卡住 | **处置**：vectorStore.batchDelete 内部每 50 个 chunk 一个 `beginUpdate/endUpdate`；前端批量操作按钮点击后给出"处理中，请稍候"的 Toast（这里用现有的 `error` 条 + `busy` 状态联动，不上新 toast 组件） |
| 没有引入 Radix Checkbox / Radix Tabs，手写 div tab 切换可访问性弱 | 键盘 Tab / screenreader 体验差 | **处置**：Tab 切换用 `<button role="tab">` + `aria-selected`/`aria-controls`；checkbox 用原生 `<input type=checkbox>`，天然可键盘访问。本项目是内部工具，a11y 达到原生控件级即可，不上完整 WAI-ARIA pattern |
| `store.listDocuments` 排序 + 分页 + 过滤同时执行 → 1000 条文档内存过滤性能低 | 列表首屏卡顿 | **处置**：1000 条量级内存排序 < 1ms，可接受；如果以后到 1 万条再改成 server 侧 SQLite |
