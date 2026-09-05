# ADR-009：禁止静默降级 · Fail-Fast 策略

## 状态

**已接受 · 已实施**（2026-09-04）

## 背景

用户策略判断：**降级兜底 = 隐性版本回退，不是好策略**。

原设计中存在三类"残缺实现的静默切换"：

| 违例 | 原行为 | 回退后果 |
|---|---|---|
| `embed.js` 熔断 → hash 假向量 | 检索"正常返回"，实为噪声相似度 | 语义检索整体静默不可用 |
| `llm.js` stub 模式 | 无 Key 时返回占位式回答，形似真回答 | 对话回退为"假智能" |
| `sessionStore` 只读 `_ephemeral` | DB 只读时会话"能聊"不落库 | 刷新即全部丢失 |

共同问题：把**明显的故障**变成**隐蔽的质量回退**——无报错、无告警，根因被掩盖，用户以为产品"就这样"。

## 决策：按降级三分类治理

| 类别 | 例子 | 政策 |
|---|---|---|
| **耐久性措施**（防丢数据，不改变可见质量） | 用户消息先落库再流式、关停前 flush、原子写 | **保留** |
| **无增强的有效实现**（输出仍有效、少增强、字段如实标注） | rewrite 超时用原始 query（`rewritten:false`）、评分回退纯启发式（`scoreMode:'heuristic'`） | **允许**，必须带标注 |
| **残缺实现的静默切换**（换上"坏实现"假装工作） | hash 假向量、stub 假回答、只读库假会话 | **禁止** → 显式抛 `ServiceUnavailableError`（503 + 结构化 code） |

### 具体改造（已实施）
1. `embed.js`：删除 hashEmbed/tokenize/DIM 全套 hash 兜底；`embedTexts` 未配置/熔断冷却中/调用失败 → 抛 `EMBED_UNAVAILABLE`（熔断保留，用途从"降级切换"变为"快速失败"）；`embedMode()` 返回 `'external' | 'unavailable'`。
2. `llm.js`：新增 `requireLLM()` 守卫；删除 `buildStubAnswer/buildStubSnippetExcerpts/buildStubInterviewExcerpts/stubResumeReport/stubInterviewScorecard` 全套假回答；严格 JSON 生成（简历报告/面试评分）失败重试 1 次后抛 `LLM_OUTPUT_INVALID`；`generateChunkAnnotations` 无 LLM 显式抛错（调用方 catch 后按「无标注」降级并记日志）。
3. `llmProvider.js`：`getChatModel` 未配置时抛 `LLM_NOT_CONFIGURED`（集中兜底）。
4. `sessionStore.js`：删除 `_ephemeral` 假会话分支；`requireWritable` 抛 `SESSION_DB_READONLY / SESSION_DB_UNAVAILABLE`（AppError，503 消息透传）。
5. `unifiedSearch.js`：`AppError` 穿透 per-query catch——能力不可用不被"丢弃该 query"吞掉。
6. `index.js`：启动日志区分 LLM 未配置 / Embedding 不可用的提示文案；`/api/health` 能力位供前端提醒。

### "提醒"通道
- 启动控制台：未配置模型/Embedding 打 ⚠️ 并附配置方法。
- `/api/health`：`llm/embedding` 模式串 + `ok` 位；仪表盘健康条渲染状态 pill。
- 运行时：503 + code 直达前端内联错误条。

## 后果

- 正面：故障即时可见、根因不再被掩盖；行为确定性（同一配置永远同一行为）；删除大量死代码路径。
- 体验取舍（用户已拍板）：未配置 LLM 时对话功能不可用（报错+指引），不再提供占位回答；未配置 Embedding 时上传/检索报错。
- 遗留约束：`docProcessor` 的确定性 action 路由（上传/预览/入库引导语）**保留**——那是真实实现而非假回答；`attachChunkScoresAsync` 的 heuristic 回退保留（`scoreMode` 标注）。
- `LLM_STUB=1` 现语义 = 强制"未配置"（触发 503），仅用于验证提醒链路。

## 关联
取代 ADR-001/003/004 中与之冲突的降级表述；`docs/ROADMAP.md` M1（模型管理）在此底座上实现按 profile 独立熔断。
