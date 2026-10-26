import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SETTINGS, type AppState, type FaanginAPI, type Session } from '../src/shared/types'
import HandsFreeButton from '../src/renderer/src/HandsFreeButton'
import AutomaticHelpStatus from '../src/renderer/src/AutomaticHelpStatus'
import { automaticReplyStatus, HANDS_FREE_CONSENT, handsFreeControl, handsFreeSettingsPatch, startHandsFreeInterview } from '../src/renderer/src/interview-workflow'

const session: Session = { id: 'interview', title: 'Interview', mode: 'interview', status: 'idle', createdAt: 1, updatedAt: 1, notes: '', transcript: [], answers: [], attachments: [], contextEpoch: 0 }
const idle = (): AppState => ({ settings: { ...DEFAULT_SETTINGS }, currentSession: { ...session }, capture: { active: false, sessionId: null, microphone: 'Off', system: 'Off' } } as AppState)
const listening = (): AppState => ({ ...idle(), settings: { ...DEFAULT_SETTINGS, ...handsFreeSettingsPatch() }, capture: { active: true, sessionId: session.id, microphone: 'Listening', system: 'Listening' } })
type StartAPI = Pick<FaanginAPI, 'getState' | 'updateSettings' | 'startCapture' | 'resumeCapture'>
function fixture(initial = idle()) {
  let state = initial
  const calls: string[] = []
  const api: StartAPI = {
    getState: async () => state,
    updateSettings: async patch => { calls.push('settings'); state = { ...state, settings: { ...state.settings, ...patch } }; return state.settings },
    startCapture: async id => { calls.push(`start:${id}`) },
    resumeCapture: async id => { calls.push(`resume:${id}`) },
  }
  return { api, calls, get: () => state, set: (next: AppState) => { state = next } }
}

test('hands-free starts both audio inputs and automatic help only after the explicit setup finishes', async () => {
  const f = fixture()
  let release!: () => void
  const saved = f.api.updateSettings
  f.api.updateSettings = async patch => { await new Promise<void>(resolve => { release = resolve }); return saved(patch) }
  const pending = startHandsFreeInterview(f.api, session)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, [])
  release()
  await pending
  assert.deepEqual(f.calls, ['settings', 'start:interview'])
  assert.equal(f.get().settings.microphone, true)
  assert.equal(f.get().settings.systemAudio, true)
  assert.equal(f.get().settings.liveSuggestions, true)
  assert.equal(f.get().settings.liveSuggestionSource, 'system')
  assert.equal(DEFAULT_SETTINGS.liveSuggestions, false)
})

test('changing or resetting the interview during setup cannot start recording in the wrong context', async () => {
  for (const changed of [{ ...session, id: 'other' }, { ...session, contextEpoch: 1 }]) {
    const f = fixture()
    const save = f.api.updateSettings
    f.api.updateSettings = async patch => { const result = await save(patch); f.set({ ...f.get(), currentSession: changed }); return result }
    await assert.rejects(startHandsFreeInterview(f.api, session), /interview changed/)
    assert.deepEqual(f.calls, ['settings'])
  }
})

test('settings failure and concurrent audio changes never fall through to capture', async () => {
  const failed = fixture()
  failed.api.updateSettings = async () => { throw new Error('Could not save audio settings') }
  await assert.rejects(startHandsFreeInterview(failed.api, session), /Could not save/)
  assert.deepEqual(failed.calls, [])
  const changed = fixture()
  const save = changed.api.updateSettings
  changed.api.updateSettings = async patch => { const saved = await save(patch); changed.set({ ...changed.get(), settings: { ...saved, liveSuggestions: false } }); return saved }
  await assert.rejects(startHandsFreeInterview(changed.api, session), /Audio settings changed/)
  assert.deepEqual(changed.calls, ['settings'])
})

