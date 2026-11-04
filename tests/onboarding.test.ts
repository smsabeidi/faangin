import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import Onboarding from '../src/renderer/src/Onboarding'
import { completeOnboarding, ONBOARDING_STORAGE_KEY, readOnboarding, saveOnboarding, shouldShowOnboarding } from '../src/renderer/src/onboarding-state'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

test('first launch guides a new workspace while existing connected sessions and overlays remain usable', () => {
  const store = storage()
  assert.equal(shouldShowOnboarding({ windowKind: 'workspace', sessions: [], chatConfigured: false }, store), true)
  assert.equal(shouldShowOnboarding({ windowKind: 'overlay', sessions: [], chatConfigured: false }, store), false)
  assert.equal(shouldShowOnboarding({ windowKind: 'workspace', sessions: [{} as never], chatConfigured: true }, store), false)
  saveOnboarding({ step: 2, mode: 'meeting', completed: false }, store)
  assert.equal(shouldShowOnboarding({ windowKind: 'workspace', sessions: [{} as never], chatConfigured: true }, store), true)
})

test('a finished guide stays finished across launch and preserves the selected workspace', () => {
  const store = storage()
  saveOnboarding({ step: 1, mode: 'meeting', completed: false }, store)
  assert.deepEqual(readOnboarding(store), { step: 1, mode: 'meeting', completed: false })
  completeOnboarding('meeting', store)
  assert.deepEqual(readOnboarding(store), { step: 3, mode: 'meeting', completed: true })
  assert.equal(shouldShowOnboarding({ windowKind: 'workspace', sessions: [], chatConfigured: false }, store), false)
})

test('corrupted progress and unavailable storage cannot crash setup', () => {
  const store = storage()
  for (const value of ['bad json', 'null', '[]', '{"step":4,"mode":"meeting","completed":false}', '{"step":-1,"mode":"interview","completed":false}', '{"step":1,"mode":"unknown","completed":false}', '{"step":1.5,"mode":"interview","completed":false}', '{"step":1,"mode":"interview","completed":"false"}']) {
    store.setItem(ONBOARDING_STORAGE_KEY, value)
    assert.deepEqual(readOnboarding(store), { step: 0, mode: 'interview', completed: false })
  }
  const blocked = { getItem: () => { throw new Error('Denied') }, setItem: () => { throw new Error('Denied') } }
  assert.deepEqual(readOnboarding(blocked), { step: 0, mode: 'interview', completed: false })
  assert.doesNotThrow(() => completeOnboarding('interview', blocked))
})

function renderOnboarding(platform: string, permissions: { microphone: string; screen: string }, step: number): string {
  const store = storage()
  saveOnboarding({ step, mode: 'interview', completed: false }, store)
  const state: AppState = { settings: DEFAULT_SETTINGS, permissions: { platform, ...permissions }, shortcuts: [], accessibility: { reduceTransparency: false, reduceMotion: false, increaseContrast: false }, keyConfigured: false, chatConfigured: false, compatibleKeyConfigured: false, sessions: [], currentSession: null, version: 'fixture', windowKind: 'workspace', capture: { active: false, sessionId: null, microphone: 'Off', system: 'Off' } }
  // Static rendering runs no effects, so a window holding only the saved progress is all the component reads.
  ;(globalThis as { window?: unknown }).window = { localStorage: store }
  try { return renderToStaticMarkup(createElement(Onboarding, { state, onComplete() {}, onOpenAccount() {}, onRefresh: async () => {} })) } finally { delete (globalThis as { window?: unknown }).window }
}

test('the access step names each permission the way the running OS does', () => {
  const mac = renderOnboarding('darwin', { microphone: 'not-determined', screen: 'denied' }, 2)
  assert.match(mac, /Screen and audio access are checked before your workspace opens/)
  assert.equal(mac.match(/Allow access</g)?.length, 1)
  assert.equal(mac.match(/Open settings</g)?.length, 1)
  assert.equal(mac.match(/Not enabled/g)?.length, 2)
  assert.doesNotMatch(mac, /Not needed|Manage access|Ready<\/button>/)
  const windows = renderOnboarding('win32', { microphone: 'not-determined', screen: 'not-required' }, 2)
  assert.match(windows, /Microphone access and computer audio are checked before your workspace opens/)
  assert.match(windows, /Not needed on Windows/)
  assert.equal(windows.match(/Not enabled/g)?.length, 1)
  assert.equal(windows.match(/Open settings</g)?.length, 1)
  assert.equal(windows.match(/onboarding-permission-button" disabled=""/g)?.length, 1)
  assert.match(windows, /Ready<\/button>/)
  assert.doesNotMatch(windows, /Allow access|Manage access|Screen and audio access|macOS|System Settings/)
  const linux = renderOnboarding('linux', { microphone: 'unknown', screen: 'unknown' }, 2)
  assert.equal(linux.match(/Manage access</g)?.length, 2)
})

test('the ready step shows the OS modifier key and counts a permission the OS does not have as enabled', () => {
  assert.match(renderOnboarding('darwin', { microphone: 'granted', screen: 'granted' }, 3), /<kbd>⌘ ,<\/kbd>/)
  const windows = renderOnboarding('win32', { microphone: 'granted', screen: 'not-required' }, 3)
  assert.match(windows, /<kbd>Ctrl ,<\/kbd>/)
  assert.match(windows, /Permissions enabled/)
  assert.doesNotMatch(windows, /⌘/)
  assert.match(renderOnboarding('win32', { microphone: 'not-determined', screen: 'not-required' }, 3), /Access checked before capture/)
})
