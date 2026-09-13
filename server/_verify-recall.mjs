// 召回验证：新会话 query 应能命中 kb_memory 里的既有事实（P0 验收）
import { recall, buildMemoryBlock } from './lib/memoryService.js'

const r = await recall({ sessionId: 'sess_nonexistent_new', agentName: 'defaultChat', query: '张三有哪些工作经验？他会什么技术栈？', ownerId: 'local' })
console.log('召回事实数:', r.facts.length)
for (const f of r.facts) console.log(`  [${f.scope}] score=${f.score?.toFixed?.(3) ?? f.score} ${String(f.text).slice(0, 50)}`)
const block = buildMemoryBlock({ summary: r.summary, facts: r.facts })
console.log('--- memoryBlock 注入内容（前 300 字）---')
console.log(block.slice(0, 300))
process.exit(r.facts.length > 0 ? 0 : 1)
