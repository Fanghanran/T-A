import { Router } from 'express'
import * as sessionStore from '../lib/sessionStore.js'
import { jsonLimits } from './shared.js'

/**
 * routes/sessions —— 会话管理
 *
 * 端点：
 *  - GET    /api/sessions        会话列表（?agentName= 过滤，按 updatedAt 倒序）
 *  - POST   /api/sessions        创建会话（{ agentName, title? }）
 *  - GET    /api/sessions/:id    会话详情 + 历史消息
 *  - PATCH  /api/sessions/:id    重命名（{ title }）
 *  - DELETE /api/sessions/:id    删除会话
 *
 * 依赖：sessionStore（SQLite 持久化，唯一数据源）。无流式逻辑。
 */

export const sessionsRouter = Router()

// 会话列表（支持按 agentName 过滤，按 updatedAt 倒序）
sessionsRouter.get('/api/sessions', (req, res) => {
  const { agentName } = req.query
  const items = sessionStore.listSessions({
    ...(typeof agentName === 'string' && agentName.trim() ? { agentName } : {}),
    ownerId: req.principal.userId,
  })
  res.json({ items, total: items.length })
})

// 创建会话
sessionsRouter.post('/api/sessions', jsonLimits.small, (req, res) => {
  const { agentName, title } = req.body ?? {}
  if (typeof agentName !== 'string' || !agentName.trim()) {
    return res.status(400).json({ message: 'agentName 必填（非空字符串）' })
  }
  const meta = sessionStore.createSession({ agentName: agentName.trim(), title, ownerId: req.principal.userId })
  res.status(201).json(meta)
})

// 会话详情 + 历史消息
sessionsRouter.get('/api/sessions/:id', (req, res) => {
  const meta = sessionStore.getSession(req.params.id, req.principal.userId)
  if (!meta) return res.status(404).json({ message: '会话不存在' })
  const messages = sessionStore.getMessages(req.params.id, req.principal.userId)
  res.json({ ...meta, messages })
})

// 重命名会话
sessionsRouter.patch('/api/sessions/:id', jsonLimits.small, (req, res) => {
  const { title } = req.body ?? {}
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ message: 'title 必填（非空字符串）' })
  }
  const meta = sessionStore.renameSession(req.params.id, title, req.principal.userId)
  if (!meta) return res.status(404).json({ message: '会话不存在' })
  res.json(meta)
})

// 删除会话
sessionsRouter.delete('/api/sessions/:id', (req, res) => {
  const ok = sessionStore.deleteSession(req.params.id, req.principal.userId)
  if (!ok) return res.status(404).json({ message: '会话不存在' })
  res.status(204).end()
})
