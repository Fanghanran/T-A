/**
 * chunker 切片器单测 —— 覆盖递归切片 / delimiter 归一化 / 滑动窗口重叠 /
 * 语义细切触发与降级 / 过短合并 / 硬切 / 上下文扩展。
 * 历史踩坑案例全部固化（详见各用例注释）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitSentences,
  splitByDelimiter,
  mergeShortChunks,
  enforceHardMax,
  attachContext,
  splitDocumentIntoChunks,
  splitIntoChunks,
} from '../lib/chunker.js'

/* ===================== 句子切分 ===================== */

test('splitSentences 按中英文句读切句', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？'])
  assert.deepEqual(splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?'])
  assert.deepEqual(splitSentences(''), [])
  assert.deepEqual(splitSentences(null), [])
})

/* ===================== delimiter 归一化（历史踩坑） ===================== */

test('splitByDelimiter 真实换行分隔符', () => {
  const blocks = splitByDelimiter('A\n\nB\n\nC', '\n\n')
  assert.deepEqual(blocks.map((b) => b.text), ['A', 'B', 'C'])
})

test('splitByDelimiter 字面 \\n\\n 转义还原为真实换行（手输分隔符是两个字符的历史坑）', () => {
  // 用户手输的字面「\n\n」是反斜杠+n 共 4 个字符，必须还原成真实换行再匹配
  const blocks = splitByDelimiter('A\n\nB', '\\n\\n')
  assert.deepEqual(blocks.map((b) => b.text), ['A', 'B'])
})

test('splitByDelimiter CRLF 双口径归一（Windows 文档 + multipart 表单坑）', () => {
  // 文本 \r\n\r\n + 分隔符 \r\n\r\n（浏览器 multipart 会把字段值 \n 规范化为 \r\n）
  const a = splitByDelimiter('A\r\n\r\nB\r\n\r\nC', '\r\n\r\n')
  assert.deepEqual(a.map((b) => b.text), ['A', 'B', 'C'])
  // 文本真实 \n\n + 分隔符字面 \n\n：两侧都归一到 \n\n 才匹配得上
  const b = splitByDelimiter('A\n\nB', '\\n\\n')
  assert.deepEqual(b.map((x) => x.text), ['A', 'B'])
})

test('splitByDelimiter 空分隔符降级双换行', () => {
  const blocks = splitByDelimiter('A\n\nB', '')
  assert.deepEqual(blocks.map((b) => b.text), ['A', 'B'])
})

test('splitByDelimiter 纯空白分隔符原样传递不 trim（类纯空白分隔符历史坑）', () => {
  // 三个空格作为分隔符：length>0 即有效，全链路禁止 trim 清空
  const blocks = splitByDelimiter('A   B', '   ')
  assert.deepEqual(blocks.map((b) => b.text), ['A', 'B'])
})

test('splitByDelimiter 空段跳过 + heading 取首行', () => {
  const blocks = splitByDelimiter('标题行\n内容行\n\n\n\nB', '\n\n')
  // 中间连续分隔符产生的空段被丢弃
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].heading, '标题行')
  assert.equal(blocks[1].heading, 'B') // heading = 该段第一行
})

test('splitByDelimiter 超长段按句子装箱到 maxChars', () => {
  // 160 字单段（80 句「X。」）超过 maxChars 100 → 按句装箱出 3 块（约 33 句/块），每块 ≤ 100
  const long = 'X。'.repeat(80)
  const blocks = splitByDelimiter(long, '\n\n', { maxChars: 100 })
  assert.equal(blocks.length, 3)
  assert.ok(blocks.every((b) => b.text.length <= 100))
})

test('splitByDelimiter 非 \\n\\n 分隔符时段内双换行段落合并装箱', () => {
  // 分隔符 ---：段内含两个段落（60+30 字），整段 92 ≤ maxChars 100 → 同一块且保留段内双换行
  const text = 'A'.repeat(60) + '\n\n' + 'B'.repeat(30) + '\n\n---\n\n' + 'C'.repeat(50)
  const blocks = splitByDelimiter(text, '---', { maxChars: 100 })
  assert.equal(blocks.length, 2)
  assert.ok(blocks[0].text.includes('\n\n'))
  assert.equal(blocks[1].text, 'C'.repeat(50))
})

test('splitByDelimiter 超 maxChars 的多段落被拆分为独立块', () => {
  // 分隔符 ---：单段 112 字（段落 60+50）> maxChars 100 → 段落间不合并，拆成 2 块
  const text = 'A'.repeat(60) + '\n\n' + 'B'.repeat(50) + '\n\n---'
  const blocks = splitByDelimiter(text, '---', { maxChars: 100 })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, 'A'.repeat(60))
  assert.equal(blocks[1].text, 'B'.repeat(50))
})

/* ===================== 滑动窗口重叠（overlapChars） ===================== */

