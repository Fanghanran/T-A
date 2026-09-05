> ⚠️ 历史文档（Vectra 时代）：本文撰写时存储层为 Vectra，现已迁移至 Milvus；部分行号/实现细节已失效，仅作设计沿革参考。最新架构见项目根 ARCHITECTURE.md。

# Query 改写与检索优化计划

## Context

当前系统直接将用户原始问题传给检索引擎，没有经过改写。用户提问往往模糊、口语化、有指代词，直接检索命中率低。需要在检索前对 query 进行优化，同时在入库时为切片预生成检索锚点，两端共同提升检索质量。

---

## 完整链路

### 入库时（一次性）

```
切片完成后
  ↓
LLM 批量生成（本地 Ollama，一次调用）
  每个 chunk 输出：
    topic:     描述性标题
    questions: 3 个典型问题（检索锚点）
  ↓
入库
  { vector, text, heading, topic, questions, preContext, postContext }
```

### 查询时（每次用户提问）

```
用户提问 + 对话历史
  ↓
① 上下文压缩 + Query 改写（本地 Ollama，一次调用）
   输入：最近 N 轮对话 + 当前问题
   输出：多个独立检索查询（覆盖不同角度）
  ↓
② 多路检索
   每个查询分别：
     - 语义匹配预生成 questions（余弦相似度）
     - embed 后检索 chunk 向量
   合并去重，按相关度排序
  ↓
③ 拼接 prompt
   [前文背景] preContext
   [主题] topic
   [正文] text
   [后续] postContext
   + 对话上下文（压缩后）
   + 用户问题
  ↓
④ LLM 生成最终回答（外部 LLM，仅此一次）
```

---

## 关键设计

### 1. 入库：预生成问题

每个 chunk 在入库时由 LLM 生成 3 个典型问题：

```
输入：
  chunk 文本："React 闭包陷阱：useEffect 回调引用的 props/state
              会被捕获在定义时的帧里..."

输出：
  topic: "React Hooks 闭包陷阱"
  questions: [
    "useEffect 中为什么会拿到旧的 state 值？",
    "React 闭包陷阱的成因和解决方案是什么？",
    "useEffect 依赖数组怎么正确设置？"
  ]
```

**作用**：给切片增加检索锚点。用户搜"为什么 state 不更新"，和 chunk 原文相似度可能只有 0.6，但和预生成问题相似度可能是 0.85。

**实现**：和 topic 一起在同一次 LLM 调用中生成，零额外成本。

### 2. 查询：上下文压缩 + Query 改写

用户提问前，先压缩对话历史，再生成多个检索查询：

```
输入给 LLM：
  最近对话（压缩后）：
    用户：React Hooks 有哪些？
    助手：useState、useEffect、useCallback...
    用户：那个性能优化相关的呢？

  任务：请将最后一条用户消息结合上下文，生成 2~3 个独立、完整的搜索查询，
       覆盖不同角度，不依赖上下文即可理解。

输出：
  queries: [
    "React Hooks 性能优化 API useMemo useCallback",
    "React 避免不必要渲染的 Hooks 方案",
    "useCallback 和 useMemo 的使用场景和区别"
  ]
```

**为什么生成多个**：用户问"比较 A 和 B 的性能和生态"，一个 query 只能覆盖一个角度，多个 query 覆盖更全面。

### 3. 多路检索合并

每个生成的 query 分别检索，结果合并去重：

```
query_1 → 检索 → [chunk_3, chunk_7, chunk_1]
query_2 → 检索 → [chunk_3, chunk_5, chunk_8]  ← chunk_3 重复
query_3 → 检索 → [chunk_1, chunk_9, chunk_2]  ← chunk_1 重复

合并去重 → [chunk_3, chunk_7, chunk_1, chunk_5, chunk_8, chunk_9, chunk_2]
截取 topK → [chunk_3, chunk_7, chunk_1, chunk_5, chunk_8]
```

### 4. 检索匹配方式

每个 query 同时匹配两个维度：

| 匹配目标 | 方式 | 说明 |
|---|---|---|
| chunk 向量 | query embed → 余弦相似度 | 语义匹配 chunk 全文 |
| 预生成 questions | query embed → 和 question 向量比较 | 精确匹配问题表述 |

两个维度的结果合并，取并集。

---

## LLM 调用汇总

| 环节 | 调用时机 | 用谁 | 调用次数 | 目的 |
|---|---|---|---|---|
| 入库标注 | 上传时 | 本地 Ollama | 每 chunk 1 次（批量） | topic + 预生成问题 |
| Query 改写 | 查询时 | 本地 Ollama | 每次查询 1 次 | 压缩上下文 + 多角度检索查询 |
| 生成回答 | 查询时 | 外部 LLM | 每次查询 1 次 | 最终回答 |

