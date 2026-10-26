import assert from 'node:assert/strict'
import test from 'node:test'
import { interruptionReason, shouldInterruptInterviewAnswer, shortcutGenerationInput, waitForInterruptedRequests } from '../src/main/interview-interruptions'
import { generateInput } from '../src/main/validation'
import type { Answer, TranscriptTurn } from '../src/shared/types'

const original: TranscriptTurn = { id: 'original', sessionId: 'interview', channel: 'system', text: 'Find the shortest path.', timestamp: 100 }
const turn = (patch: Partial<TranscriptTurn> = {}): TranscriptTurn => ({ ...original, id: 'twist', text: 'Now assume the edges have weights.', timestamp: 300, ...patch })
const answer = (patch: Partial<Answer> = {}): Answer => ({ id: 'answer', requestId: 'request', sessionId: 'interview', action: 'solve', prompt: '', text: 'Use BFS with a queue.', model: 'fixture', status: 'streaming', createdAt: 200, context: { transcriptIds: ['original'], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false }, ...patch })

test('a new finalized chosen-source requirement interrupts an older interview answer', () => {
  for (const action of ['solve', 'design', 'debug', 'reply', 'behavioral', 'review'] as const) assert.equal(shouldInterruptInterviewAnswer(answer({ action }), turn(), 'system', [original]), true)
  assert.equal(shouldInterruptInterviewAnswer(answer(), turn({ timestamp: 150 }), 'system', [original]), true, 'a question already beginning during request preparation is still new evidence')
})

test('wrong source, foreign session, original question, partials and empty finals cannot interrupt', () => {
  for (const next of [turn({ channel: 'microphone' }), turn({ sessionId: 'other' }), original, turn({ provisional: true }), turn({ text: ' …?! ' }), turn({ timestamp: NaN }), turn({ timestamp: 50 })]) assert.equal(shouldInterruptInterviewAnswer(answer(), next, 'system', [original]), false)
  const includesPartial = answer({ context: { ...answer().context!, transcriptIds: ['original', 'twist'] } })
  assert.equal(shouldInterruptInterviewAnswer(includesPartial, turn(), 'system', [original]), false, 'finalizing speech already represented in the request is not a new question')
})

test('a retried provider item with the represented words cannot interrupt but changed constraints can', () => {
  for (const text of ['Find the shortest path.', ' find  the\nshortest PATH. ']) {
    assert.equal(shouldInterruptInterviewAnswer(answer(), turn({ id: 'provider-retry', text }), 'system', [original]), false)
  }
  assert.equal(shouldInterruptInterviewAnswer(answer(), turn({ text: 'Find the shortest path with weighted edges.' }), 'system', [original]), true)
  assert.equal(shouldInterruptInterviewAnswer(answer(), turn({ text: 'Find the longest path.' }), 'system', [original]), true)
})

test('frozen represented references still reject duplicate source text when transcript history was trimmed', () => {
  const current = answer({ transcriptReferences: [{ label: 'S1', turnId: 'original', channel: 'system', timestamp: 100, text: original.text }] })
  assert.equal(shouldInterruptInterviewAnswer(current, turn({ text: 'FIND THE SHORTEST PATH.' }), 'system', []), false)
  assert.equal(shouldInterruptInterviewAnswer(current, turn(), 'system', []), true)
  assert.equal(shouldInterruptInterviewAnswer(current, turn({ timestamp: 150 }), 'system', []), true, 'frozen source timestamps preserve the same new-evidence watermark after transcript trimming')
  const otherSource = answer({ transcriptReferences: [{ label: 'M1', turnId: 'original', channel: 'microphone', timestamp: 100, text: original.text }] })
  assert.equal(shouldInterruptInterviewAnswer(otherSource, turn({ text: original.text }), 'system', []), true)
})

test('a screenshot-only answer uses request time to reject older delayed speech', () => {
  const current = answer({ context: { ...answer().context!, transcriptIds: [] } })
  assert.equal(shouldInterruptInterviewAnswer(current, turn({ timestamp: 190 }), 'system', []), false)
  assert.equal(shouldInterruptInterviewAnswer(current, turn({ timestamp: 201 }), 'system', []), true)
})

test('new question cannot cancel notes/drafts or already terminal responses', () => {
  for (const action of ['notes', 'draft', 'recap'] as const) assert.equal(shouldInterruptInterviewAnswer(answer({ action }), turn(), 'system', [original]), false)
  for (const status of ['complete', 'cancelled', 'failed'] as const) assert.equal(shouldInterruptInterviewAnswer(answer({ status }), turn(), 'system', [original]), false)
})

test('interruption reasons and explicit takeover requests accept only supported shapes', () => {
  assert.deepEqual(interruptionReason({ type: 'interview-interruption', reason: 'new-question', transcriptId: 'twist' }), { type: 'interview-interruption', reason: 'new-question', transcriptId: 'twist' })
  for (const value of [undefined, 'new-question', {}, { type: 'interview-interruption', reason: 'provider-error' }]) assert.equal(interruptionReason(value), undefined)
  assert.equal(generateInput({ sessionId: 'interview', action: 'reply', replaceActive: true }).replaceActive, true)
  assert.throws(() => generateInput({ sessionId: 'interview', action: 'reply', replaceActive: 'true' }))
})

test('manual takeover waits for transport disposal and rejects a stalled cancellation promptly', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let completed = false
  const waiting = waitForInterruptedRequests([pending], 100).then(() => { completed = true })
  await Promise.resolve(); assert.equal(completed, false)
  finish(); await waiting; assert.equal(completed, true)
  await assert.rejects(waitForInterruptedRequests([new Promise<void>(() => {})], 10), /still stopping/)
})

test('the unfocused global Reply shortcut takes over an interview using the latest spoken context', () => {
  assert.deepEqual(shortcutGenerationInput({ id: 'interview', mode: 'interview' }, 'reply', ['old-screen']), {
    sessionId: 'interview', action: 'reply', prompt: '', attachmentIds: [], replaceActive: true,
  })
})

test('meeting Reply and other interview shortcuts keep their existing image selection and request ownership', () => {
  const selected = ['screen']
  for (const [mode, action] of [['meeting', 'reply'], ['interview', 'solve'], ['interview', 'assist']] as const) {
    const input = shortcutGenerationInput({ id: 'session', mode }, action, selected)
    assert.deepEqual(input, { sessionId: 'session', action, prompt: '', attachmentIds: ['screen'] })
    input.attachmentIds?.push('different')
    assert.deepEqual(selected, ['screen'])
  }
})
