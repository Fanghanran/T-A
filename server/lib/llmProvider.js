/**
 * llmProvider —— LLM provider 单例工厂
 *
 * 依赖层：L0（仅依赖 config）
 *
 * 统一 4 处重复的 LLM provider 创建逻辑（原 llm.js / docProcessor.js /
 * queryRewriter.js / docWorkflowShared.js 各有一份完全相同的实现）。
 * 所有调用者共享同一 provider 实例，减少内存占用。
 */

import { createOpenAI } from '@ai-sdk/openai'
import { llmConfig } from './config.js'

/** @type {import('ai').LanguageModel | null} */
let _model = null

/**
 * 获取缓存的 chat model 实例。首次调用时创建并缓存。
 *
 * @returns {import('ai').LanguageModel}
 */
export function getChatModel() {
  if (_model) return _model
  const opts = { apiKey: llmConfig.apiKey }
  if (llmConfig.baseUrl) opts.baseURL = llmConfig.baseUrl
  const openai = createOpenAI(opts)
  _model = openai.chat(llmConfig.model)
  return _model
}

/**
 * 重置缓存的 model 实例（测试用，或配置热更新后需要重建 provider）。
 */
export function resetChatModel() {
  _model = null
}
