# ADR-001：管理 API 采用令牌认证与显式 CORS

## 状态

已接受（2026-08-31）

## 背景

服务包含可修改工具、工作流、审计和 tunables 的 `/api/management/*` 接口。浏览器前端还需要跨源配置，但生产环境不能默认开放任意 Origin。

## 决策

- 通过 `AUTH_MODE=token` 和 `ADMIN_TOKEN` 保护管理 API，支持 `Authorization: Bearer <token>` 或 `x-admin-token`。
- `AUTH_MODE=disabled` 仅用于本地开发；生产环境必须设置令牌。
- 通过 `CORS_ORIGINS` 配置逗号分隔的精确 Origin 白名单。生产环境未配置白名单时拒绝跨源浏览器请求。
- 所有请求继续使用安全响应头与 `x-request-id` 追踪。

## 后果

管理端点具备明确的最小认证边界，部署者必须通过密钥管理系统注入令牌。CORS 变更需要同步部署配置；本地同源或 `http://localhost:5173` 开发不受影响。
