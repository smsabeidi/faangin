import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureSolveCoordinator, CaptureSolveImages, captureSolveConnectionIdentity, type CaptureSolveSnapshot } from '../src/main/capture-solve'
import { DEFAULT_SETTINGS, type GenerateInput, type Settings } from '../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve: (value: T) => resolve(value), reject: (error: Error) => reject(error) }
}
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }
function fixture() {
  let currentSession = 'interview', epoch = 3, sourceId = 'screen:selected', captureCalls = 0, generated = 0, selected = ['old-reference']
  const frame = deferred<{ id: string; sessionId: string }>(), finished = deferred<void>(), inputs: GenerateInput[] = [], capturedSnapshots: CaptureSolveSnapshot[] = [], cancelled: string[] = []
  const coordinator = new CaptureSolveCoordinator({
    snapshot: sessionId => ({ sessionId, epoch, sourceId, smart: true }),
    assertCurrent: snapshot => { if (snapshot.sessionId !== currentSession || snapshot.epoch !== epoch || snapshot.sourceId !== sourceId) throw new Error('Session or source changed') },
    capture: async (snapshot, assertCurrent) => { captureCalls++; capturedSnapshots.push(snapshot); const image = await frame.promise; assertCurrent(); return image },
    select: (_sessionId, imageId) => { selected = [imageId] },
    generate: async input => { generated++; inputs.push(input); return { requestId: 'answer' } },
    finished: () => finished.promise,
    cancelCapture: sessionId => cancelled.push(sessionId),
    changed() {}
  })
  return { coordinator, frame, finished, inputs, capturedSnapshots, cancelled, counts: () => ({ captureCalls, generated }), selection: () => selected, session: (value: string) => { currentSession = value }, reset: () => { epoch++ }, source: (value: string) => { sourceId = value } }
}

test('one command captures the configured source, selects only its fresh frame and dispatches exactly one Solve', async () => {
  const f = fixture(), pending = f.coordinator.run('interview')
  await flush()
  assert.deepEqual(f.counts(), { captureCalls: 1, generated: 0 })
  assert.deepEqual(f.coordinator.state(), { sessionId: 'interview', phase: 'capturing' })
  assert.deepEqual(f.capturedSnapshots, [{ sessionId: 'interview', epoch: 3, sourceId: 'screen:selected', smart: true }])
  f.frame.resolve({ id: 'new-frame', sessionId: 'interview' })
  assert.deepEqual(await pending, { requestId: 'answer' })
  assert.deepEqual(f.selection(), ['new-frame'])
  assert.deepEqual(f.inputs, [{ sessionId: 'interview', action: 'solve', attachmentIds: ['new-frame'], smart: true }])
  assert.deepEqual(f.coordinator.state(), { sessionId: 'interview', phase: 'solving', requestId: 'answer' })
  f.finished.resolve(); await flush()
  assert.equal(f.coordinator.state(), null)
})

test('duplicate commands from different windows share capture and answer while preparing and streaming', async () => {
  const f = fixture(), first = f.coordinator.run('interview'), second = f.coordinator.run('interview')
  assert.equal(first, second)
  f.frame.resolve({ id: 'new-frame', sessionId: 'interview' })
  await first
  assert.equal(f.coordinator.run('interview'), first)
  assert.deepEqual(f.counts(), { captureCalls: 1, generated: 1 })
  await assert.rejects(f.coordinator.run('another-session'), /already running/)
  f.finished.resolve(); await flush()
  assert.notEqual(f.coordinator.run('interview'), first)
  await flush()
  assert.deepEqual(f.counts(), { captureCalls: 2, generated: 2 })
})

test('a screen permission or acquisition failure never sends stale selected images and permits a retry', async () => {
  const f = fixture(), pending = f.coordinator.run('interview')
  f.frame.reject(new Error('Screen permission denied'))
  await assert.rejects(pending, /permission denied/)
  assert.deepEqual(f.selection(), ['old-reference'])
  assert.equal(f.counts().generated, 0)
  assert.equal(f.coordinator.state(), null)
})