test('an explicit stop while hands-free setup saves cannot restart the stopped recording', async () => {
  const f = fixture({ ...listening(), settings: { ...listening().settings, liveSuggestions: false } })
  const controller = new AbortController()
  let release!: () => void
  const save = f.api.updateSettings
  f.api.updateSettings = async patch => { await new Promise<void>(resolve => { release = resolve }); return save(patch) }
  const pending = startHandsFreeInterview(f.api, session, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  f.set({ ...f.get(), capture: idle().capture })
  release()
  await assert.rejects(pending, /start cancelled/)
  assert.deepEqual(f.calls, ['settings'])
})

test('hands-free never stops or changes an existing one-source or another-session recording', async () => {
  for (const state of [
    { ...listening(), settings: { ...listening().settings, microphone: false } },
    { ...listening(), capture: { ...listening().capture, sessionId: 'other' } },
  ]) {
    const f = fixture(state)
    await assert.rejects(startHandsFreeInterview(f.api, session), /Stop listening/)
    assert.deepEqual(f.calls, [])
    assert.match(handsFreeControl(state).reason, /Stop listening/)
  }
})

test('enabling help during a two-input recording does not open a duplicate capture stream', async () => {
  const f = fixture({ ...listening(), settings: { ...listening().settings, liveSuggestions: false } })
  assert.equal(handsFreeControl(f.get()).label, 'Enable hands-free')
  await startHandsFreeInterview(f.api, session)
  assert.deepEqual(f.calls, ['settings'])
})

test('paused hands-free listening resumes the same session', async () => {
  const f = fixture({ ...listening(), currentSession: { ...session, status: 'paused' }, capture: { ...listening().capture, active: false, microphone: 'Paused', system: 'Paused' } })
  assert.equal(handsFreeControl(f.get()).label, 'Resume hands-free')
  await startHandsFreeInterview(f.api, session)
  assert.deepEqual(f.calls, ['settings', 'resume:interview'])
})

test('enabled automatic help is ready while stopped even if the previous backend status says off', () => {
  const state = { ...idle(), settings: { ...DEFAULT_SETTINGS, liveSuggestions: true }, liveSuggestions: { phase: 'off' as const, source: 'system' as const, sessionId: null, reason: 'Start listening.' } }
  assert.deepEqual(automaticReplyStatus(state), { label: 'Ready', detail: 'Automatic help is enabled. Audio stays off until you start listening.' })
  assert.equal(automaticReplyStatus(idle()).label, 'Off')
})

test('question understanding and answering lifecycle uses the backend reason without an empty response card', () => {
  for (const [phase, label] of [['waiting', 'Question received'], ['understanding', 'Understanding the question'], ['generating', 'Answering']] as const) {
    const state = { ...listening(), liveSuggestions: { phase, source: 'system' as const, sessionId: session.id, reason: 'The current question is being assessed.' } }
    assert.deepEqual(automaticReplyStatus(state), { label, detail: 'The current question is being assessed.' })
  }
})

test('source failure stays actionable even when the other input is live', () => {
  const state = listening()
  assert.deepEqual(automaticReplyStatus({ ...state, capture: { ...state.capture, system: 'Permission denied' } }), { label: 'Needs audio', detail: 'Computer audio unavailable · microphone only' })
  assert.match(automaticReplyStatus({ ...state, capture: { ...state.capture, microphone: 'Permission denied' } }).detail, /Microphone unavailable · computer audio only/)
})

test('a temporarily muted source waits for audio without claiming a failed or connecting device', () => {
  const state = listening()
  const muted = 'Audio source is muted — waiting for audio.'
  assert.deepEqual(automaticReplyStatus({ ...state, capture: { ...state.capture, system: muted } }), { label: 'Waiting for audio', detail: 'Computer audio muted · waiting for audio' })
  assert.match(automaticReplyStatus({ ...state, capture: { ...state.capture, microphone: muted } }).detail, /Microphone muted · waiting for audio/)
})

test('the rendered start control names the action and blocks conflicting setup while leaving an explicit stop', () => {
  const render = (state: AppState, busy = '') => renderToStaticMarkup(createElement(HandsFreeButton, { state, busy, start: async () => {}, stop: async () => {} }))
  assert.match(render(idle()), /Start hands-free/)
  assert.doesNotMatch(render(idle()), /disabled=/)
  assert.match(render(idle(), 'Starting hands-free'), /Starting hands-free/)
  assert.match(render(idle(), 'Starting hands-free'), /disabled=/)
  assert.match(render(listening()), /Stop listening/)
  const manual = render({ ...listening(), settings: { ...listening().settings, systemAudio: false } })
  assert.match(manual, /disabled=/)
  assert.match(manual, /Stop listening first/)
  assert.match(manual, />Stop listening</)
  assert.match(HANDS_FREE_CONSENT, /microphone \+ computer audio.*OpenAI.*chat provider.*credits/)
})

test('failed automatic help exposes one resume action without restarting healthy audio', () => {
  const state = { ...listening(), liveSuggestions: { phase: 'paused' as const, source: 'system' as const, sessionId: session.id, reason: 'The previous reply failed.' } }
  const render = (value: AppState, busy = false) => renderToStaticMarkup(createElement(AutomaticHelpStatus, { state: value, busy, resume: async () => {} }))
  assert.match(render(state), /Resume automatic help/)
  assert.doesNotMatch(render(state), /disabled=/)
  assert.match(render(state, true), /disabled=/)
  assert.doesNotMatch(render({ ...state, capture: { ...state.capture, active: false, system: 'Paused', microphone: 'Paused' } }), /Resume automatic help/)
  assert.doesNotMatch(render({ ...state, capture: { ...state.capture, sessionId: 'other' } }), /Resume automatic help/)
  assert.doesNotMatch(render({ ...state, capture: { ...state.capture, system: 'Permission denied' } }), /Resume automatic help/)
})
