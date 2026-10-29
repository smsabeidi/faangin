import assert from 'node:assert/strict'
import test from 'node:test'
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
