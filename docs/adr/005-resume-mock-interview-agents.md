# ADR-005：简历分析与模拟面试智能体（插件化接入 + 单次 JSON 结构化报告）

## 状态

已接受（2026-08-31）

## 背景

`resume-analysis`（简历分析）与 `mock-interview`（模拟面试）此前是前端占位（`available:false`）且无后端实现。需在不破坏既有 agent 分发与流式协议的前提下，把二者做成真正可用的智能体：

- 简历分析：解析/优化建议/岗位 JD 匹配/基于简历出题/结构化评分卡。
- 模拟面试：技术栈定向多轮问答 + 即时点评 + 结束评分报告。

## 决策

1. **完全复用插件化机制，零侵入分发层**
   - 后端各新增一个 L4 `lib/agents/builtin/{resumeAnalysis,mockInterview}.js`，在 `routes/chat.js` `agentRegistry.registerAgent()` 注册；`handler(ctx)` 统一 `pipeStream(res, stream, opts)`。
   - LLM 能力集中在 `llm.js`（L3）新增 `streamResumeAnalyze`、`streamMockInterview`，agent 只组数据、不碰模型细节（沿用 interviewRetrieval「先组数据再 prepend」范式）。
   - 数据源就近复用（分层合法）：mock-interview 用 `questionBank`(L1) 定向候选题；resume 用现有会话 `ctx.history`；简历文件解析用 `docProcessor.extractDocumentTextAsync`(L4) 经新 `routes/resume.js`(L8) 的 `POST /api/resume/parse`，**不落知识库**（避免简历被 RAG 污染）。
   - 前端仅在 `agentDefinitions.js` 把两 agent 置 `available:true`（mock-interview `structuredInput:true`），自动进侧栏 + `/chat/:id` 路由；其余复用现有 ChatInput/useAgentChat/session。

2. **结构化报告用「单次调用 + 严格 JSON → 前端渲染报告卡」**，不做「散文 + JSON」双契约。
   - 本地模型（如 qwen2.5-coder）对「同时输出自然文本与精确 JSON」遵循度差，双契约易解析失败/串扰。
   - 因此报告/评分以**非流式 `generateText` 产出单个 JSON**，解析为 `resume_report` / `interview_scorecard` 注解（`prependAnnotation` 注入 `2:` 行），另附一句简短叙述作正文；LLM 不可用或解析失败 → 降级占位报告卡，链路不崩。
   - 模拟面试的**普通问答轮仍是普通流式文本**（AI 面试官人设 + `buildHistoryContext` 多轮），仅「结束评分」走结构化卡。

3. **自定义 body 字段经现有 `append(msg,{body})` 通道下发**，不改 `useAgentChat` 请求层：`resumeText`/`jd`、`interviewFinish` 作为 body 传入 `/api/chat`。
   - 有 `resumeText` 时把用户消息文本视作 JD/目标，贴合「上传简历 + 输入 JD」的自然用法。

4. 新注解类型 `resume_report`、`interview_scorecard` 已加入前端 `runtimeAnnotations` 可渲染白名单（append 与 restore 两处），并由新面板 `ResumeReportPanel`、`InterviewScorecardPanel` 渲染（复用 `ChunkScoreBadge`）。`StreamingMessage` 分流新增两个 type 分支。

## 后果

- 正面：两个智能体端到端可用且经真实 LLM 验证（简历报告含总评与 JD 匹配分、模拟面试输出评分卡）；分发/存储/上传分层与既有 agent 一致，`check-layers.mjs` 通过；扩展新智能体的范式进一步被验证为「注册即用」。
- 权衡：结构化报告是「一次性非流式」而非逐字流式（本地模型小、且换取解析稳健）；mock-interview 开场白质量受本地模型指令遵循度影响，后续可换更强模型或加 few-shot 提升。
- 隐私：简历仅解析文本、不落可检索知识库，符合「简历不应被全局 RAG 召回」预期；如需持久化另设。

## 备选（未采纳）

- 双契约（散文+尾部 JSON）：小模型易破坏输出格式，弃用。
- 把简历也入库做 RAG：污染知识库、语义不符，弃用（需要时单独设受控流程）。
