import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import test from 'node:test'
import { waitForSurface } from '../src/main/surface-ready'

const loadEvents = ['did-finish-load', 'did-fail-load', 'render-process-gone', 'destroyed']

class Surface extends EventEmitter {
  loading = true
  destroyed = false
  isLoading(): boolean { return this.loading }
  isDestroyed(): boolean { return this.destroyed }
  finish(): void { this.loading = false; this.emit('did-finish-load') }
  destroy(): void { this.destroyed = true; this.emit('destroyed') }
}

function assertClean(contents: Surface, signal: AbortSignal): void {
  for (const event of loadEvents) assert.equal(contents.listenerCount(event), 0, `${event} listener was not removed`)
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'abort listener was not removed')
}

test('surface readiness resolves on finish and releases every startup listener', async () => {
  const contents = new Surface(), controller = new AbortController()
  const waiting = waitForSurface(contents, controller.signal)
  for (const event of loadEvents) assert.equal(contents.listenerCount(event), 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  contents.finish()
  await waiting
  assertClean(contents, controller.signal)
  contents.emit('render-process-gone')
  controller.abort()
  await waiting
})

test('already loaded surfaces resolve without adding listeners', async () => {
  const contents = new Surface(), controller = new AbortController()
  contents.loading = false
  await waitForSurface(contents, controller.signal)
  assertClean(contents, controller.signal)
})

test('main-frame load failure rejects while subframe failures leave startup waiting', async () => {
  const contents = new Surface(), controller = new AbortController()
  const waiting = waitForSurface(contents, controller.signal)
  let settled = false
  void waiting.then(() => { settled = true }, () => { settled = true })
  contents.emit('did-fail-load', {}, -105, 'Name not resolved', 'https://subframe.example/', false)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(contents.listenerCount('did-finish-load'), 1)
  contents.emit('did-fail-load', {}, -2, 'Failed', 'file:///index.html', true)
  await assert.rejects(waiting, /could not load/)
  assertClean(contents, controller.signal)
})

test('subframe failure does not prevent a successful main-frame finish', async () => {
  const contents = new Surface(), controller = new AbortController()
  const waiting = waitForSurface(contents, controller.signal)
  contents.emit('did-fail-load', {}, -3, 'Aborted', 'https://subframe.example/', false)
  contents.finish()
  await waiting
  assertClean(contents, controller.signal)
})

test('renderer termination rejects readiness and cleans up loading listeners', async () => {
  const contents = new Surface(), controller = new AbortController()
  const waiting = waitForSurface(contents, controller.signal)
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  await assert.rejects(waiting, /closed before loading completed/)
  assertClean(contents, controller.signal)
})

test('destroyed surfaces reject both before admission and while loading', async () => {
  for (const preDestroyed of [true, false]) {
    const contents = new Surface(), controller = new AbortController()
    contents.destroyed = preDestroyed
    const waiting = waitForSurface(contents, controller.signal)
    if (!preDestroyed) contents.destroy()
    await assert.rejects(waiting, /destroyed before loading completed/)
    assertClean(contents, controller.signal)
  }
})

test('abort rejects with the caller reason and releases listeners before or during loading', async () => {
  for (const preAborted of [true, false]) {
    const contents = new Surface(), controller = new AbortController()
    const reason = new Error('Capture was stopped by the user.')
    if (preAborted) controller.abort(reason)
    const waiting = waitForSurface(contents, controller.signal)
    if (!preAborted) controller.abort(reason)
    await assert.rejects(waiting, error => error === reason)
    assertClean(contents, controller.signal)
  }
})

test('preaborted startup cannot succeed just because its renderer has already loaded', async () => {
  const contents = new Surface(), controller = new AbortController()
  contents.loading = false
  controller.abort()
  await assert.rejects(waitForSurface(contents, controller.signal), error => error === controller.signal.reason)
  assertClean(contents, controller.signal)
})

test('an unresponsive surface hits its deadline and releases event and abort listeners', async () => {
  const contents = new Surface(), controller = new AbortController()
  await assert.rejects(waitForSurface(contents, controller.signal, 10), /timed out/)
  assertClean(contents, controller.signal)
  contents.finish()
})

test('readiness rechecks loading after registration to catch a finish without its event', async () => {
  const contents = new Surface(), controller = new AbortController()
  let loadingChecks = 0
  contents.isLoading = () => ++loadingChecks === 1
  await waitForSurface(contents, controller.signal)
  assert.equal(loadingChecks, 2)
  assertClean(contents, controller.signal)
})

test('invalid load deadlines fail immediately without leaking listeners', async () => {
  for (const timeoutMs of [-1, Infinity, NaN]) {
    const contents = new Surface(), controller = new AbortController()
    await assert.rejects(waitForSurface(contents, controller.signal, timeoutMs), /deadline is invalid/)
    assertClean(contents, controller.signal)
  }
})
