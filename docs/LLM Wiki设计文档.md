# LLM Wiki 设计文档

> 状态：设计阶段（未实施）。本文档定义"从知识切片提炼 LLM Wiki 词条"的总体方案，
> 以及为避免后期结构性返工而需要在当前代码中预留的接口。
> 架构约束遵循项目根 `ARCHITECTURE.md`（L0~L9 分层）；降级策略遵循 ADR-009。

## 1. 背景与目标

知识库中的切片（kb_chunks）以 400~1000 字粒度存储，检索友好但浏览困难：
同一概念（如 "token"、"上下文窗口"）散落在多个文档的多个切片中，没有统一的
聚合视图。LLM Wiki 的目标是：

- 以**词条（Entry）**为单位聚合知识：一个词条 = 一个概念的权威解释
  （定义、摘要、别名）+ 可追溯的来源切片列表
- 词条由 LLM 从切片自动提炼生成，支持人工编辑修正
- 词条参与向量检索（混合检索候选源之一，见 ADR-010 的后续扩展）
- 词条作为独立节点类型出现在知识网络图中，与切片图共存

明确不做：Wiki 不引入新的存储引擎（复用 Milvus）；不做独立的用户体系；
不做词条间引用网络的一期实现（仅预留 type 字段）。

## 2. 总体架构与数据流

```
kb_chunks（切片，含 topic/questions 注解、text_vector）
    │  ① 聚合候选：按 topic / 高相似簇分组的切片集合
    ▼
wikiGenerator（L4 领域层新模块，LLM 提炼）
    │  ② 每组切片 → LLM 生成 { title, aliases, definition, summary }
    │     entry_vector = 来源切片 text_vector 均值（不新增嵌入调用）
    ▼
kb_wiki（Milvus 新集合，schema 见 §3）
    │
    ├── ③ 检索：unifiedSearch 将词条作为候选源（与切片召回融合）
    ├── ④ 网络图：词条节点（type='wiki'）与切片节点共图展示
    └── ⑤ 浏览：前端 Wiki 页面（Navicat 布局同构，见 §5.3）
```

失效链路：文档内容变更（PATCH content / 重切 / 删除）→ 来源切片失效 →
`markWikiStale(docId)` 标记关联词条 → 词条列表显示"待重生成"，不静默删除。

## 3. 数据模型

### 3.1 Milvus 集合 kb_wiki

运行时建集合（与 kb_documents / kb_chunks 同模式），schema：

| 字段 | 类型 | 说明 |
|------|------|------|
| entry_id | VARCHAR PK | `wiki_${nanoid}` |
| title | VARCHAR(512) | 词条名（唯一性约束由应用层维护） |
| aliases | VARCHAR(2048) | 别名 JSON 数组 |
| definition | VARCHAR(8192) | 权威定义（LLM 生成 / 人工编辑） |
| summary | VARCHAR(2048) | 一句话摘要 |
| source_chunk_ids | VARCHAR(8192) | 来源切片 ID JSON 数组（可追溯） |
| source_doc_ids | VARCHAR(2048) | 来源文档 ID JSON 数组（失效判定用） |
| category | VARCHAR(128) | 继承来源文档分类 |
| entry_vector | FloatVector(1024) | 词条向量 = 来源切片向量均值 |
| status | VARCHAR(32) | active / stale / draft |
| llm_model | VARCHAR(128) | 生成模型标识（审计用） |
| updated_at | INT64 | 毫秒时间戳 |

enable_dynamic_field=false（与现有集合一致）。索引：entry_vector HNSW
（metric 与 kb_chunks 对齐），title 不建索引（前缀过滤量级小）。

### 3.2 与现有集合的关系

- kb_wiki 是**纯派生数据**：任何时刻可从 kb_chunks 全量重建，删除集合不丢知识
- 词条不持有原文，详情视图通过 source_chunk_ids 回查 kb_chunks 展示来源

## 4. 预留接口（本期实施，避免后期结构性返工）

以下三点为当前代码需要落地/遵守的预留，其余模块（集合、路由、生成器）
到实施期新增即可。

### 4.1 网络图节点类型字段（本次代码改动）

`buildChunkGraph`（server/lib/milvusStore.js）输出的每个节点增加
`type: 'chunk'` 常量字段；前端 KnowledgeGraphCard 节点映射原样透传。
将来 wiki 词条节点以 `type: 'wiki'` 进入同一数据结构，前端按 type
区分形状（切片=圆点，词条=方点）与交互，既有消费方不受影响。

