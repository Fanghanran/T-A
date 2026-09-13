/**
 * reflection —— 回答质量反思评估（P1 / L4 领域编排）
 *
 * 职责：RAG 回答生成后做零成本快信号评估，产出 0~100 分与缺陷列表，
 *       结果由调用方（routes/chat.js onAssistantDone）落 reflection_log。
 *
 * v1 范围：仅评估 + 记录 + 低分显式告警（Fail-Fast）；
 *          检索端低置信补救已由 unifiedSearch 的 HyDE 级联承担（hyde.minScore），
 *          生成后的自动重生成涉及 SSE 协议扩展，留待 v2 单独设计。
 *
 * 失败语义：评估为纯同步启发式，无 IO、无 LLM 调用，不引入新的失败面。
 */
import { childLogger } from './logger.js'
import { tunables } from './tunables.js'

const log = childLogger('reflection')

/** 兜底/拒答话术模板：命中视为模型自认「知识库不足以回答」 */
const FALLBACK_PATTERNS = [
  /知识库(中|里)?(没有|未|找不到)/,
  /(没有|未)(找到|提及|检索到)(相关|对应|可用)/,
  /无法(回答|确定|提供)/,
  /根据(现有|提供的)(资料|片段)(无法|不足以)/,
  /抱歉.{0,6}(没有|无法)/,
]

/**
 * 评估一次 RAG 回答的质量（快信号启发式，零 IO 成本）。
 * @param {{question: string, answer: string, top1Score?: number|null, citations?: number, ragExpected?: boolean}} p
 *   - top1Score：引用卡片里最高切片相似度（来自 search_results annotation）
 *   - citations：引用切片条数
 *   - ragExpected：回答是否来自 RAG 检索路径（存在 search_results 注解即为 true）；
 *     纯对话智能体（defaultChat 等）不走检索，零引用属正常，不参与引用类扣分
 * @returns {{score: number, action: 'pass'|'low_confidence', issues: string[]}}
 */
export function evaluateAnswer({ question, answer, top1Score, citations, ragExpected }) {
  const text = String(answer ?? '')
  const issues = []
  let score = 100

  // 信号 1：兜底话术 —— 模型明确承认知识不足，是最高权重的低置信信号
  const hitFallback = FALLBACK_PATTERNS.some((re) => re.test(text))
  if (hitFallback) {
    score -= 45
    issues.push('模型输出兜底/拒答话术，知识库未覆盖该问题')
  }

  // 信号 2/3：引用类信号仅对 RAG 回答生效（纯对话回答零引用属正常）
  const citeCount = Number.isFinite(citations) ? citations : 0
  if (ragExpected) {
    if (citeCount === 0 && text.length > 60) {
      score -= 30
      issues.push('回答无任何引用切片支撑（可能走了无检索直答路径）')
    }

    // 信号 3：top1 相似度低于 HyDE 级联阈值 —— 检索本身就没能找到相近内容
    const minTop1 = Number(tunables.reflection?.minTop1) || 0.45
    if (Number.isFinite(top1Score) && top1Score < minTop1) {
      score -= 25
      issues.push(`最高引用相似度 ${top1Score.toFixed(3)} 低于阈值 ${minTop1}`)
    }
  }

  // 信号 4：答案过短（排除追问/寒暄类短问题）
  if (text.length < 30 && String(question ?? '').length >= 10) {
    score -= 20
    issues.push('答案过短，信息量不足')
  }

  score = Math.max(0, Math.min(100, score))
  const action = score < 60 ? 'low_confidence' : 'pass'
  if (action === 'low_confidence') {
    // Fail-Fast：低置信必须显式可见，不允许静默
    log.warn(`低置信回答（score=${score}）：${String(question ?? '').slice(0, 60)} | ${issues.join('; ')}`)
  }
  return { score, action, issues }
}
