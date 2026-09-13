# 通用 Agent 能力设计（v1）

> 目标：在 Interview Agent 现有架构上补齐通用 Agent 三大缺口 —— 长期记忆激活、反思回路、自主规划（ReAct）。
> 原则：复用既有资产、遵守 10 层分层铁律与 ADR-009（禁静默降级）、不改动已稳定的功能。

## 1. 现状盘点

### 已有（不重做）

| 资产 | 位置 | 状态 |
|---|---|---|
| 智能体注册表 + 5 个内置智能体 | `lib/agents/`（agentRegistry + builtin/*） | 可用 |
| 工具层 + 运行统计包装 | `lib/tools/docTools.js`、`lib/management/registry.js` | 可用（calls/failures/totalMs 已记录） |
| 工作流编排（禁直连工具） | `lib/workflows/`（docWorkflow / docPlanWorkflow） | 可用 |
| 两层记忆 | `lib/memoryService.js`（M2/ADR-007：会话滚动摘要 + kb_memory 长期事实） | 代码可用，**kb_memory 0 条**（未激活） |
| 意图解析 | `lib/intents.js`（L5.5） | 可用 |
| 审计 / 指标 / 会话持久化 | `lib/management/audit.js`、`lib/metrics.js`、`lib/sessionStore.js` | 可用 |

### 缺口

1. **kb_memory 长期记忆零数据** —— 机制在、没跑起来（P0：激活收尾）
2. **无反思回路** —— 回答生成后没有质量自查与重试（P1）
3. **无自主规划** —— 意图 → 固定智能体 → 预编排工作流，agent 不能自己拆步骤选工具（P2）

## 2. 三阶段总览

| 阶段 | 能力 | 新增文件 | 预估改动面 |
|---|---|---|---|
| P0 | 长期记忆激活 | 无新增（排查 + 开关 + 触发条件修复） | 小 |
| P1 | 反思回路 | `lib/reflection.js`（L2 纯算法）+ chat 主链路挂钩 | 中 |
| P2 | ReAct 自主规划 | `lib/workflows/reactPlanner.js`（L7）+ `lib/tools/` 注册 2~3 个新工具 | 中大 |

## 3. P0 —— 长期记忆激活（收尾性质）

`kb_memory` schema 已就绪（mem_id / owner_id / scope / session_id / agent_name / kind / text / content_hash / ts / text_vector），memoryService 的召回（recall）与提炼（onTurnEnd）链路已接进 chat。

待办：

1. 排查 `tunables.memory.enabled` 当前值与 kb_memory 写入路径是否被命中（读管理页调优面板 + 日志 grep `memoryService`）
2. 确认提炼模型路由（chat.general → qwen3:14b）在本机响应时延下 extractMemories 能在轮末 fire-and-forget 中完成
3. 管理页补一块「记忆面板」：列出 scope=global 的事实条目、条数、最近提炼时间（挂在现有 metrics 页即可）
4. 验收：连续对话 3 轮（含自我介绍类内容），kb_memory 出现去重后的事实条目；新会话提问能召回（日志可见 memoryBlock 注入）

## 4. P1 —— 反思回路

### 数据流

```
RAG 回答完成
  → reflection.evaluate(question, answer, citations)   [L2，纯函数式]
      快信号（零成本，先算）：
        - 引用命中率：citations 的切片是否真被答案语义覆盖（嵌入余弦，复用 embed.js）
        - 兜底话术识别：命中「没有找到/知识库中未提及」类模板 → 视为低置信
      慢信号（可选，LLM 自评）：
        - 仅当快信号低于阈值才调 LLM 打分（JSON：score 0~100 + 缺陷列表）
  → 决策：
      score >= 阈值（默认 60）  → 通过，记录反思日志
      score <  阈值            → 触发一次补救重检索（改写 query 放宽过滤 + HyDE 强制开启）→ 重生成一次
                                 仍不达标 → 原样输出 + 答案头部注入置信提示（不静默）
```

### 落位与接线

- 新增 `lib/reflection.js`（L2：输入输出明确的纯评估函数，依赖 embed.js / unifiedSearch 可测）
- `routes/chat.js` 主链路：回答落库后、SSE 关流前调用 evaluate；补救重生成最多 **1 次**（防循环）
- 反思记录落 `sessionStore` 新表 `reflection_log`（sessionId / question / score / action / ts），管理页出「反思记录」列表
- tunables 新增 `reflection.{enabled, minScore, maxRetries=1}`，默认 enabled=false 灰度开启

### 失败语义

评估或补救失败 → 记 warn、按「未反思」继续主链路（记忆同款「增强层失败不阻断」语义，但每条失败都有显式日志）。

## 5. P2 —— ReAct 自主规划器

### 定位

现有模式是「意图分类 → 挑一个固定智能体」；ReAct 规划器让模型自己走 `思考 → 选工具 → 观察` 循环完成复合任务（例：「把我上次上传的简历要点整理成 5 个面试题并入库」）。

### 循环设计

```
输入 goal（用户指令）
loop maxSteps 次（默认 8，tunables 可调）：
  1. Thought：LLM 依据 目标/历史步骤/上一步观察 输出 JSON：
     { "thought": "...", "action": "toolName" | "finish", "args": {...} }
  2. action=finish → 校验 result 字段后退出
  3. 否则 registry.resolveRunner(action) → run(args)（自动记 calls/failures/totalMs）
  4. Observation：截断至 2000 字符后回填下一轮上下文
每步落审计（复用 management/audit.js）；步数/超时熔断触发 → 显式报错返回已完成的中间结果
```

### 可用工具（首批注册）

| 工具 | 来源 | 说明 |
|---|---|---|
| `kb.search` | unifiedSearch | 知识库检索（复用现有混合检索） |
| `kb.documentInfo` | docTools | 文档/切片明细查询 |
| `memory.write` | memoryService | 把结论写入长期记忆（scope=global） |

首批只放 3 个只读为主的安全工具；写类工具（入库/删除）P2 暂不开放给自主规划 —— 若后续开放必须接 HITL 确认钩子（前端弹确认，走 SSE 的确认帧）。

### 落位

- `lib/workflows/reactPlanner.js`（L7）：循环编排；经 registry.resolveRunner 使用工具，不 import L6
- `routes/chat.js`：意图「复合任务」时（intents.js 新增一类）路由到规划器，SSE 流式下发每步 Thought/Action/Observation（前端现有流式渲染可直接消费）
- tunables：`react.{enabled, maxSteps=8, stepTimeoutMs=30000, totalBudgetMs=180000}`
- 管理页：规划轨迹查看器（每步的 thought/action/耗时/结果摘要）

### 熔断与安全

- 步数上限、单步超时、总预算三重熔断；触发即中止并返回已完成结果（显式说明未完成）
- 工具失败重试 1 次后跳过该步，Thought 层感知失败原因自行调整
- 审计每步；规划器全流程不触碰文档删除类接口（与删除事务化改造解耦）

## 6. 实施顺序与验收

| 顺序 | 内容 | 验收标准 |
|---|---|---|
| P0 | 记忆激活 + 管理页记忆面板 | 3 轮对话后 kb_memory 有数据、跨会话可召回 |
| P1 | 反思回路 | 低质回答触发 1 次补救重生成；reflection_log 有记录；主链路零回归 |
| P2 | ReAct 规划器 | 复合任务（检索→整理→写记忆）8 步内完成；每步审计可见；熔断可用 |

每阶段独立交付、独立可回退（tunables 开关），任一阶段不影响已稳定的检索/上传/删除链路。
