import { Router } from 'express'
import * as questionBank from '../lib/questionBank.js'

/**
 * routes/interview —— 结构化面试题库
 *
 * 端点：
 *  - GET    /api/interview/stats           题库统计
 *  - GET    /api/interview/questions       题目列表（?category/difficulty 过滤）
 *  - POST   /api/interview/questions       录入题目
 *  - DELETE /api/interview/questions/:id   删除题目
 *  - POST   /api/interview/search          结构化检索（关键词 + 技术栈加权）
 *
 * 依赖：questionBank（JSON 题库，读写唯一数据源）。
 */

export const interviewRouter = Router()

interviewRouter.get('/api/interview/stats', (_req, res) => res.json(questionBank.stats()))

interviewRouter.get('/api/interview/questions', (req, res) => {
  const { category, difficulty } = req.query
  res.json({ items: questionBank.listQuestions({ category, difficulty }) })
})

// 录入题目：questionBank.addQuestion 此前已实现但从未被任何路由调用，
// 导致题库既无种子数据、也无录入入口（双路召回里题库一路恒为 0 条）。
interviewRouter.post('/api/interview/questions', (req, res, next) => {
  try {
    const b = req.body ?? {}
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) return res.status(400).json({ message: 'title 必填' })
    const q = questionBank.addQuestion({
      title,
      category: b.category,
      tags: Array.isArray(b.tags) ? b.tags : [],
      difficulty: b.difficulty,
      company: Array.isArray(b.company) ? b.company : [],
      source: b.source,
      answer: b.answer,
      analysis: b.analysis,
    })
    res.status(201).json(q)
  } catch (e) {
    next(e)
  }
})

interviewRouter.delete('/api/interview/questions/:id', (req, res, next) => {
  try {
    const ok = questionBank.deleteQuestion(req.params.id)
    if (!ok) return res.status(404).json({ message: '题目不存在' })
    res.status(204).end()
  } catch (e) {
    next(e)
  }
})

interviewRouter.post('/api/interview/search', (req, res, next) => {
  try {
    const { q, techStack, difficulty, company, tag, limit = 5 } = req.body ?? {}
    const t0 = performance.now()
    const results = questionBank.search(q ?? '', {
      techStack: Array.isArray(techStack) ? techStack : [],
      difficulty,
      company,
      tag,
      limit: Math.max(1, Math.min(20, Number(limit) || 5)),
    })
    const searchMs = Math.round(performance.now() - t0)
    res.json({ searchMs, total: results.length, results })
  } catch (err) {
    next(err)
  }
})
