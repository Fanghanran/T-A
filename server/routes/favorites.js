import { Router } from 'express'
import { addFavorite, listFavorites, deleteFavorite } from '../lib/sessionStore.js'
import { jsonLimits } from './shared.js'

/**
 * routes/favorites —— 收藏夹 / 错题本（跨会话的个人复习集，owner 隔离）
 *
 * POST   /api/favorites        {sessionId?, messageId?, title?, content} → {id}
 * GET    /api/favorites        列表（新→旧，limit ≤ 500）
 * DELETE /api/favorites/:id    删除（仅本人）
 */

const favoritesRouter = Router()

favoritesRouter.post('/api/favorites', jsonLimits.small, (req, res) => {
  try {
    const body = req.body ?? {}
    const r = addFavorite(req.principal.userId, {
      sessionId: body.sessionId,
      messageId: body.messageId,
      title: body.title,
      content: body.content,
    })
    res.status(201).json(r)
  } catch (err) {
    res.status(400).json({ message: err.message })
  }
})

favoritesRouter.get('/api/favorites', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  res.json({ items: listFavorites(req.principal.userId, limit) })
})

favoritesRouter.delete('/api/favorites/:id', (req, res) => {
  const ok = deleteFavorite(req.params.id, req.principal.userId)
  if (!ok) return res.status(404).json({ message: '收藏不存在' })
  res.status(204).end()
})

export default favoritesRouter
