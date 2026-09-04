# ADR-002：通过 registry 扩展聊天智能体

## 状态

已接受（2026-08-31）

## 背景

聊天请求需要支持通用对话、面试检索、知识库 RAG 和文档处理，同时避免在 HTTP 路由中不断增加业务分支。

## 决策

使用 `server/lib/agents/agentRegistry.js` 作为插件式注册表。每个智能体提供 `id`、`name`、可选 `description`/`aliases` 和 `handler(ctx)`；`POST /api/chat` 按 id、名称或别名解析。内置插件在路由加载时注册，handler 通过统一的流式管道输出 Vercel AI SDK data stream。

新增插件必须保持领域层依赖方向，不直接绕过路由/存储约束；管理 registry（工具/工作流）仍由 `/api/management/*` 单独管理。

## 后果

扩展智能体无需修改统一分发协议，别名兼容已有前端。插件注册是进程内状态，若未来需要多实例动态发现，应引入版本化配置或外部 registry，并处理启动顺序与一致性。
