// P0 记忆激活：对全部历史会话补跑轮末记忆处理（滚动摘要 + 长期事实提炼）
// 逻辑与 chat.js 回答落库后的 onTurnEnd 完全一致，只是由脚本批量触发。
import * as memoryService from './lib/memoryService.js'
import * as sessionStore from './lib/sessionStore.js'
import { tunables } from './lib/tunables.js'

console.log('memory.enabled =', tunables.memory?.enabled)

const sessions = sessionStore.listSessions({ ownerId: 'local' })
const list = sessions.items ?? sessions
console.log('会话总数:', list.length)

// 逐会话触发（fire-and-forget → 这里手动等待队列排空）
for (const s of list) {
  const n = memoryService.onTurnEnd({ sessionId: s.id, agentName: s.agentName, ownerId: 'local' })
  if (n) await n
  console.log('已触发:', s.id, s.title ?? '')
}

// 轮询 kb_memory 条数直到稳定（提炼走 qwen3:14b，逐会话串行需等待）
import { listMemories } from './lib/milvusStore.js'
let last = -1, stable = 0
for (let i = 0; i < 60 && stable < 3; i++) {
  await new Promise((r) => setTimeout(r, 4000))
  const rows = await listMemories({ filter: 'mem_id != ""', limit: 1000 })
  const n = rows?.length ?? 0
  if (n === last) stable++
  else { stable = 0; last = n }
  console.log(`kb_memory: ${n} 条`)
}
console.log(last > 0 ? `✅ 记忆激活完成：${last} 条长期事实` : '⚠️ 未产生事实（各会话增量用户轮均不足或提炼为空）')
process.exit(0)
