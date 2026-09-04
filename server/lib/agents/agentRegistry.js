/**
 * agentRegistry —— 插件式智能体注册表（L5：纯数据结构，无领域依赖）
 *
 * 每个 agent def：
 *   { id: string, name: string, description: string,
 *     aliases: string[], handler(ctx): ReadableStream }
 *
 * ctx 由调用方（routes/chat）构造：
 *   { query, history, techStack, sessionId, onAssistantDone,
 *     req, res, pipeStream, dbg, ... }
 *
 * API:
 *   registerAgent(def)      注册智能体（按 id 存储，按 name + aliases 建索引）
 *   unregisterAgent(id)     注销智能体（清索引）
 *   resolveAgent(name)      按 id / name / alias 查找，返回 def 或 null
 *   listAgents()            返回全部已注册 def 数组
 */

const agents = new Map()
const aliasIndex = new Map()

export const agentRegistry = {
  /**
   * 注册智能体定义。
   * @param {{ id: string, name: string, description?: string, aliases?: string[], handler: Function }} def
   */
  registerAgent(def) {
    if (!def?.id || !def?.name || typeof def.handler !== 'function') {
      throw new Error('registerAgent: def must have id, name, and handler')
    }
    agents.set(def.id, def)
    // 按 name 建索引
    aliasIndex.set(def.name, def.id)
    // 按 aliases 建索引
    if (Array.isArray(def.aliases)) {
      for (const alias of def.aliases) {
        aliasIndex.set(alias, def.id)
      }
    }
  },

  /**
   * 注销智能体。
   * @param {string} id
   * @returns {boolean}
   */
  unregisterAgent(id) {
    const def = agents.get(id)
    if (!def) return false
    agents.delete(id)
    if (aliasIndex.get(def.name) === id) aliasIndex.delete(def.name)
    if (Array.isArray(def.aliases)) {
      for (const alias of def.aliases) {
        if (aliasIndex.get(alias) === id) aliasIndex.delete(alias)
      }
    }
    return true
  },

  /**
   * 按 id / name / alias 解析智能体。
   * @param {string} name
   * @returns {object|null}
   */
  resolveAgent(name) {
    // 直接 id 命中
    if (agents.has(name)) return agents.get(name)
    // name / alias 命中
    const id = aliasIndex.get(name)
    if (id) return agents.get(id) ?? null
    return null
  },

  /**
   * 返回全部已注册智能体定义。
   * @returns {object[]}
   */
  listAgents() {
    return [...agents.values()]
  },
}
