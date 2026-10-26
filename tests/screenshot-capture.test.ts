import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ScreenshotCapture, type ScreenshotDisplay, type ScreenshotSource, type ScreenshotWindow } from '../src/main/screenshot-capture'
import { AttachmentSelection } from '../src/main/attachment-selection'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }

class Window extends EventEmitter implements ScreenshotWindow {
  destroyed = false
  hideCalls = 0
  inactiveCalls = 0
  focusCalls = 0
  hideFailure = false
  restoreFailure = false
  afterRestore?: () => void
  constructor(readonly id: string, public visible = true) { super() }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  getMediaSourceId() { return this.id }
  hide() { this.hideCalls++; if (this.hideFailure) throw new Error('hide failed'); this.visible = false }
  showInactive() { this.inactiveCalls++; if (this.restoreFailure) throw new Error('restore failed'); this.visible = true; this.emit('show'); this.afterRestore?.() }
  focus() { this.focusCalls++ }
  requestShow() { this.visible = true; this.emit('show') }
}

function fixture(timeoutMs = 8000) {
  const workspace = new Window('window:100:0'), overlay = new Window('window:101:0'), captureSurface = new Window('window:102:0', false)
  const windows: Window[] = [workspace, overlay, captureSurface], watchers = new Set<(window: ScreenshotWindow) => void>(), deadlines = new Set<() => void>()
  const source: ScreenshotSource<string> = { id: 'screen:1:0', name: 'Primary display', display_id: 'primary', thumbnail: 'captured pixels' }
  const sizes: Array<{ width: number; height: number }> = [], calls: boolean[][] = []
  let epoch = 1
  const env = {
    windows, workspace, overlay, captureSurface, watchers, deadlines, source, sizes, calls,
    displays: [{ id: 'primary', width: 1920, height: 1080, scaleFactor: 2 }] as ScreenshotDisplay[],
    quitting: false,
    mayRestore: (_window: ScreenshotWindow) => true,
    settle: () => Promise.resolve(),
    sources: () => Promise.resolve([source]) as Promise<readonly ScreenshotSource<string>[]>,
    invalidateContext: () => { epoch++ },
    request: (sourceId?: string, sessionId = 'student') => ({ sessionId, sourceId, primaryDisplayId: 'primary', assertCurrent: () => { if (epoch !== 1) throw new Error('Session changed while capturing.') } }),
    expire: () => { for (const expire of [...deadlines]) expire() },
    addWindow: (window: Window) => { windows.push(window); for (const listener of watchers) listener(window) }
  }
  const manager = new ScreenshotCapture<string>({
    windows: () => windows,
    watchWindows: listener => { watchers.add(listener); return () => { watchers.delete(listener) } },
    displays: () => env.displays,
    sources: size => { sizes.push(size); calls.push(windows.map(window => window.visible)); return env.sources() },
    quitting: () => env.quitting,
    timeoutMs,
    mayRestore: window => env.mayRestore(window),
    settle: () => env.settle(),
    deadline: expire => { deadlines.add(expire); return () => { deadlines.delete(expire) } }
  })
  return { ...env, env, manager }
}

function restored(f: ReturnType<typeof fixture>) {
  assert.equal(f.workspace.visible, true); assert.equal(f.overlay.visible, true); assert.equal(f.captureSurface.visible, false)
  assert.equal(f.workspace.focusCalls + f.overlay.focusCalls + f.captureSurface.focusCalls, 0)
  assert.equal(f.watchers.size, 0)
  assert.equal(f.windows.reduce((sum, window) => sum + window.listenerCount('show'), 0), 0)
  assert.equal(f.deadlines.size, 0)
}

test('display capture hides every owned window and restores only the previously visible windows without focus', async () => {
  const f = fixture()
  const result = await f.manager.capture(f.request())
  assert.equal(result.source.thumbnail, 'captured pixels')
  assert.deepEqual(result.display, { id: 'primary', width: 1920, height: 1080, scaleFactor: 2 })
  assert.deepEqual(f.calls, [[false, false, false]])
  assert.deepEqual(f.sizes, [{ width: 2560, height: 1600 }])
  restored(f)
  assert.equal(f.workspace.inactiveCalls, 1); assert.equal(f.overlay.inactiveCalls, 1); assert.equal(f.captureSurface.inactiveCalls, 0)
})

