import * as models from './models.js'

/**
 * llmProvider —— LLM provider 获取入口（ADR-006 后为 models.js 的薄封装）
 *
 * 依赖层：L0（仅依赖 config / models）
 *
 * 兼容说明：历史上这里是「单例 chat model 工厂」，所有调用点零参 getChatModel()。
 * 现在支持可选 selector（{ role, agentId }）做三级模型解析（agent > role > 默认），
 * 未配置模型时抛 LLM_NOT_CONFIGURED（Fail-Fast，ADR-009），绝不返回假实现。
 */

/**
 * 获取 chat model 实例。
 * @param {{role?: string, agentId?: string}} [sel] 角色与智能体（用于三级解析）
 * @returns {import('ai').LanguageModel}
 */
export function getChatModel(sel) {
  return models.getChatModel(sel)
}

/**
 * 重置缓存的 model 实例（配置热更新后调用）。
 * @param {string} [profileId] 仅重置指定 profile；缺省清全部
 */
export function resetChatModel(profileId) {
  models.resetProfileCache(profileId)
}
