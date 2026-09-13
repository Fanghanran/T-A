/**
 * routes/agents —— 前端智能体注册表数据源（P1）
 *
 * GET /api/agents
 *   登录即可（/api 全局守卫已要求有效用户）；返回 enabled 的 Agent Spec 精简集 +
 *   version（max(updated_at)），前端据此判断是否需要重建本地注册表。
 *   不暴露 systemPrompt / modelRole 等执行层字段。
 */

import { Router } from 'express'
import { listForFrontend, version } from '../lib/agents/agentStore.js'

export const agentsRouter = Router()

agentsRouter.get('/api/agents', (_req, res) => {
  try {
    res.json({ version: version(), items: listForFrontend() })
  } catch (err) {
    res.status(503).json({ message: err.message })
  }
})