外部 LLM 只在最后一步调用，前面全部本地 Ollama（免费）。

---

## 修改文件清单

| 文件 | 改动 |
|---|---|
| `server/lib/queryRewriter.js` | 新增：上下文压缩 + 多查询生成 |
| `server/lib/unifiedSearch.js` | 改造：接入 query 改写 + 多路检索合并 |
| `server/lib/vectorStore.js` | 扩展：chunk 增加 questions 字段，检索时支持 question 匹配 |
| `server/lib/chunker.js` | 入库时调用 LLM 生成 topic + questions |
| `server/index.js` | 查询端点适配新流程 |

---

## 依赖

- 本地 Ollama：已部署，模型 qwen2.5-coder:14b
- Embedding：本地 Ollama nomic-embed-text
- 向量数据库：Vectra（后续可换 Milvus）

---

## 生产环境加固要点

### 🔴 必须解决

**1. 改写超时与降级**

```
Query 改写（Ollama）设超时 3 秒
  ↓ 成功 → 用改写后的多查询检索
  ↓ 超时/失败 → 降级为原始 query 直接检索，不阻塞用户
```

改写是锦上添花，绝不能因为 LLM 慢或挂了导致用户等不到回答。

**2. 改写质量校验**

LLM 可能输出垃圾查询（幻觉、无关内容），需要过滤：

```js
queries = queries.filter(q =>
  q.length >= 5 &&           // 太短无意义
  q.length <= 200 &&         // 太长是废话
  !q.includes('抱歉') &&     // LLM 有时输出道歉语
  !q.includes('无法')        // 拒绝型输出
)
// 过滤后为空 → 降级用原始 query
```

**3. 预生成 questions 的向量索引**

questions 不能只存文本，需要单独建向量索引：

```
入库时：
  chunk.text      → embed → 存入向量库（现有逻辑，type=chunk）
  chunk.questions → 每个 question embed → 也存入向量库（同 docId，type=question）

查询时：
  query → 分别检索 type=chunk 和 type=question → 合并去重
```

检索时需要区分"命中的是 chunk 全文"还是"命中的是预生成问题"，两者权重不同。

**4. 多查询结果合并权重**

多个 query 的检索结果不能简单拼接，需要加权：

```
query_1（主查询，和用户问题最相关）→ 权重 × 1.0
query_2（扩展角度）                → 权重 × 0.8
query_3（更远的变体）              → 权重 × 0.6

同一个 chunk 被多个 query 命中 → 分数累加，排到前面
```

主查询权重最高，越远的变体权重越低，避免边缘结果污染排序。

### 🟡 建议优化

**5. 对话上下文压缩策略**

不能把所有历史都塞进去，需要截断：

```
保留规则：
  - 最近 3 轮对话完整保留
  - 更早的对话只保留摘要（或丢弃）
  - 总 token 数不超过 500（给改写 LLM 的输入）
```

超过 3 轮后，早期对话对当前检索的价值递减，保留反而干扰改写质量。

**6. 改写结果缓存**

相同或高度相似的用户问题不需要重复改写：

```
缓存 key = hash(最近 2 轮对话 + 当前问题)
缓存有效期 = 会话内（用户刷新页面后清空）
```

同一个会话内反复追问类似问题，直接复用上次的改写结果。

**7. 并发限流**

多用户同时查询时，Ollama 会被打满：

```js
const rewriteQueue = new PQueue({ concurrency: 3 })

// 超过排队上限直接降级
if (rewriteQueue.pending >= 10) {
  return [原始query]  // 跳过改写，直接检索
}
```

### 🟢 后续扩展

**8. 可观测性**

生产环境必须能回答"改写有没有用"：

```
每次查询记录：
  - 原始 query
  - 改写后 queries
  - 改写耗时
  - 检索命中数
  - 最终回答是否被用户采纳（如果有反馈机制）
```

有了这些数据才能判断改写策略是否有效，而不是凭感觉。

---

## 实施建议

**第一步：核心流程**

- queryRewriter.js：上下文压缩 + 多查询生成（含降级逻辑）
- vectorStore.js：chunk 增加 questions 字段，支持 question 向量检索
- unifiedSearch.js：接入改写 + 多路检索合并（含权重）

**第二步：生产加固**

- 超时降级 + 质量校验
- 改写缓存 + 并发限流
- questions 向量索引 + 合并权重

**第三步：可观测**

- 查询日志记录
- 改写效果评估指标

---

## 验证

1. 用同一个模糊问题，对比改写前后的检索结果命中率
2. 用复杂多意图问题，验证多查询扩展是否覆盖所有角度
3. 检查预生成 questions 的质量，是否覆盖用户常见提问方式
4. 端到端测试：上传文档 → 模糊提问 → 检查最终回答质量