test('an explicit user Hide during capture overrides temporary overlay restoration without hiding the workspace', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const capture = f.manager.capture(f.request()); await flush()
  assert.equal(f.overlay.visible, false)
  // The native visibility is already false during exclusion. User intent must
  // be consulted independently when the original windows are restored.
  f.env.mayRestore = window => window !== f.overlay
  native.resolve([f.source]); await capture
  assert.equal(f.workspace.visible, true); assert.equal(f.workspace.inactiveCalls, 1)
  assert.equal(f.overlay.visible, false); assert.equal(f.overlay.inactiveCalls, 0)
  assert.equal(f.overlay.focusCalls, 0); assert.equal(f.watchers.size, 0)
  assert.equal(f.overlay.listenerCount('show'), 0)
})

test('timed-out native capture also respects a user Hide and late pixels cannot resurrect the overlay', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const capture = f.manager.capture(f.request()), rejected = assert.rejects(capture, /timed out/)
  await flush(); f.env.mayRestore = window => window !== f.overlay
  f.expire(); await rejected
  assert.equal(f.workspace.visible, true); assert.equal(f.overlay.visible, false)
  native.resolve([f.source]); await flush()
  assert.equal(f.overlay.visible, false); assert.equal(f.overlay.inactiveCalls, 0)
  assert.equal(f.watchers.size, 0); assert.equal(f.overlay.listenerCount('show'), 0)
})

test('an owned window source is rejected before window visibility changes or native acquisition', async () => {
  const f = fixture()
  await assert.rejects(f.manager.capture(f.request(f.workspace.id)), /Faangin windows cannot be selected/)
  assert.equal(f.calls.length, 0); assert.equal(f.workspace.hideCalls, 0); assert.equal(f.overlay.hideCalls, 0)
  restored(f)
})

test('native acquisition errors restore windows and release the capture lock for the next request', async () => {
  const f = fixture()
  f.env.sources = () => Promise.reject(new Error('Permission denied by fixture'))
  await assert.rejects(f.manager.capture(f.request()), /Permission denied/)
  restored(f)
  f.env.sources = () => Promise.resolve([f.source])
  assert.equal((await f.manager.capture(f.request())).source.id, f.source.id)
  restored(f)
})

test('a native timeout restores windows promptly, discards late pixels, and blocks overlapping native calls until completion', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const capture = f.manager.capture(f.request()), rejected = assert.rejects(capture, /timed out/)
  await flush(); assert.deepEqual(f.calls, [[false, false, false]])
  f.expire(); await rejected
  restored(f)
  await assert.rejects(f.manager.capture(f.request()), /still finishing the previous request/)
  await assert.rejects(f.manager.listSources(), /still finishing the previous request/)
  assert.equal(f.calls.length, 1)
  native.resolve([f.source]); await flush()
  f.env.sources = () => Promise.resolve([f.source])
  assert.equal((await f.manager.capture(f.request())).source.id, f.source.id)
  assert.equal(f.calls.length, 2); restored(f)
})

test('a timeout during compositor settling never launches a late native acquisition', async () => {
  const f = fixture(), settle = deferred<void>()
  f.env.settle = () => settle.promise
  const capture = f.manager.capture(f.request()), rejected = assert.rejects(capture, /timed out/)
  await flush(); f.expire(); await rejected; restored(f)
  assert.equal(f.calls.length, 0)
  f.env.settle = () => Promise.resolve()
  await f.manager.capture(f.request())
  settle.resolve(); await flush()
  assert.equal(f.calls.length, 1); restored(f)
})

test('simultaneous capture requests cannot hide or restore each other’s windows', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const first = f.manager.capture(f.request())
  await flush()
  await assert.rejects(f.manager.capture(f.request()), /already in progress/)
  assert.equal(f.workspace.hideCalls, 1); assert.equal(f.workspace.inactiveCalls, 0); assert.equal(f.calls.length, 1)
  native.resolve([f.source]); await first
  assert.equal(f.workspace.inactiveCalls, 1); restored(f)
})

test('session invalidation cancels pending capture immediately and cannot reacquire while native cleanup is outstanding', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const capture = f.manager.capture(f.request()), rejected = assert.rejects(capture, /session changed during capture/)
  await flush()
  f.manager.invalidate('other-session'); assert.equal(f.workspace.visible, false)
  f.manager.invalidate('student'); await rejected; restored(f)
  await assert.rejects(f.manager.capture(f.request()), /still finishing the previous request/)
  native.resolve([f.source]); await flush()
  f.env.sources = () => Promise.resolve([f.source])
  await f.manager.capture(f.request()); restored(f)
})

test('a session reset before native completion cannot append pixels or change current image consent', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>(), selection = new AttachmentSelection()
  const images = ['saved-image']
  selection.set('student', images, images)
  f.env.sources = () => native.promise
  const captureAndCommit = async () => {
    await f.manager.capture(f.request())
    images.push('new-image'); selection.added('student', 'new-image')
  }
  const rejected = assert.rejects(captureAndCommit(), /Session changed while capturing/)
  await flush(); f.env.invalidateContext(); native.resolve([f.source]); await rejected
  assert.deepEqual(images, ['saved-image']); assert.deepEqual(selection.get('student'), ['saved-image']); restored(f)
})