### 4.2 写路径单一收口（纪律约束，无代码改动）

文档写路径必须继续收敛在现有收口方法内，禁止绕过 vectorStore /
docProcessor 直接操作 milvus：

- 两段式 commit（routes/knowledge.js → prepareDocChunksAndVectors）
- 旧上传端点
- PATCH content 重切
- 删除文档

实施期在这三四处统一挂 `markWikiStale(docId)` 调用。若绕过收口新增
写入，词条失效链路将出现遗漏——这是本设计唯一的强纪律点。

### 4.3 切片注解链路保持（既有能力，禁止绕过）

词条聚合的原材料是切片的 topic / questions 注解（questionsPerChunk=3，
由 generateChunkAnnotations 生成）。上传链路的 withQuestions 开关只允许
用户显式关闭；任何新增写入路径不得跳过注解生成，否则该批切片在 wiki
聚合中只能走纯相似度聚类，质量下降。

## 5. 实施期新增模块（无需预留，到时加）

### 5.1 后端

- **L4 领域层** `server/lib/wikiGenerator.js`：聚合候选（topic 相同 +
  跨文档相似簇合并）→ LLM 提炼（走 L3 llm 层 streamText，产物结构化
  JSON）→ 归一化校验 → 写 kb_wiki。批量生成挂 workflow 注册模式
  （与 docWorkflow 同款，可被管理模块启停/统计）。
- **L8 路由**（挂 management 或独立 /api/wiki，实施期定）：
  - `POST /api/wiki/generate` — 触发批量提炼（异步 jobId，复用任务轮询模式）
  - `GET /api/wiki/entries?q=` — 列表 + 关键词/语义检索
  - `GET /api/wiki/entries/:id` — 详情（含来源切片回查）
  - `PATCH /api/wiki/entries/:id` — 人工编辑（重算 entry_vector）
  - `POST /api/wiki/entries/:id/regenerate` — 单词条重生成
  - `POST /api/wiki/rebuild` — 全量重建（删集合重建，运维兜底）
- **网络图扩展**：buildChunkGraph 增加 includeWiki 参数，词条节点 +
  "词条 ↔ 来源切片"归属边并入图数据。

### 5.2 检索融合（ADR-010 后续）

unifiedSearch 增加词条召回源：query 向量在 kb_wiki.entry_vector 上检索，
得分与切片召回融合。词条命中优先作为答案骨架（定义 + 摘要），
来源切片作为展开细节。召回失败（Milvus/Embedding 不可用）按 ADR-009
显式报错，不静默降级。

### 5.3 前端

- 侧边栏"向量库"目录或知识库区新增"Wiki"菜单
- 列表 + 详情复用 Navicat 布局（左侧词条导航 + 右侧词条详情/来源切片，
  与数据明细页同构）
- 网络图：词条节点方点 + 独立图例分组；词条详情面板可跳转来源切片
  （复用 /vector-data?docId=&chunkId= 定位链路）

## 6. 实施阶段划分

| 阶段 | 内容 | 依赖 |
|------|------|------|
| P0（本次） | §4.1 type 字段预留 | 无 |
| P1 | kb_wiki 集合 + wikiGenerator + 生成/列表/详情 API | 无外部依赖，LLM 可用 |
| P2 | 失效链路（markWikiStale 挂收口）+ 人工编辑 | P1 |
| P3 | 前端 Wiki 页面 + 网络图词条节点 | P1 |
| P4 | 检索融合（词条召回源） | P1，ADR-010 评审 |

## 7. 风险与边界

- **LLM 生成质量**：定义可能幻觉。缓解：definition 必须由来源切片支撑，
  详情页始终展示来源切片供用户核对；llm_model 字段留存审计。
- **词条唯一性**：同义词可能生成重复词条。缓解：生成前按 entry_vector
  相似度（≥0.9）+ title/aliases 归并；冲突时合并 source 列表。
- **成本**：批量提炼为一次性 LLM 开销，按文档粒度增量触发（仅 stale
  词条重生成），不做全量轮询。
- **规模**：个人知识库词条量级数百~数千，全对归并 O(n²) 可接受
  （与网络图现状同边界）；上万词条再引入 HNSW 邻居归并。
