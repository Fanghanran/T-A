# 旧流程文档说明

> 本文件原名为 `WORKFLOW.md`，内容描述的是已不再存在的 Python/LangChain AutoGPT-Work 原型（`main.py`、`requirements.txt`、Chroma、PythonREPL 等）。当前项目已经迁移为 **React + Vite 前端、Node.js + Express 后端、Milvus 向量库、Vercel AI SDK 流式协议**，因此以下旧流程不应作为部署或开发依据。

## 当前流程入口

- 前端：根目录 `npm run dev`，入口 `src/main.jsx`，生产构建输出 `dist/`。
- 后端：`cd server && npm start`，入口 `server/index.js`，默认 `127.0.0.1:3000`。
- 向量库：根目录 `docker compose -f milvus-compose.yml up -d`。
- 聊天智能体：`server/lib/agents/agentRegistry.js`；内置插件和 `agentName` 解析见根目录 `README.md`。
- API 路由：`server/routes/`；禁止把本文件中的 Python 工具流程当作当前路由契约。

## 用户资料与历史材料

本次仅清理了本说明文件中的过时技术叙述，没有删除项目中的 `data/`、知识库文档、题库、会话数据库或其他用户资料。若需要保留 Python 原型的完整历史，请将其放入独立归档位置并明确标注“历史资料”，不要与当前 Node 服务混用。

当前架构约束、认证/CORS/限流和缓存说明以 `ARCHITECTURE.md`、`server/README.md` 及 `docs/adr/` 为准。
