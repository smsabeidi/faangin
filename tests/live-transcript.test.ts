import assert from 'node:assert/strict'
import test from 'node:test'
import { clearPartials, revisePartial, type PartialTurn } from '../src/renderer/src/live-transcript'

const mic: PartialTurn = { sessionId: 'first', channel: 'microphone', itemId: 'one', text: 'An unfinished question' }
const system: PartialTurn = { sessionId: 'first', channel: 'system', itemId: 'two', text: 'Another source' }
const other: PartialTurn = { sessionId: 'second', channel: 'microphone', itemId: 'one', text: 'A separate session' }

test('partial revisions replace one item and an empty final removes its provisional display', () => {
  const original = revisePartial({}, mic)
  const revised = revisePartial(original, { ...mic, text: 'Revised speech' })
  assert.equal(Object.values(original)[0].text, mic.text)
  assert.equal(Object.values(revised).length, 1)
  assert.equal(Object.values(revised)[0].text, 'Revised speech')
  assert.deepEqual(revisePartial(revised, { ...mic, text: '  ' }), {})
})

test('fresh capture clears that session without carrying retired speech into its new generation', () => {
  const cache = [mic, system, other].reduce(revisePartial, {})
  assert.deepEqual(Object.values(clearPartials(cache, 'first')), [other])
  assert.equal(Object.values(cache).length, 3)
  const restarted = revisePartial(clearPartials(cache, 'first'), { ...mic, text: 'New capture' })
  assert.deepEqual(Object.values(restarted).map(turn => turn.text), [other.text, 'New capture'])
})

test('source release clears only its own provisional speech while an independent source continues', () => {
  const cache = [mic, system, other].reduce(revisePartial, {})
  assert.deepEqual(Object.values(clearPartials(cache, 'first', 'microphone')), [system, other])
  assert.deepEqual(clearPartials(cache, 'missing', 'microphone'), cache)
})
