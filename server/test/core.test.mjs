import test from 'node:test'
import assert from 'node:assert/strict'
import { cosineSimilarity } from '../lib/mathUtils.js'
import { stripToJson } from '../lib/textUtils.js'
import { TtlLruCache } from '../lib/cache.js'
import { agentRegistry } from '../lib/agents/agentRegistry.js'
import {
  splitSentences,
  splitByDelimiter,
  mergeShortChunks,
  enforceHardMax,
  attachContext,
  splitDocumentIntoChunks,
} from '../lib/chunker.js'

test('mathUtils handles cosine vectors and invalid boundaries', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([], []), 0)
  assert.equal(cosineSimilarity([1], [1, 2]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
})

test('textUtils extracts JSON and safely handles empty input', () => {
  assert.equal(stripToJson('prefix ```json\n[{"a":1}]\n``` suffix'), '[{"a":1}]')
  assert.equal(stripToJson('说明文字 {"ok":true} 结尾'), '{"ok":true}')
  assert.equal(stripToJson(''), '[]')
  assert.equal(stripToJson(null), '[]')
})

test('TtlLruCache supports LRU, byte eviction, expiry and clear', async () => {
  const cache = new TtlLruCache({ maxEntries: 2, ttlMs: 0, sizeOf: () => 1 })
  cache.set('a', 1).set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  cache.clear()
  assert.equal(cache.get('a'), undefined)
  cache.close()

  const expiring = new TtlLruCache({ ttlMs: 10, cleanupIntervalMs: 1000 })
  expiring.set('x', 1, 5)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(expiring.get('x'), undefined)
  expiring.close()
})

test('agent registry validates, resolves aliases, lists and unregisters', () => {
  const id = `test-agent-${Date.now()}`
  const def = { id, name: 'Test Agent', aliases: ['ta'], handler() {} }
  assert.throws(() => agentRegistry.registerAgent({ id: 'bad' }), /must have/)
  agentRegistry.registerAgent(def)
  assert.equal(agentRegistry.resolveAgent(id), def)
  assert.equal(agentRegistry.resolveAgent('ta'), def)
  assert.ok(agentRegistry.listAgents().includes(def))
  assert.equal(agentRegistry.unregisterAgent(id), true)
  assert.equal(agentRegistry.resolveAgent('ta'), null)
  assert.equal(agentRegistry.unregisterAgent(id), false)
})

test('chunker pure helpers cover delimiters, sentence boundaries and hard limits', async () => {
  assert.deepEqual(splitSentences('第一句。第二句！'), ['第一句。', '第二句！'])
  const delimited = splitByDelimiter('A\n\nB\n\nC', '\\n\\n')
  assert.deepEqual(delimited.map((x) => x.text), ['A', 'B', 'C'])
  assert.deepEqual(mergeShortChunks([{ text: 'a' }, { text: 'long text' }], 2).map((x) => x.text), ['a\nlong text'])
  const hard = enforceHardMax([{ text: '1234567890' }], 4, 4)
  assert.ok(hard.every((x) => x.text.length <= 4))
  const contextual = attachContext([
    { text: '一。二。', _sentences: ['一。', '二。'] },
    { text: '三。四。', _sentences: ['三。', '四。'] },
  ], { contextSentences: 1 })
  assert.equal(contextual[1].preContext, '二。')
  assert.equal(contextual[0].postContext, '三。')

  const result = await splitDocumentIntoChunks('## H\n\n第一段。\n\n第二段。', {
    strategy: 'delimiter', delimiter: '\\n\\n', config: { maxChars: 100, hardMaxChars: 200, absoluteMaxChars: 2500 },
  })
  assert.equal(result.chunks.length, 3)
  assert.equal(result.sentenceVectors.length, 0)
})
