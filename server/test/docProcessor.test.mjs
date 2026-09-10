/**
 * docProcessor Q&A 结构化解析单测 —— parseQaQuestion（2026-09-06 双向量索引改造）
 *
 * 场景：一问一答语料（如面试题库）切片正文自带「问：xxx」行，
 * 直接解析取用作为 question_vector 检索锚点，跳过 LLM 假设问题生成。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQaQuestion } from '../lib/docProcessor.js'

test('parseQaQuestion 提取「问：」行（中文冒号）', () => {
  const text = '问：Python中list与元组的区别是什么？\n答：list是可变序列，元组是不可变序列。'
  assert.equal(parseQaQuestion(text), 'Python中list与元组的区别是什么？')
})

test('parseQaQuestion 提取「问:」行（英文冒号）', () => {
  assert.equal(parseQaQuestion('问:英文冒号的问题？\n答:内容'), '英文冒号的问题？')
})

test('parseQaQuestion 兼容 Q:/q: 前缀', () => {
  assert.equal(parseQaQuestion('Q: what is a closure?\nA: ...'), 'what is a closure?')
  assert.equal(parseQaQuestion('q: lowercase prefix question?'), 'lowercase prefix question?')
})

test('parseQaQuestion 行首空白容忍（空格/Tab 缩进）', () => {
  assert.equal(parseQaQuestion('  问：缩进的问题行？'), '缩进的问题行？')
  assert.equal(parseQaQuestion('\tQ:\ttab indented question?'), 'tab indented question?')
})

test('parseQaQuestion 问句在中间行：跳过前置说明取第一个问行', () => {
  const text = '前置说明文字。\n问：中间的问题？\n答：答案内容。'
  assert.equal(parseQaQuestion(text), '中间的问题？')
})

test('parseQaQuestion 多个问行只取第一个', () => {
  const text = '问：第一个问题？\n答：答案。\n问：第二个问题？'
  assert.equal(parseQaQuestion(text), '第一个问题？')
})

test('parseQaQuestion 无问行返回 null（走 LLM 标注兜底）', () => {
  assert.equal(parseQaQuestion('答：只有答案没有问题。'), null)
  assert.equal(parseQaQuestion('普通讲义正文，没有问答标记。'), null)
  assert.equal(parseQaQuestion(''), null)
})

test('parseQaQuestion 问题过短（<4 字）视为噪音返回 null', () => {
  assert.equal(parseQaQuestion('问：abc'), null) // 3 字符
  assert.equal(parseQaQuestion('问：abcd'), 'abcd') // 恰好 4 字符有效
})

test('parseQaQuestion 非字符串输入返回 null', () => {
  assert.equal(parseQaQuestion(null), null)
  assert.equal(parseQaQuestion(undefined), null)
  assert.equal(parseQaQuestion(123), null)
})

test('parseQaQuestion 行中「问：」不匹配（仅行首）', () => {
  // 冒号出现在行中间不算问句行（^ 锚定多行模式的行首）
  const text = '有人问：这不算问句行。\n答：内容。'
  assert.equal(parseQaQuestion(text), null)
})
