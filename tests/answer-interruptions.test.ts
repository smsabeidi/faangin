import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Answer } from '../src/shared/types'
import AnswerCard from '../src/renderer/src/AnswerCard'
import AnswerLatestButton from '../src/renderer/src/AnswerLatestButton'
import { answerQuestionUpdated, canRetryAnswer, latestQuestionRequest, shouldFollowAnswerUpdates } from '../src/renderer/src/answer-status'

const answer = (patch: Partial<Answer> = {}): Answer => ({ id: 'old-answer', requestId: 'old-request', sessionId: 'interview', action: 'solve', prompt: '', text: '```python\nqueue = deque([start])\n```', model: 'fixture', status: 'cancelled', createdAt: 1, ...patch })
const renderCard = (value: Answer, current = false) => renderToStaticMarkup(createElement(AnswerCard, { answer: value, copy: async () => {}, cancel: async () => {}, retry: async () => {}, current }))
const renderButton = (patch: Partial<Parameters<typeof AnswerLatestButton>[0]> = {}) => renderToStaticMarkup(createElement(AnswerLatestButton, { mode: 'interview', hasQuestion: true, working: true, busy: false, updatingQuestion: true, onClick() {}, ...patch }))

test('new speech visibly interrupts obsolete code but preserves its readable copyable partial response', () => {
  const html = renderCard(answer({ interruption: { reason: 'new-speech', transcriptId: 'updated-question', at: 2 } }))
  assert.match(html, /Interrupted — question changed/)
  assert.match(html, /Partial response kept for reference/)
  assert.match(html, /queue = deque\(\[start\]\)/)
  assert.match(html, /Copy interrupted response/)
  assert.match(html, /Copy code/)
  assert.doesNotMatch(html, /Retry this request/)
  assert.doesNotMatch(html, /Current answer/)
  assert.match(html, /data-answer-state="interrupted"/)
})

test('a manual takeover labels the previous answer as an updated question instead of a provider failure', () => {
  const html = renderCard(answer({ interruption: { reason: 'manual-takeover', at: 2 } }))
  assert.match(html, /Interrupted — updated question/)
  assert.doesNotMatch(html, /This request couldn’t finish/)
  assert.doesNotMatch(html, /Retry this request/)
})

test('the current answer is identifiable and normal cancellations or provider failures can still retry', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const value = answer({ status })
    assert.equal(canRetryAnswer(value), true)
    assert.match(renderCard(value), /Retry this request/)
  }
  const html = renderCard(answer({ id: 'new-answer', status: 'streaming', text: 'The updated constraint changes the approach.' }), true)
  assert.match(html, /Current answer/)
  assert.match(html, /data-current-answer="true"/)
  assert.match(html, /Response streaming/)
})

test('Answer latest remains enabled during manual interview generation and blocks concurrent desktop work', () => {
  const html = renderButton()
  assert.match(html, /Answer latest/)
  assert.match(html, /Stop this interview’s current response/)
  assert.doesNotMatch(html, /disabled=/)
  assert.match(renderButton({ busy: true }), /disabled=/)
  assert.match(renderButton({ hasQuestion: false }), /disabled=/)
  assert.match(renderButton({ mode: 'meeting' }), /disabled=/)
})

test('only the explicit current-interview answer action requests atomic takeover without stale screenshots', () => {
  assert.deepEqual(latestQuestionRequest('interview', ' What if edges are weighted? '), { action: 'ask', prompt: 'What if edges are weighted?', attachmentIds: [], replaceActive: true })
  assert.deepEqual(latestQuestionRequest('interview', ''), { action: 'reply', prompt: '', attachmentIds: [], replaceActive: true })
  assert.deepEqual(latestQuestionRequest('meeting', ''), { action: 'reply', prompt: '', attachmentIds: [] })
})

test('incoming and interrupted answer updates cannot scroll away from an editor or an older answer', () => {
  assert.equal(shouldFollowAnswerUpdates(true, true), false)
  assert.equal(shouldFollowAnswerUpdates(false, false), false)
  assert.equal(shouldFollowAnswerUpdates(false, true), false)
  assert.equal(shouldFollowAnswerUpdates(true, false), true)
})


test('a completed response becomes earlier context only after a new finalized selected-source question', () => {
  const value = answer({ status: 'complete', createdAt: 100, context: { transcriptIds: ['first-question'], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false } })
  const turn = { id: 'new-question', sessionId: 'interview', channel: 'system' as const, text: 'Now the edges are weighted.', timestamp: 101 }
  assert.equal(answerQuestionUpdated(value, [turn], 'system'), true)
  for (const variant of [{ ...turn, timestamp: 99 }, { ...turn, provisional: true }, { ...turn, channel: 'microphone' as const }, { ...turn, sessionId: 'different' }, { ...turn, text: '  ' }]) {
    assert.equal(answerQuestionUpdated(value, [variant], 'system'), false)
  }
  assert.equal(answerQuestionUpdated(value, [{ ...turn, channel: 'manual' }], 'system'), true)
  assert.equal(answerQuestionUpdated({ ...value, status: 'streaming' }, [turn], 'system'), false)
  assert.equal(answerQuestionUpdated({ ...value, context: undefined }, [turn], 'system'), false)
})

test('including the latest finalized question keeps the answer current even if an earlier segment was trimmed', () => {
  const value = answer({ status: 'complete', createdAt: 100, context: { transcriptIds: ['latest-question'], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: true } })
  const earlier = { id: 'trimmed-segment', sessionId: 'interview', channel: 'system' as const, text: 'An earlier segment.', timestamp: 101 }
  const latest = { ...earlier, id: 'latest-question', timestamp: 102 }
  assert.equal(answerQuestionUpdated(value, [earlier, latest], 'system'), false)
  assert.equal(answerQuestionUpdated(value, [latest, earlier], 'system'), false)
})

test('a failed earlier request cannot retry blindly after the question updates', () => {
  const value = answer({ status: 'failed' })
  const html = renderToStaticMarkup(createElement(AnswerCard, { answer: value, copy: async () => {}, cancel: async () => {}, retry: async () => {}, questionUpdated: true, current: true }))
  assert.match(html, /Question updated/)
  assert.match(html, /This response used an earlier question/)
  assert.doesNotMatch(html, /Retry this request/)
  assert.doesNotMatch(html, /Current answer/)
  assert.doesNotMatch(html, /You can retry when ready/)
  assert.equal(canRetryAnswer(value, true), false)
})
