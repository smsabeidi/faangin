import test from 'node:test'
import assert from 'node:assert/strict'
import { admitsLiveReply, liveReplyTranscript, type LiveReplyAdmission, type LiveReplyIdentity } from '../src/main/live-reply-context'
import type { Session, TranscriptTurn } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { compilePrompt } from '../src/main/prompts'

const turn: TranscriptTurn = { id: 'question', sessionId: 'session', channel: 'system', text: 'Explain binary search.', timestamp: 100 }
const candidate: LiveReplyIdentity = { turn, generation: 4, epoch: 2 }
function gate(): LiveReplyAdmission { return { enabled: true, source: 'system', currentSessionId: 'session', active: true, captureSessionId: 'session', phase: 'running', generation: 4, stopped: false, listening: new Set(['system']), revoked: new Set(), epochCurrent: true, quitting: false } }

test('automatic admission requires the current running selected source and session', () => {
  assert.equal(admitsLiveReply(candidate, gate()), true)
  for (const patch of [ { enabled: false }, { active: false }, { phase: 'paused' }, { phase: 'suspended' }, { stopped: true }, { source: 'microphone' as const }, { generation: 5 }, { currentSessionId: 'other' }, { captureSessionId: 'other' }, { epochCurrent: false }, { quitting: true }, { listening: new Set<'system'>() }, { revoked: new Set<'system'>(['system']) } ]) {
    assert.equal(admitsLiveReply(candidate, { ...gate(), ...patch }), false, JSON.stringify(patch))
  }
  assert.equal(admitsLiveReply({ ...candidate, turn: { ...turn, provisional: true } }, gate()), false)
  assert.equal(admitsLiveReply({ ...candidate, turn: { ...turn, channel: 'manual' } }, gate()), false)
})

test('already committed Stop drain cannot start a reply even when its epoch remains valid', () => {
  assert.equal(admitsLiveReply(candidate, { ...gate(), stopped: true, phase: 'stopping', epochCurrent: true }), false)
})

function session(transcript: TranscriptTurn[]): Session { return { id: 'session', title: 'Interview', mode: 'interview', status: 'recording', createdAt: 0, updatedAt: 0, notes: '', transcript, answers: [], attachments: [], contextEpoch: 2 } }
test('automatic context contains the target and earlier finalized context, never later, provisional or foreign speech', () => {
  const earlier = { ...turn, id: 'earlier', timestamp: 80, channel: 'microphone' as const, text: 'My prior explanation.' }
  const later = { ...turn, id: 'later', timestamp: 110, text: 'Now another question.' }
  const provisional = { ...turn, id: 'partial', timestamp: 90, provisional: true }
  const foreign = { ...turn, id: 'foreign', timestamp: 95, sessionId: 'other' }
  assert.deepEqual(liveReplyTranscript(session([later, provisional, turn, foreign, earlier]), candidate).map(item => item.id), ['earlier', 'question'])
})
test('same-timestamp turns after the target stay out of its immutable automatic snapshot', () => {
  const earlier = { ...turn, id: 'a-earlier', text: 'First question segment.' }
  const later = { ...turn, id: 'z-later', text: 'Later same-millisecond question.' }
  const current = session([later, turn, earlier])
  const snapshot = liveReplyTranscript(current, candidate)
  assert.deepEqual(snapshot.map(item => item.id), ['a-earlier', 'question'])
  snapshot[0].text = 'Changed snapshot'
  assert.equal(current.transcript.find(item => item.id === earlier.id)?.text, 'First question segment.')
})
test('target removal, mutation, foreign identity and context reset reject automatic snapshots', () => {
  for (const value of [session([]), session([{ ...turn, text: 'Changed' }]), session([{ ...turn, timestamp: 101 }]), session([{ ...turn, provisional: true }]), { ...session([turn]), contextEpoch: 3 }, { ...session([turn]), id: 'other' }]) {
    assert.throws(() => liveReplyTranscript(value, candidate), /context changed/)
  }
})
test('automatic reply compiler identifies the exact finalized target and preserves spoken reply contract', () => {
  const compiled = compilePrompt({ action: 'reply', prompt: '', settings: DEFAULT_SETTINGS, session: session([turn]), attachments: [], replyTarget: turn.id })
  const parts = compiled.input.at(-1)!.content
  assert.ok(Array.isArray(parts))
  const source = JSON.parse(parts.find(part => part.type === 'input_text')!.text)
  assert.equal(source.liveReplyTarget, 'question')
  assert.equal(source.userRequest, '')
  assert.deepEqual(source.selectedImages, [])
  assert.match(compiled.instructions, /automatic live suggestion/)
  assert.match(compiled.instructions, /Offer concise wording to say aloud/)
  assert.match(compiled.instructions, /Do not answer a different turn or infer speaker identity/)
  assert.deepEqual(compiled.sources.transcriptIds, ['question'])
  assert.equal(compiled.sources.provisional, false)
})
test('compiler rejects absent, provisional or non-reply automatic targets', () => {
  for (const request of [
    { action: 'reply' as const, replyTarget: 'missing', session: session([turn]) },
    { action: 'reply' as const, replyTarget: 'question', session: session([{ ...turn, provisional: true }]) },
    { action: 'assist' as const, replyTarget: 'question', session: session([turn]) },
  ]) assert.throws(() => compilePrompt({ ...request, settings: DEFAULT_SETTINGS, attachments: [] }), /finalized live reply target/)
})


test('available candidate speech after a question is context without admitting the next question or unfinished speech', () => {
  const spokenAnswer = { ...turn, id: 'candidate-answer', channel: 'microphone' as const, timestamp: 120, text: 'BFS visits vertices in distance order; DFS does not guarantee a shortest path.' }
  const futureQuestion = { ...turn, id: 'next-question', timestamp: 130, text: 'Now suppose edges have weights.' }
  const unfinished = { ...spokenAnswer, id: 'unfinished', timestamp: 140, provisional: true }
  const snapshot = liveReplyTranscript(session([futureQuestion, spokenAnswer, unfinished, turn]), candidate)
  assert.deepEqual(snapshot.map(item => item.id), ['question', 'candidate-answer'])
  snapshot[1].text = 'Mutated copy'
  assert.notEqual(spokenAnswer.text, 'Mutated copy')
})
