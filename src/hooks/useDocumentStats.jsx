import * as React from 'react'
import { request } from '@/lib/api'
import { child } from '@/lib/logger'

const log = child('knowledge:stats')

/**
 * useDocumentStats —— 知识库 + 系统健康统计
 *
 * 数据来源 /api/health，捕获完整负载：
 *   文档/切片/分类分布（knowledgeByCategory）
 *   系统状态（llm / embedding 模式串、ok 一致性、orphanDocuments 孤儿数）
 *   会话（sessions）与面试题库（questions / byCategory）
 */
export function useDocumentStats() {
  const [stats, setStats] = React.useState({
    loaded: false,
    ok: true,
    documents: 0,
    chunks: 0,
    categories: [],
    byCategory: [],
    llm: '',
    embedding: '',
    sessions: { totalSessions: 0, totalMessages: 0 },
    questions: 0,
    questionByCategory: [],
    orphanDocuments: 0,
    updatedAt: null,
  })
  const [statsLoading, setStatsLoading] = React.useState(false)

  const loadStats = React.useCallback(async () => {
    setStatsLoading(true)
    try {
      const res = await request('/api/health')
      const byCat = Array.isArray(res?.knowledgeByCategory)
        ? res.knowledgeByCategory
        : []
      const docN = Number(res?.documents ?? 0)
      const chkN = Number(res?.chunks ?? 0)
      const next = {
        loaded: true,
        ok: res?.ok !== false,
        documents: docN,
        chunks: chkN,
        categories: byCat,
        byCategory: byCat,
        llm: typeof res?.llm === 'string' ? res.llm : '',
        embedding: typeof res?.embedding === 'string' ? res.embedding : '',
        sessions: {
          totalSessions: Number(res?.sessions?.totalSessions ?? 0),
          totalMessages: Number(res?.sessions?.totalMessages ?? 0),
        },
        questions: Number(res?.questions ?? 0),
        questionByCategory: Array.isArray(res?.byCategory) ? res.byCategory : [],
        orphanDocuments: Number(res?.orphanDocuments ?? 0),
        updatedAt: new Date().toISOString(),
      }
      setStats(next)
      return next
    } catch (e) {
      log.error('[useDocumentStats] 统计信息加载失败：', e)
      setStats((s) => ({ ...s, loaded: true }))
      return null
    } finally {
      setStatsLoading(false)
    }
  }, [])

  return { stats, statsLoading, loadStats }
}
