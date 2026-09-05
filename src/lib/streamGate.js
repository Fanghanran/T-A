/**
 * streamGate —— 前端并行流上界（M4 / ADR-008）
 *
 * 本地 Ollama 并发能力弱：不设上界的多智能体并行会排队雪崩、耗尽连接。
 * 所有聊天流（useChat 的 fetch 包装）发送前必须 tryAcquireStream()，
 * 结束（完成 / 中止 / 出错）后 releaseStream()。
 */

/** 并行流上限：本地模型场景默认 3；后续可接入管理端 tunables 在线调整 */
export const MAX_CONCURRENT_STREAMS = 3

let active = 0

/** 当前进行中的流数量 */
export function activeStreamCount() {
  return active
}

/** 占用一个流槽位；超上限返回 false（调用方应拒绝发送并提示用户） */
export function tryAcquireStream() {
  if (active >= MAX_CONCURRENT_STREAMS) return false
  active += 1
  return true
}

/** 释放一个流槽位（幂等安全：下限钳制到 0） */
export function releaseStream() {
  active = Math.max(0, active - 1)
}
