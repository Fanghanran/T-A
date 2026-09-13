import { Router } from 'express'
import { studyStats } from '../lib/sessionStore.js'

/**
 * routes/study —— 学习进度与薄弱项统计（功能 3，owner 隔离）
 *
 * GET /api/study/stats → { sessions, messages, byAgent, activity, favorites,
 *                          avgScore, evaluatedCount, topIssues, lowQuestions, startedAt }
 * 数据全部来自会话库聚合（sessions/messages/reflection_log/favorites 按 owner JOIN）。
 */

const studyRouter = Router()

studyRouter.get('/api/study/stats', (req, res) => {
  try {
    res.json(studyStats(req.principal.userId))
  } catch (err) {
    res.status(503).json({ message: err.message })
  }
})

export default studyRouter