test('Stop before acquisition starts never asks for a screenshot or generation', async () => {
  const f = fixture(), pending = f.coordinator.run('interview')
  f.coordinator.cancel()
  await assert.rejects(pending, /cancelled/)
  assert.deepEqual(f.counts(), { captureCalls: 0, generated: 0 })
  assert.equal(f.coordinator.state(), null)
})

test('Stop while a native frame is in flight discards its late result and leaves the old selection', async () => {
  const f = fixture(), pending = f.coordinator.run('interview')
  await flush(); f.coordinator.cancel('interview')
  assert.deepEqual(f.cancelled, ['interview'])
  f.frame.resolve({ id: 'late-frame', sessionId: 'interview' })
  await assert.rejects(pending, /cancelled/)
  assert.deepEqual(f.selection(), ['old-reference'])
  assert.equal(f.counts().generated, 0)
})

test('a foreign stop cannot revoke the current command', async () => {
  const f = fixture(), pending = f.coordinator.run('interview')
  f.coordinator.cancel('other-session')
  assert.equal(f.coordinator.preparing(), true)
  f.frame.resolve({ id: 'new-frame', sessionId: 'interview' })
  await pending
  assert.equal(f.counts().generated, 1)
  f.finished.resolve()
})

test('a changed session, reset epoch or source cannot dispatch a captured answer', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.session('other-session'), (f: ReturnType<typeof fixture>) => f.reset(), (f: ReturnType<typeof fixture>) => f.source('screen:different')]) {
    const f = fixture(), pending = f.coordinator.run('interview')
    await flush(); change(f)
    f.frame.resolve({ id: 'stale-frame', sessionId: 'interview' })
    await assert.rejects(pending, /changed/)
    assert.equal(f.counts().generated, 0)
    assert.deepEqual(f.selection(), ['old-reference'])
    assert.equal(f.coordinator.state(), null)
  }
})

test('switching away and back revokes the old identity before its late frame returns', async () => {
  const f = fixture(), old = f.coordinator.run('interview')
  await flush(); f.coordinator.cancel('interview')
  f.session('other-session'); f.session('interview')
  const current = f.coordinator.run('interview')
  f.frame.resolve({ id: 'current-frame', sessionId: 'interview' })
  await assert.rejects(old, /cancelled/)
  await current
  assert.equal(f.counts().generated, 1)
  assert.equal(f.coordinator.state()?.requestId, 'answer')
  f.finished.resolve()
})

test('a malformed or foreign-session frame cannot change selection or start Solve', async () => {
  for (const image of [{ id: '', sessionId: 'interview' }, { id: 'foreign-frame', sessionId: 'other-session' }]) {
    const f = fixture(), pending = f.coordinator.run('interview')
    f.frame.resolve(image)
    await assert.rejects(pending, /does not belong/)
    assert.deepEqual(f.selection(), ['old-reference'])
    assert.equal(f.counts().generated, 0)
  }
})

test('a generation rejection surfaces once, never recaptures or retries and releases ownership', async () => {
  let captures = 0, generations = 0
  const coordinator = new CaptureSolveCoordinator({
    snapshot: sessionId => ({ sessionId, epoch: 1, smart: false }), assertCurrent() {},
    capture: async snapshot => { captures++; return { sessionId: snapshot.sessionId, id: 'fresh' } }, select() {},
    generate: async () => { generations++; throw new Error('Vision unavailable') },
    finished: async () => {}, cancelCapture() {}, changed() {}
  })
  await assert.rejects(coordinator.run('interview'), /Vision unavailable/)
  assert.equal(captures, 1); assert.equal(generations, 1)
  assert.equal(coordinator.state(), null)
})