test('context validity is checked again after restoration, before a caller can save the image', async () => {
  const f = fixture()
  f.workspace.afterRestore = () => f.env.invalidateContext()
  await assert.rejects(f.manager.capture(f.request()), /Session changed while capturing/)
  restored(f)
})

test('a stale session is rejected before hiding windows or acquiring pixels', async () => {
  const f = fixture(); f.env.invalidateContext()
  await assert.rejects(f.manager.capture(f.request()), /Session changed while capturing/)
  assert.equal(f.calls.length, 0); assert.equal(f.workspace.hideCalls, 0); restored(f)
})

test('display disconnection during acquisition rejects the saved display rather than switching to a new primary display', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const rejected = assert.rejects(f.manager.capture(f.request()), /disconnected during capture/)
  await flush(); f.env.displays = [{ id: 'replacement', width: 1920, height: 1080, scaleFactor: 1 }]
  native.resolve([f.source, { ...f.source, id: 'screen:2:0', display_id: 'replacement' }]); await rejected
  restored(f)
})

test('display scale changes during acquisition invalidate pixels with unknown physical coordinates', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const rejected = assert.rejects(f.manager.capture(f.request(f.source.id)), /display changed during capture/)
  await flush(); f.env.displays[0] = { ...f.env.displays[0], scaleFactor: 1 }
  native.resolve([f.source]); await rejected; restored(f)
})

test('an owned window shown during acquisition is hidden again and the potentially contaminated snapshot is discarded', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const rejected = assert.rejects(f.manager.capture(f.request()), /windows changed during capture/)
  await flush(); f.captureSurface.requestShow(); assert.equal(f.captureSurface.visible, false)
  native.resolve([f.source]); await rejected; restored(f)
  assert.equal(f.captureSurface.inactiveCalls, 0)
})

test('new owned windows are excluded during acquisition and are not incorrectly restored as previously visible', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>(), extra = new Window('window:103:0')
  f.env.sources = () => native.promise
  const rejected = assert.rejects(f.manager.capture(f.request()), /windows changed during capture/)
  await flush(); f.addWindow(extra); assert.equal(extra.visible, false)
  native.resolve([f.source]); await rejected; restored(f)
  assert.equal(extra.inactiveCalls, 0); assert.equal(extra.focusCalls, 0)
})

test('windows destroyed during capture are skipped while surviving windows are restored', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const capture = f.manager.capture(f.request())
  await flush(); f.workspace.destroyed = true
  native.resolve([f.source]); await capture
  assert.equal(f.workspace.inactiveCalls, 0); assert.equal(f.overlay.visible, true); assert.equal(f.overlay.inactiveCalls, 1)
  assert.equal(f.watchers.size, 0); assert.equal(f.deadlines.size, 0)
})

test('quitting never resurrects previously visible windows or returns a screenshot', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const rejected = assert.rejects(f.manager.capture(f.request()), /Faangin is closing/)
  await flush(); f.env.quitting = true; native.resolve([f.source]); await rejected
  assert.equal(f.workspace.inactiveCalls, 0); assert.equal(f.overlay.inactiveCalls, 0)
  assert.equal(f.watchers.size, 0); assert.equal(f.deadlines.size, 0)
  await assert.rejects(f.manager.listSources(), /Faangin is closing/)
})

test('a restoration failure still restores every other window and prevents committing the screenshot', async () => {
  const f = fixture(); f.workspace.restoreFailure = true
  await assert.rejects(f.manager.capture(f.request()), /could not be restored after capture/)
  assert.equal(f.overlay.visible, true); assert.equal(f.overlay.inactiveCalls, 1); assert.equal(f.captureSurface.visible, false)
  assert.equal(f.watchers.size, 0); assert.equal(f.deadlines.size, 0)
  assert.equal(f.windows.reduce((sum, window) => sum + window.listenerCount('show'), 0), 0)
})

test('a window that cannot be hidden prevents native capture and preserves windows that were never hidden', async () => {
  const f = fixture(); f.workspace.hideFailure = true
  await assert.rejects(f.manager.capture(f.request()), /hide failed/)
  assert.equal(f.calls.length, 0); assert.equal(f.overlay.hideCalls, 0); restored(f)
})

test('unverifiable owned source IDs fail closed before capture or source listing can expose window pixels', async () => {
  const f = fixture()
  f.workspace.getMediaSourceId = () => ''
  await assert.rejects(f.manager.capture(f.request()), /window ownership could not be verified/)
  await assert.rejects(f.manager.listSources(), /window ownership could not be verified/)
  assert.equal(f.calls.length, 0); restored(f)
})

