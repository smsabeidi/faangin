import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Answer, AppState } from '../src/shared/types'
import OverlayHeader, { overlayCaptureShortcut } from '../src/renderer/src/OverlayHeader'
import AnswerCard from '../src/renderer/src/AnswerCard'
import { hasRegisteredActionShortcut } from '../src/renderer/src/registered-shortcut'

const binding: AppState['shortcuts'][number] = { id: 'capture-solve', action: 'Capture & solve', accelerator: 'Control+Alt+S', registered: true }
const props: Parameters<typeof OverlayHeader>[0] = { status: 'Ready', listening: false, passive: true, recovery: { shortcut: '⌃⌥I', hint: 'Press ⌃⌥I to use controls, or use the menu bar.' }, shortcut: '⌃⌥S', collapsed: false, busy: false, capturing: false, working: false, captureOwned: false, captureAndSolve: async () => {}, collapse: async () => {}, stop: async () => {}, children: createElement('p', null, 'Secondary controls') }
const renderHeader = (patch: Partial<typeof props> = {}) => renderToStaticMarkup(createElement(OverlayHeader, { ...props, ...patch }))

test('capture teaching follows custom registered bindings and never promises an unavailable shortcut', () => {
  assert.equal(overlayCaptureShortcut([binding], 'darwin'), '⌃⌥S')
  assert.equal(overlayCaptureShortcut([{ ...binding, accelerator: 'Control+Alt+P' }], 'win32'), 'Ctrl+Alt+P')
  for (const shortcuts of [[], [{ ...binding, registered: false }], [{ ...binding, id: 'screenshot' as const }], [{ ...binding, accelerator: 'bad accelerator' }]]) assert.equal(overlayCaptureShortcut(shortcuts, 'darwin'), null)
})

test('passive header keeps recovery discoverable without accessing its mouse-inaccessible menu', () => {
  const html = renderHeader()
  assert.match(html, /overlay-status[^>]*>⌃⌥I to interact/)
  assert.match(html, /aria-label="Capture &amp; solve"/)
  assert.match(html, /<kbd>⌃⌥S<\/kbd>/)
  const fallback = renderHeader({ shortcut: null, recovery: { shortcut: null, hint: 'Use Make overlay interactive in the menu bar.' } })
  assert.match(fallback, /Menu bar to interact/)
  assert.doesNotMatch(fallback, /<kbd>/)
  assert.match(fallback, /Set a shortcut in Settings/)
  assert.match(renderHeader({ recovery: { shortcut: null, hint: 'Use the system tray.' }, recoveryLabel: 'Tray' }), /Tray to interact/)
})

test('audio header affordance requests setup before starting audio and exposes immediate stop while owned', () => {
  assert.match(renderHeader(), /aria-label="Set up hands-free listening"/)
  assert.doesNotMatch(renderHeader(), /aria-label="Stop listening"/)
  assert.match(renderHeader({ captureOwned: true, listening: true, status: 'Listening' }), /aria-label="Stop listening"/)
  assert.match(renderHeader({ passive: false }), /overlay-status[^>]*>Ready/)
})

test('duplicate capture is unavailable during capture or generation while the same accessible action remains identifiable', () => {
  for (const patch of [{ busy: true, capturing: true }, { working: true }]) {
    const html = renderHeader(patch)
    assert.match(html, /class="overlay-capture-button" aria-label="Capture &amp; solve" disabled=/)
    if ('capturing' in patch) assert.match(html, /Capturing…/)
  }
})

test('the header offers a usable stop action during streaming instead of advertising a second capture', () => {
  const html = renderHeader({ busy: true, working: true, cancelAnswer: async () => {} })
  assert.match(html, /aria-label="Stop answer"/)
  assert.doesNotMatch(html, /aria-label="Capture &amp; solve"|<kbd>|overlay-stop-answer[^>]*disabled=/)
})

test('Capture & solve registration cannot swallow the local Solve keyboard fallback', () => {
  assert.equal(hasRegisteredActionShortcut([binding], 'solve'), false)
  assert.equal(hasRegisteredActionShortcut([binding, { ...binding, id: 'solve', action: 'Solve', registered: false }], 'solve'), false)
  assert.equal(hasRegisteredActionShortcut([{ ...binding, id: 'solve', action: 'Solve' }], 'solve'), true)
  assert.equal(hasRegisteredActionShortcut([{ ...binding, id: undefined, action: 'Solve' }], 'solve'), true)
  assert.equal(hasRegisteredActionShortcut([{ ...binding, id: undefined }], 'solve'), false)
})

test('compact answers disclose performance on demand while preserving provenance, interruption and streaming cancellation', () => {
  const answer: Answer = { id: 'answer', requestId: 'request', sessionId: 'session', action: 'solve', prompt: '', text: 'Use BFS for shortest unweighted paths.', model: 'fixture', status: 'complete', createdAt: 1, firstTokenMs: 200, inputTokens: 500, outputTokens: 30, context: { transcriptIds: ['question'], attachmentIds: ['screen'], priorAnswerIds: [], memorySourceIds: [], truncated: false } }
  const render = (compact: boolean, patch: Partial<Answer> = {}) => renderToStaticMarkup(createElement(AnswerCard, { answer: { ...answer, ...patch }, copy: async () => {}, cancel: async () => {}, retry: async () => {}, compact }))
  const html = render(true)
  assert.match(html, /<details class="answer-footnote answer-performance"><summary>Response details<\/summary>/)
  assert.match(html, /Included context · 1 transcript turns · 1 images/)
  assert.match(html, /First text 200 ms/)
  assert.doesNotMatch(render(false), /<summary>Response details/)
  assert.match(render(true, { status: 'streaming' }), /Cancel/)
  assert.match(render(true, { status: 'cancelled', interruption: { reason: 'new-question', at: 2 } }), /Interrupted — question changed/)
})