test('a provider destination, model or image capability change during acquisition cannot dispatch the pending image', async () => {
  const changes: Partial<Settings>[] = [
    { chatProvider: 'compatible' }, { fastModel: 'another-model' }, { smartModel: 'another-smart-model' }, { smartMode: true },
    { compatibleChatEndpoint: 'https://changed.example/v1' }, { compatibleChatModel: 'changed' }, { compatibleChatSmartModel: 'changed-smart' }, { compatibleChatVision: true }
  ]
  for (const patch of changes) {
    let settings = { ...DEFAULT_SETTINGS }, generated = 0, selected = false
    const frame = deferred<void>()
    const coordinator = new CaptureSolveCoordinator({
      snapshot: sessionId => ({ sessionId, epoch: 1, smart: false, connectionIdentity: captureSolveConnectionIdentity(settings) }),
      assertCurrent: snapshot => { if (snapshot.connectionIdentity !== captureSolveConnectionIdentity(settings)) throw new Error('Connection changed during capture') },
      capture: async snapshot => { await frame.promise; return { id: 'pending-frame', sessionId: snapshot.sessionId } },
      select: () => { selected = true }, generate: async () => { generated++; return { requestId: 'unexpected' } },
      finished: async () => {}, cancelCapture() {}, changed() {}
    })
    const pending = coordinator.run('interview')
    await flush(); settings = { ...settings, ...patch }; frame.resolve()
    await assert.rejects(pending, /Connection changed/)
    assert.equal(generated, 0); assert.equal(selected, false)
    assert.equal(coordinator.state(), null)
  }
  assert.equal(captureSolveConnectionIdentity({ ...DEFAULT_SETTINGS, opacity: 0.9, theme: 'light' }), captureSolveConnectionIdentity(DEFAULT_SETTINGS))
})

test('repeated questions replace only the oldest owned capture after four images', () => {
  const ledger = new CaptureSolveImages()
  let images = [{ id: 'manual-reference', createdAt: 0 }]
  for (let index = 1; index <= 8; index++) {
    const replaced = ledger.replacement('interview', images)
    const fresh = { id: `question-${index}`, createdAt: index }
    images = [...images.filter(image => image.id !== replaced), fresh]
    ledger.committed('interview', fresh.id, replaced)
    assert.ok(images.some(image => image.id === 'manual-reference'))
    assert.ok(images.length <= 4)
  }
  assert.deepEqual(images.map(image => image.id), ['manual-reference', 'question-6', 'question-7', 'question-8'])
})

test('failed acquisitions leave owned captures intact and a full manual tray has actionable recovery', () => {
  const ledger = new CaptureSolveImages(), images = Array.from({ length: 4 }, (_, index) => ({ id: `reference-${index}`, createdAt: index }))
  assert.throws(() => ledger.replacement('interview', images), /Four reference images.*Remove an image/)
  ledger.committed('interview', 'reference-2')
  assert.equal(ledger.replacement('interview', images), 'reference-2')
  // Acquisition fails: no committed() call, so the prior frame remains eligible.
  assert.equal(ledger.replacement('interview', images), 'reference-2')
  assert.equal(images.length, 4)
  ledger.removed('interview', 'reference-2')
  assert.throws(() => ledger.replacement('interview', images), /Four reference images/)
  ledger.committed('interview', 'reference-3'); ledger.clear('interview')
  assert.throws(() => ledger.replacement('interview', images), /Four reference images/)
})

test('cancelling while capture waits for native idle cannot acquire a later frame or dispatch an answer', async () => {
  const idle = deferred<void>()
  let acquisitions = 0, selections = 0, generations = 0
  const coordinator = new CaptureSolveCoordinator({
    snapshot: sessionId => ({ sessionId, epoch: 0, smart: false }),
    assertCurrent() {},
    capture: async (snapshot, assertCurrent) => { await idle.promise; assertCurrent(); acquisitions++; return { sessionId: snapshot.sessionId, id: 'fresh' } },
    select() { selections++ }, generate: async () => { generations++; return { requestId: 'unexpected' } },
    finished: async () => {}, cancelCapture() {}, changed() {}
  })
  const pending = coordinator.run('interview')
  await flush(); coordinator.cancel('interview'); idle.resolve()
  await assert.rejects(pending, /cancelled/)
  assert.deepEqual({ acquisitions, selections, generations }, { acquisitions: 0, selections: 0, generations: 0 })
})
