/**
 * resume-analysis 智能体（L4 领域层）
 *
 * 能力：上传/粘贴简历 → 结构化解析 + 优化建议 +（可选）岗位 JD 匹配打分 + 基于简历生成面试题。
 * 简历正文来源：ctx.req.body.resumeText（前端上传解析得到），或退化用 query（用户直接粘贴）。
 * JD 来源：ctx.req.body.jd。输出走 streamResumeAnalyze（单次 JSON → resume_report 卡片）。
 */
import { streamResumeAnalyze } from '../../llm.js'

export const resumeAnalysisAgent = {
  id: 'resume-analysis',
  name: 'resume-analysis',
  description: '简历分析：解析 + 优化建议 + JD 匹配 + 基于简历出题 + 结构化评分卡',
  aliases: ['简历分析'],

  async handler(ctx) {
    const { query, req, res, sessionId, onAssistantDone, pipeStream, dbg, agentId, signal } = ctx
    const body = req.body ?? {}
    const hasResumeText = typeof body.resumeText === 'string' && body.resumeText.trim()
    const resumeText = hasResumeText ? body.resumeText : query
    // JD：优先显式 body.jd；否则若已上传简历正文，则把用户消息视为 JD/目标岗位（正文与消息分离）
    const jd = typeof body.jd === 'string' && body.jd.trim()
      ? body.jd
      : (hasResumeText ? (query || '') : '')

    dbg(`[resume-analysis] resumeText=${(resumeText || '').length}字 | jd=${jd ? jd.length + '字' : '无'}`)
    return pipeStream(
      res,
      await streamResumeAnalyze({ resumeText, jd, query, agentId, signal }),
      { sessionId, onAssistantText: onAssistantDone },
    )
  },
}
