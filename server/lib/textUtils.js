/**
 * textUtils —— 文本处理工具函数（纯计算，无外部依赖）
 *
 * 依赖层：L0（无内部依赖）
 */

/**
 * 从 LLM 原始输出里抠出最外层的 JSON 数组/对象：
 * 支持前后 ```json 包裹 / 解释文字。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripToJson(text) {
  if (typeof text !== 'string') return '[]'
  const s = text.trim()
  if (!s) return '[]'
  // 1) 优先找 ```json ... ```
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m && m[1]) return m[1].trim()
  // 2) 找最外层的 { ... } 或 [ ... ]
  const firstOpen = Math.min(
    s.indexOf('[') === -1 ? Infinity : s.indexOf('['),
    s.indexOf('{') === -1 ? Infinity : s.indexOf('{'),
  )
  const lastClose = Math.max(
    s.lastIndexOf(']'),
    s.lastIndexOf('}'),
  )
  if (firstOpen === Infinity || lastClose === -1 || lastClose < firstOpen) return s
  return s.slice(firstOpen, lastClose + 1)
}
