import assert from 'node:assert/strict'
import test from 'node:test'
import { audioInputGuidance, hasReplyContext, interviewFollowupRequest, questionSourceHealth, questionSourcePatch } from '../src/renderer/src/interview-workflow'
import { DEFAULT_SETTINGS, type AppState, type Session } from '../src/shared/types'


const capture: AppState['capture'] = { active: true, sessionId: 'interview', microphone: 'Listening', system: 'Listening' }
const session = (patch: Partial<Session> = {}): Session => ({ id: 'interview', title: 'Interview', mode: 'interview', status: 'recording', createdAt: 1, updatedAt: 1, notes: '', transcript: [], answers: [], attachments: [], contextEpoch: 0, ...patch })


test('question source presets enable only the selected input and never opt into automatic requests', () => {
  assert.deepEqual(questionSourcePatch('system'), { liveSuggestionSource: 'system', systemAudio: true, microphone: false })
  assert.deepEqual(questionSourcePatch('microphone'), { liveSuggestionSource: 'microphone', microphone: true, systemAudio: false })
  for (const source of ['system', 'microphone'] as const) {
    const merged = { ...DEFAULT_SETTINGS, ...questionSourcePatch(source) }
    assert.equal(merged.liveSuggestions, false)
    assert.equal(merged.microphone, source === 'microphone')
    assert.equal(merged.systemAudio, source === 'system')
  }
})

test('manual follow-ups accept finalized conversation and currently owned live speech', () => {
  const turn = { id: 'question', sessionId: 'interview', channel: 'system' as const, text: 'Why BFS instead of DFS?', timestamp: 1 }
  assert.equal(hasReplyContext(session({ transcript: [turn] }), { ...capture, active: false }, []), true)
  assert.equal(hasReplyContext(session(), capture, [{ sessionId: 'interview', channel: 'system', itemId: 'partial', text: turn.text }]), true)
  assert.equal(hasReplyContext(session({ transcript: [{ ...turn, provisional: true }] }), capture, []), false)
})

test('stale, stopped, foreign, and blank partial speech do not enable a follow-up request', () => {
  const partial = { sessionId: 'interview', channel: 'system' as const, itemId: 'partial', text: 'Explain the memory tradeoff.' }
  assert.equal(hasReplyContext(null, capture, [partial]), false)
  assert.equal(hasReplyContext(session(), { ...capture, active: false }, [partial]), false)
  assert.equal(hasReplyContext(session(), { ...capture, sessionId: 'different' }, [partial]), false)
  assert.equal(hasReplyContext(session(), capture, [{ ...partial, sessionId: 'different' }]), false)
  assert.equal(hasReplyContext(session(), capture, [{ ...partial, text: ' \n ' }]), false)
})

test('degraded inputs give visible recovery instructions for the selected source', () => {
  assert.match(audioInputGuidance('system', false, 'Off'), /Enable system audio/)
  assert.match(audioInputGuidance('system', true, 'Permission denied'), /system settings/)
  assert.match(audioInputGuidance('microphone', true, 'Unavailable'), /choose another input/)
  assert.match(audioInputGuidance('system', true, 'Silent · 15s'), /interviewer.*computer/)
  assert.match(audioInputGuidance('microphone', true, 'Low audio'), /Speak near the microphone/)
  assert.match(audioInputGuidance('system', true, 'Disconnected'), /Stop listening/)
  assert.equal(audioInputGuidance('system', true, 'Listening'), '')
})


test('typed follow-ups work after a screenshot solution without requiring a transcript or resending the screen', () => {
  assert.deepEqual(interviewFollowupRequest(' Why BFS instead of DFS? \n'), { action: 'ask', prompt: 'Why BFS instead of DFS?', attachmentIds: [] })
  assert.deepEqual(interviewFollowupRequest(' \n '), { action: 'reply', prompt: '', attachmentIds: [] })
})


test('blocked audio explains recovery when the operating system already reports access granted', () => {
  for (const status of ['Permission denied', 'System audio access was blocked.']) {
    const guidance = audioInputGuidance('system', true, status, 'granted')
    assert.match(guidance, /already allowed/)
    assert.match(guidance, /Stop listening.*fully quit and reopen.*Start listening/)
    assert.doesNotMatch(guidance, /Allow.*access/)
  }
  const unknown = audioInputGuidance('system', true, 'System audio access was blocked.')
  assert.match(unknown, /Check screen and system audio access/)
  assert.match(unknown, /already allowed.*fully quit and reopen/)
  assert.match(unknown, /Stop listening.*Start listening/)
})

test('a live microphone does not present the failed remote question source as listening', () => {
  const settings = { ...DEFAULT_SETTINGS, microphone: true, systemAudio: true, liveSuggestionSource: 'system' as const }
  for (const system of ['Permission denied', 'System audio access was blocked.', 'No audio frames — reconnect this source.']) {
    assert.deepEqual(questionSourceHealth(settings, { ...capture, microphone: 'Listening', system }), { listening: false, unavailable: true, headline: 'Computer audio unavailable · microphone only' })
  }
  assert.deepEqual(questionSourceHealth({ ...settings, systemAudio: false }, { ...capture, microphone: 'Listening', system: 'Off' }), { listening: false, unavailable: true, headline: 'Computer audio is off · microphone only' })
})

test('question source health distinguishes connecting, paused and healthy silent capture from failure', () => {
  const settings = { ...DEFAULT_SETTINGS, microphone: true, systemAudio: true, liveSuggestionSource: 'system' as const }
  assert.deepEqual(questionSourceHealth(settings, { ...capture, system: 'Connecting…' }), { listening: false, unavailable: false, headline: 'Connecting computer audio…' })
  assert.deepEqual(questionSourceHealth(settings, { ...capture, active: false, system: 'Paused' }), { listening: false, unavailable: false, headline: 'Listening paused' })
  for (const system of ['Listening', 'Listening (fixture)', 'Silent — check the source if speech is playing.', 'Low audio level — raise the source volume.']) {
    assert.deepEqual(questionSourceHealth(settings, { ...capture, microphone: 'Permission denied', system }), { listening: true, unavailable: false, headline: 'Listening to question audio' })
  }
  assert.deepEqual(questionSourceHealth(settings, { ...capture, active: false, sessionId: null, microphone: 'Off', system: 'Off' }), { listening: false, unavailable: false, headline: 'Ready to listen' })
})

test('a failed in-person question microphone is distinct from a healthy computer-audio source', () => {
  const settings = { ...DEFAULT_SETTINGS, microphone: true, systemAudio: true, liveSuggestionSource: 'microphone' as const }
  assert.deepEqual(questionSourceHealth(settings, { ...capture, microphone: 'Microphone access was blocked.', system: 'Listening' }), { listening: false, unavailable: true, headline: 'Microphone unavailable · computer audio only' })
})