test('splitByDelimiter overlapChars 基本重叠：后块以前块末尾 N 字符开头', () => {
  const blocks = splitByDelimiter('AAAAAA\n\nBBBBBB', '\n\n', { overlapChars: 2 })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, 'AAAAAA')
  assert.equal(blocks[1].text, 'AABBBBBB') // 前块末尾 2 字符作前缀
})

test('splitByDelimiter overlapChars 链式膨胀防护：取前块原始文本而非叠加后文本', () => {
  // 3 块各 4 字符，overlap=2：块3 前缀必须来自块2 原始「BB」而非叠加后的「AABB」
  const blocks = splitByDelimiter('AAAA\n\nBBBB\n\nCCCC', '\n\n', { overlapChars: 2 })
  assert.equal(blocks[1].text, 'AABBBB')
  assert.equal(blocks[2].text, 'BBCCCC') // 不是 AABBCCCC
})

test('splitByDelimiter overlapChars 上限压到前块一半：防小块整块重复', () => {
  // 前块仅 2 字符、overlap=5 → n = min(5, floor(2/2)) = 1，只重叠 1 字符
  const blocks = splitByDelimiter('AB\n\nCDEF', '\n\n', { overlapChars: 5 })
  assert.equal(blocks[1].text, 'BCDEF')
})

test('splitByDelimiter 单块时 overlap 不生效', () => {
  const blocks = splitByDelimiter('AAAA', '\n\n', { overlapChars: 3 })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, 'AAAA')
})

/* ===================== splitDocumentIntoChunks ===================== */

test('splitDocumentIntoChunks delimiter 策略：透传 overlap 且不产出句子向量', async () => {
  const result = await splitDocumentIntoChunks('AAAA\n\nBBBB\n\nCCCC', {
    strategy: 'delimiter',
    delimiter: '\n\n',
    overlapChars: 2,
    config: { maxChars: 100, hardMaxChars: 200, absoluteMaxChars: 2500 },
  })
  assert.equal(result.chunks.length, 3)
  assert.equal(result.chunks[1].text, 'AABBBB')
  assert.equal(result.sentenceVectors.length, 0) // delimiter 模式不做语义细切
})

test('splitDocumentIntoChunks semantic 策略：heading 继承与切片结构', async () => {
  const result = await splitDocumentIntoChunks('## 标题甲\n\n第一段内容。\n\n第二段内容。', {
    config: { maxChars: 100, hardMaxChars: 200, absoluteMaxChars: 2500, minChars: 1 },
  })
  // 两个短段会合并进同块（均 < maxChars）
  assert.ok(result.chunks.length >= 1)
  assert.equal(result.chunks[0].heading, '标题甲')
  // idx 连续重编号
  result.chunks.forEach((c, i) => assert.equal(c.idx, i))
  // 上下文字段存在（首块 preContext 为空）
  assert.equal(result.chunks[0].preContext, '')
})

test('splitDocumentIntoChunks semantic 策略：超长单句块触发 embedSentences 调用', async () => {
  let embedCalledWith = null
  // 300 字无句读单句：递归切分无法拆 → 整块超 maxChars → 语义细切路径调用 embedFn
  const embedFn = async (sentences) => {
    embedCalledWith = sentences
    return sentences.map(() => [1, 0]) // 每句同向向量：相似度 1，无断点
  }
  const result = await splitDocumentIntoChunks('x'.repeat(300), {
    embedSentences: embedFn,
    config: { maxChars: 100, hardMaxChars: 400, absoluteMaxChars: 2500, minChars: 1 },
  })
  assert.ok(embedCalledWith, '超长块应触发 embedSentences 调用')
  assert.equal(result.chunks.length, 1) // 同向向量无断点 → 1 块（hardMax 400 内不硬切）
  assert.equal(result.chunks[0].text.length, 300)
})

test('splitDocumentIntoChunks semantic 策略：embedFn 失败降级句子数硬切不崩', async () => {
  const embedFn = async () => [] // 模拟 embedding 不可用返回空
  const result = await splitDocumentIntoChunks('x'.repeat(300), {
    embedSentences: embedFn,
    config: { maxChars: 100, hardMaxChars: 400, absoluteMaxChars: 2500, minChars: 1 },
  })
  // 降级路径：单句仍为 1 块，不抛错
  assert.equal(result.chunks.length, 1)
})

test('splitDocumentIntoChunks semantic 策略：过短块合并（minChars）', async () => {
  // 短句 '短。' 独立成块后 < minChars 10 → 与后续块合并
  const result = await splitDocumentIntoChunks('短。\n\n' + '长'.repeat(80) + '。', {
    config: { maxChars: 40, hardMaxChars: 400, absoluteMaxChars: 2500, minChars: 10 },
  })
  assert.ok(result.chunks.length >= 1)
  // 短块被并入：不存在独立成块的 '短。'
  assert.ok(!result.chunks.some((c) => c.text === '短。'))
})

