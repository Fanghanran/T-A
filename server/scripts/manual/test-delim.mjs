import { splitByDelimiter } from './lib/chunker.js'

// 文档段落用「单个换行」分隔（常见于 txt / 代码生成文本）
const doc = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：` + '内容'.repeat(30)).join('\n')

const r = splitByDelimiter(doc, '\n\n', { maxChars: 800 })
console.log('单换行分段 →', r.length, '块，各块字数：')
console.log(r.map((b) => b.text.length).join(', '))
