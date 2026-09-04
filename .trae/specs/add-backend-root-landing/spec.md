# 后端根路径与 404 兜底 Spec

## Why
访问 `http://localhost:3000/` 时 Express 返回默认 `Cannot GET /` 文案，缺乏服务自描述信息，不利于联调与排查。未匹配路由同样回退到该生硬的 HTML 文案。

## What Changes
- 新增 `GET /` 根路由，返回服务名、版本、健康摘要（LLM/Embedding 模式、文档/切片统计）与可用端点列表。
- 新增兜底 404 中间件，未匹配路由统一返回 JSON（替代默认 `Cannot GET` HTML）。

## Impact
- Affected code: `server/index.js`（在错误处理中间件之前插入根路由与 404 兜底）
- 无破坏性变更；既有 `/api/*` 端点不受影响

## ADDED Requirements

### Requirement: 根路径服务信息
系统 SHALL 在 `GET /` 返回 `200` 与 JSON，包含服务名、版本、当前 LLM/Embedding 模式、文档与切片计数、以及可用端点列表。

#### Scenario: 访问根路径
- **WHEN** 客户端 `GET /`
- **THEN** 响应 `200`，JSON 含 `name`、`version`、`llm`、`embedding`、`documents`、`chunks`、`endpoints`（数组）

### Requirement: 404 兜底
系统 SHALL 对未匹配的路由返回 `404` JSON，包含提示信息与请求路径，而非默认 `Cannot GET` HTML 文案。

#### Scenario: 访问未知路径
- **WHEN** 客户端访问未定义路径（如 `/api/unknown`）
- **THEN** 响应 `404`，JSON 形如 `{ "message": "未找到该路由", "path": "/api/unknown" }`
