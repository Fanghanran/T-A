# Checklist
- [x] `GET /` 返回 200，JSON 含 `name`/`version`/`llm`/`embedding`/`documents`/`chunks`/`endpoints`
- [x] 未匹配路径返回 404 JSON `{ message, path }`，不再出现 `Cannot GET` HTML
- [x] `/api/health`、`/api/knowledge/documents`、`/api/chat` 等既有端点行为不受影响
- [x] 根路由与 404 中间件位于错误处理中间件之前