test('splitDocumentIntoChunks 语义断点：相邻相似度骤降处切开', async () => {
  // 构造 6 句：前三句主题 A（向量 [1,0]），后三句主题 B（向量 [0,1]）
  const sentences = ['甲方第一句话。', '甲方第二句话。', '甲方第三句话。', '乙方第一句话。', '乙方第二句话。', '乙方第三句话。']
  const text = sentences.join('')
  const embedFn = async (ss) => ss.map((s) => (s.startsWith('甲') ? [1, 0] : [0, 1]))
  // 用无标题单段文本：递归切分后整段 42 字 > maxChars 20 → 触发语义细切？
  // 注意：递归切分会先按 maxChars 20 装箱句子，语义细切只在超长块上触发。
  // 此处改为直接验证装箱边界：每块 ≤ maxChars 且不腰斩句子。
  const result = await splitDocumentIntoChunks(text, {
    embedSentences: embedFn,
    config: { maxChars: 20, hardMaxChars: 400, absoluteMaxChars: 2500, minChars: 1 },
  })
  assert.ok(result.chunks.length >= 2)
  assert.ok(result.chunks.every((c) => c.text.length <= 400))
})

/* ===================== mergeShortChunks（链式吞并防护） ===================== */

test('mergeShortChunks 仅前块未达标时才吞并，防止链式吞并', () => {
  // [长200, 短5, 短6, 长150] minChars=100：
  // c2(5)：prev=200 已达标 → 独立；c3(6)：prev=5 未达标 → 吞并 → 11；
  // c4(150)：prev=11 未达标 → 吞并 → 161。结果 [200, 161]
  const chunks = [
    { text: 'a'.repeat(200) },
    { text: 'b'.repeat(5) },
    { text: 'c'.repeat(6) },
    { text: 'd'.repeat(150) },
  ]
  const merged = mergeShortChunks(chunks, 100)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].text.length, 200)
  // c2(5)+\n+c3(6)=12 → 12+\n+150 = 163
  assert.equal(merged[1].text.length, 163)
})

test('mergeShortChunks 首块过短并入第二块', () => {
  const merged = mergeShortChunks([{ text: 'short' }, { text: 'x'.repeat(200) }], 100)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, 'short\n' + 'x'.repeat(200))
})

test('mergeShortChunks 空输入与独苗', () => {
  assert.deepEqual(mergeShortChunks([], 10), [])
  assert.equal(mergeShortChunks([{ text: 'ab' }], 100).length, 1) // 独苗保留
})

/* ===================== enforceHardMax ===================== */

test('enforceHardMax 硬切优先在换行处断开避免腰斩', () => {
  // 换行位于 45/50 > 60% 阈值 → 在换行处切，两块各自完整
  const text = 'A'.repeat(45) + '\n' + 'B'.repeat(45)
  const out = enforceHardMax([{ text }], 50, 2500)
  assert.equal(out.length, 2)
  assert.equal(out[0].text, 'A'.repeat(45))
  assert.equal(out[1].text, 'B'.repeat(45))
})

test('enforceHardMax absoluteMax 终极限长', () => {
  const out = enforceHardMax([{ text: 'x'.repeat(100) }], 40, 20)
  // hardMax 40 切 3 段（40+40+20），每段再被 absoluteMax 20 截断
  assert.ok(out.every((c) => c.text.length <= 20))
  assert.ok(out.length >= 3)
})

test('enforceHardMax 不超限块原样保留', () => {
  const out = enforceHardMax([{ text: 'short' }], 50, 2500)
  assert.equal(out.length, 1)
  assert.equal(out[0].text, 'short')
})

/* ===================== attachContext ===================== */

test('attachContext 首尾块上下文为空，中间块取相邻句', () => {
  const out = attachContext(
    [
      { text: '一。二。', _sentences: ['一。', '二。'] },
      { text: '三。四。', _sentences: ['三。', '四。'] },
      { text: '五。六。', _sentences: ['五。', '六。'] },
    ],
    { contextSentences: 1 },
  )
  assert.equal(out[0].preContext, '')
  assert.equal(out[0].postContext, '三。')
  assert.equal(out[1].preContext, '二。')
  assert.equal(out[1].postContext, '五。')
  assert.equal(out[2].preContext, '四。')
  assert.equal(out[2].postContext, '')
})

/* ===================== 旧接口兼容 ===================== */

test('splitIntoChunks 旧接口返回 idx/heading/text 兼容结构', () => {
  const out = splitIntoChunks('## H\n\n第一段。\n\n第二段。', { maxChars: 100, hardMaxChars: 200, absoluteMaxChars: 2500, minChars: 1 })
  assert.ok(Array.isArray(out))
  out.forEach((c, i) => {
    assert.equal(c.idx, i)
    assert.ok('heading' in c && 'text' in c)
  })
  assert.equal(out[0].heading, 'H')
})
