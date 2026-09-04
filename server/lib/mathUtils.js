/**
 * mathUtils —— 数学工具函数（纯计算，无外部依赖）
 *
 * 依赖层：L0（无内部依赖）
 */

/**
 * 余弦相似度（等长数值向量；空向量、非数组或长度不等返回 0）
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}
