import assert from 'node:assert/strict'
import test from 'node:test'
import { audioHealthMessages, AUDIO_HEALTH_MESSAGES } from '../src/capture/audio-health'
import { audioTrackMissing } from '../src/capture/media'
import { win32Platform } from '../src/main/platform'
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
  assert.match(audioInputGuidance('system', false, 'Off', 'darwin'), /Enable system audio/)
  assert.match(audioInputGuidance('system', true, 'Permission denied', 'darwin'), /system settings/)
  assert.match(audioInputGuidance('microphone', true, 'Unavailable', 'darwin'), /choose another input/)
  assert.match(audioInputGuidance('system', true, 'Silent · 15s', 'darwin'), /interviewer.*computer/)
  assert.match(audioInputGuidance('microphone', true, 'Low audio', 'darwin'), /Speak near the microphone/)
  assert.match(audioInputGuidance('system', true, 'Disconnected', 'darwin'), /Stop listening/)
  assert.equal(audioInputGuidance('system', true, 'Listening', 'darwin'), '')
})

test('Windows points a failed computer-audio source at the default playback device, never at a permission it does not have', () => {
  for (const status of ['Permission denied', 'System audio access was blocked.']) {
    const denied = audioInputGuidance('system', true, status, 'win32', 'not-required')
    assert.match(denied, /default playback device in Windows Sound settings/)
    assert.match(denied, /fully quit and reopen Faangin.*Stop listening.*Start listening/)
    assert.doesNotMatch(denied, /screen|permission|system settings/)
  }
  const unavailable = audioInputGuidance('system', true, 'System audio is unavailable', 'win32')
  assert.match(unavailable, /default playback device in Windows Sound settings/)
  assert.match(unavailable, /choose Microphone/)
  assert.doesNotMatch(unavailable, /permissions/)
  // The microphone and every other status keep the shared copy, and Linux keeps the macOS copy as today.
  assert.equal(audioInputGuidance('microphone', true, 'Permission denied', 'win32'), audioInputGuidance('microphone', true, 'Permission denied', 'darwin'))
  for (const status of ['Silent · 15s', 'Disconnected', 'Listening']) assert.equal(audioInputGuidance('system', true, status, 'win32'), audioInputGuidance('system', true, status, 'darwin'))
  for (const status of ['Permission denied', 'System audio is unavailable']) assert.equal(audioInputGuidance('system', true, status, 'linux'), audioInputGuidance('system', true, status, 'darwin'))
})

test('Windows shows the Default Device hints in full, because the meter clips them and the shared sentence names no setting to change', () => {
  const messages = audioHealthMessages('win32', 'system')
  assert.match(messages.silent, /Default Communications Device/); assert.match(messages['low-level'], /Windows output volume/)
  assert.equal(audioInputGuidance('system', true, messages.silent, 'win32'), messages.silent)
  assert.equal(audioInputGuidance('system', true, messages['low-level'], 'win32'), messages['low-level'])
  assert.equal(audioInputGuidance('system', true, messages.silent, 'win32').length > 100, true, 'the full instruction, not a one-line label')
  // The microphone, macOS and Linux keep the shared copy for the very same statuses.
  for (const platform of ['darwin', 'linux']) {
    assert.match(audioInputGuidance('system', true, messages.silent, platform), /Play the interviewer.s voice through your computer/)
    assert.match(audioInputGuidance('system', true, messages['low-level'], platform), /Play the interviewer.s voice through your computer/)
  }
  assert.match(audioInputGuidance('microphone', true, messages.silent, 'win32'), /Speak near the microphone/)
  assert.match(audioInputGuidance('system', true, AUDIO_HEALTH_MESSAGES.silent, 'win32'), /Play the interviewer.s voice through your computer/)
  assert.equal(audioInputGuidance('system', false, messages.silent, 'win32'), audioInputGuidance('system', false, messages.silent, 'darwin'))
})

test('Windows classifies its own capture strings: a missing playback device and a switched-off microphone both read as unavailable', async () => {
  const noDevice = audioTrackMissing('system', 'win32'), pending = win32Platform.pendingMicrophoneMessage()
  const denied = (await win32Platform.microphoneAccess({ getMediaAccessStatus: () => 'denied', askForMediaAccess: async () => false })).message!
  assert.match(denied, /Privacy & security \(Privacy on Windows 10\) → Microphone/)
  assert.match(audioInputGuidance('system', true, noDevice, 'win32'), /default playback device in Windows Sound settings/)
  assert.match(audioInputGuidance('system', true, noDevice, 'darwin'), /Check audio permissions/, 'only Windows produces this status; elsewhere the shared unavailable copy applies')
  const settings = { ...DEFAULT_SETTINGS, microphone: true, systemAudio: true, liveSuggestionSource: 'system' as const }
  assert.deepEqual(questionSourceHealth(settings, { ...capture, microphone: 'Listening', system: noDevice }), { listening: false, unavailable: true, headline: 'Computer audio unavailable · microphone only' })
  assert.match(audioInputGuidance('microphone', true, denied, 'win32', 'denied'), /Check microphone access in system settings/)
  assert.deepEqual(questionSourceHealth({ ...settings, liveSuggestionSource: 'microphone' }, { ...capture, microphone: denied, system: 'Listening' }), { listening: false, unavailable: true, headline: 'Microphone unavailable · computer audio only' })
  assert.deepEqual(questionSourceHealth({ ...settings, liveSuggestionSource: 'microphone' }, { ...capture, microphone: pending, system: 'Listening' }), { listening: false, unavailable: true, headline: 'Microphone unavailable · computer audio only' })
})


test('typed follow-ups work after a screenshot solution without requiring a transcript or resending the screen', () => {
  assert.deepEqual(interviewFollowupRequest(' Why BFS instead of DFS? \n'), { action: 'ask', prompt: 'Why BFS instead of DFS?', attachmentIds: [] })
  assert.deepEqual(interviewFollowupRequest(' \n '), { action: 'reply', prompt: '', attachmentIds: [] })
})


test('blocked audio explains recovery when the operating system already reports access granted', () => {
  for (const status of ['Permission denied', 'System audio access was blocked.']) {
    const guidance = audioInputGuidance('system', true, status, 'darwin', 'granted')
    assert.match(guidance, /already allowed/)
    assert.match(guidance, /Stop listening.*fully quit and reopen.*Start listening/)
    assert.doesNotMatch(guidance, /Allow.*access/)
  }
  const unknown = audioInputGuidance('system', true, 'System audio access was blocked.', 'darwin')
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
