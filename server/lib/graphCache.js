/**
 * graphCache —— 知识网络图响应缓存（manager.js 读，vectorStoreV3 写失效）
 *
 * 独立成模块避免 manager ↔ vectorStoreV3 循环导入：
 * 缓存键 `${ownerId}|${threshold}|${topK}`，值为 { data, ts, rebuilding? }。
 * 文档切片/向量变更（reindex、上传、编辑、删除）后必须调用 invalidateGraphCache()，
 * 否则 5 分钟 TTL 内前端会继续拿到旧行数的图（实测教训：reindex 后图仍显示 0 边）。
 */

const graphCache = new Map()

/** 数据变更后清空全部图缓存（全清而非按 key：变更影响所有阈值组合） */
export function invalidateGraphCache() {
  graphCache.clear()
}

export default graphCache