test('source listing filters all owned window IDs, including windows created during the listing, without changing visibility', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>(), extra = new Window('window:103:0')
  f.env.sources = () => native.promise
  const listing = f.manager.listSources()
  await flush(); f.addWindow(extra)
  const foreign = { ...f.source, id: 'window:200:0', display_id: '' }
  native.resolve([f.source, foreign, ...f.windows.map(window => ({ ...foreign, id: window.id }))])
  assert.deepEqual((await listing).map(source => source.id), [f.source.id, foreign.id])
  assert.deepEqual(f.sizes, [{ width: 240, height: 150 }])
  assert.equal(f.windows.reduce((sum, window) => sum + window.hideCalls + window.inactiveCalls + window.focusCalls, 0), 0)
  assert.equal(extra.visible, true); restored(f)
})

test('source-list timeout shares the same mutex with capture and releases it only when the native listing finishes', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const rejected = assert.rejects(f.manager.listSources(), /timed out/)
  await flush()
  await assert.rejects(f.manager.capture(f.request()), /already in progress/)
  f.expire(); await rejected; restored(f)
  await assert.rejects(f.manager.capture(f.request()), /still finishing the previous request/)
  native.reject(new Error('late listing failure')); await flush()
  f.env.sources = () => Promise.resolve([f.source])
  await f.manager.capture(f.request()); restored(f)
})

test('capture requires a finite positive deadline', () => {
  for (const timeoutMs of [0, -1, Infinity, NaN]) assert.throws(() => new ScreenshotCapture({ windows: () => [], watchWindows: () => () => {}, displays: () => [], sources: async () => [], quitting: () => false, timeoutMs }), /finite positive deadline/)
})

test('a fresh capture can proceed immediately when no earlier native acquisition owns the service', async () => {
  const f = fixture()
  await f.manager.whenIdle()
  assert.equal(f.calls.length, 0)
  await f.manager.capture(f.request())
  assert.equal(f.calls.length, 1); restored(f)
})

test('Capture & solve waits for a cancelled region preview to finish then obtains a fresh frame once', async () => {
  const f = fixture(), settling = deferred<void>()
  let settlements = 0, frames = 0, resumed = false
  f.env.settle = () => ++settlements === 1 ? settling.promise : Promise.resolve()
  f.env.sources = async () => [{ ...f.source, thumbnail: `fresh frame ${++frames}` }]
  const preview = f.manager.capture(f.request())
  await flush()
  const next = f.manager.whenIdle().then(() => { resumed = true; return f.manager.capture(f.request()) })
  await flush(); assert.equal(resumed, false); assert.equal(frames, 0)
  settling.resolve()
  assert.equal((await preview).source.thumbnail, 'fresh frame 1')
  assert.equal((await next).source.thumbnail, 'fresh frame 2')
  assert.equal(frames, 2); restored(f)
})

test('idle waiting never releases an uncancellable timed-out native acquisition early', async () => {
  const f = fixture(), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const first = f.manager.capture(f.request()), rejected = assert.rejects(first, /timed out/)
  await flush(); f.expire(); await rejected
  let released = false
  const wait = f.manager.whenIdle().then(() => { released = true })
  await flush(); assert.equal(released, false)
  native.resolve([f.source]); await wait
  f.env.sources = async () => [{ ...f.source, thumbnail: 'new capture after drain' }]
  assert.equal((await f.manager.capture(f.request())).source.thumbnail, 'new capture after drain')
  restored(f)
})

test('a hung native acquisition produces a bounded idle-wait error and does not retry capture', async () => {
  const f = fixture(20), native = deferred<readonly ScreenshotSource<string>[]>()
  f.env.sources = () => native.promise
  const first = f.manager.capture(f.request()), rejected = assert.rejects(first, /timed out/)
  await flush(); f.expire(); await rejected
  await assert.rejects(f.manager.whenIdle(), /previous screenshot is still finishing/)
  assert.equal(f.calls.length, 1)
  native.resolve([f.source]); await flush(); await f.manager.whenIdle()
  restored(f)
})

test('quitting rejects an idle wait before another capture can begin', async () => {
  const f = fixture(), settling = deferred<void>()
  f.env.settle = () => settling.promise
  const first = f.manager.capture(f.request()), rejectedFirst = assert.rejects(first, /Faangin is closing/)
  await flush()
  const waiting = assert.rejects(f.manager.whenIdle(), /Faangin is closing/)
  f.env.quitting = true; settling.resolve()
  await Promise.all([rejectedFirst, waiting])
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.manager.whenIdle(), /Faangin is closing/)
})
