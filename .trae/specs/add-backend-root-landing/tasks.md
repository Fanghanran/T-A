# Tasks
- [x] Task 1: 新增 GET `/` 根路由，返回服务信息 JSON
  - [x] 复用 `llmMode`/`embeddingMode` 与 `store.stats()`，附加端点列表数组
  - [x] 放在路由区顶部（健康检查附近）
- [x] Task 2: 新增 404 兜底中间件
  - [x] 置于所有路由之后、错误处理中间件之前
  - [x] 返回 `{ message: "未找到该路由", path: req.path }`
- [x] Task 3: 重启后端并验证
  - [x] `curl http://localhost:3000/` 返回 200 JSON 含服务信息
  - [x] `curl http://localhost:3000/api/unknown` 返回 404 JSON
  - [x] 确认 `/api/health` 等既有端点仍正常

# Task Dependencies
- Task 2 依赖 Task 1（顺序在同一文件，先根路由再兜底）
- Task 3 依赖 Task 1、Task 2
