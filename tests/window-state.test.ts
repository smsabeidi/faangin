import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowStateManager, displayForBounds, jsonWindowStateStore, reachableWindowBounds, restoreWindowBounds, snapshotWindowState, type WindowBounds, type WindowDisplay, type WindowStateStore } from '../src/main/window-state'

const primary: WindowDisplay = { id: 1, workArea: { x: 0, y: 24, width: 1440, height: 876 } }
const secondary: WindowDisplay = { id: 2, workArea: { x: -1920, y: -100, width: 1920, height: 1080 } }
const layout = { defaultBounds: { x: 940, y: 84, width: 480, height: 700 }, minWidth: 360, minHeight: 400 }
class Displays extends EventEmitter {
  values = [primary, secondary]
  getAllDisplays() { return this.values }
  getPrimaryDisplay() { return this.values.find(display => display.id === 1) ?? this.values[0] }
}
class Window extends EventEmitter {
  destroyed = false; maximized = false; minimized = false
  constructor(public bounds: WindowBounds) { super() }
  isDestroyed() { return this.destroyed }
  isMaximized() { return this.maximized }
  isMinimized() { return this.minimized }
  getBounds() { return { ...this.bounds } }
  setBounds(bounds: WindowBounds) { this.bounds = { ...bounds }; this.emit('move') }
}
function memoryStore() {
  const values = new Map<string, unknown>(), writes: string[] = []
  const store: WindowStateStore = { read: key => values.get(key), write: (key, state) => { values.set(key, structuredClone(state)); writes.push(key) } }
  return { values, writes, store }
}

test('invalid or obsolete saved geometry starts on a reachable primary work area', () => {
  for (const invalid of [null, {}, { version: 2 }, { version: 1, bounds: { x: NaN, y: 0, width: 400, height: 400 }, workArea: primary.workArea, displayId: '1' }, { version: 1, bounds: { x: 1e308, y: 0, width: 400, height: 400 }, workArea: primary.workArea, displayId: '1' }]) {
    assert.deepEqual(restoreWindowBounds(invalid, [primary], primary, layout), layout.defaultBounds)
  }
})
test('negative-coordinate monitors restore exact normal bounds', () => {
  const bounds = { x: -1600, y: -70, width: 480, height: 700 }
  const saved = snapshotWindowState(bounds, [primary, secondary], primary)
  assert.equal(saved.displayId, '2')
  assert.deepEqual(restoreWindowBounds(saved, [primary, secondary], primary, layout), bounds)
})
test('display relocation retains local window offset and changed resolution clamps the complete window', () => {
  const saved = snapshotWindowState({ x: -1600, y: -70, width: 480, height: 700 }, [primary, secondary], primary)
  const relocated: WindowDisplay = { id: 2, workArea: { x: 1440, y: 24, width: 1920, height: 1080 } }
  assert.deepEqual(restoreWindowBounds(saved, [primary, relocated], primary, layout), { x: 1760, y: 54, width: 480, height: 700 })
  const small: WindowDisplay = { id: 2, workArea: { x: 1440, y: 24, width: 600, height: 500 } }
  assert.deepEqual(restoreWindowBounds(saved, [primary, small], primary, layout), { x: 1560, y: 24, width: 480, height: 500 })
})
test('disconnecting the saved display places the complete window on the remaining desktop', () => {
  const saved = snapshotWindowState({ x: -1600, y: -70, width: 480, height: 700 }, [primary, secondary], primary)
  assert.deepEqual(restoreWindowBounds(saved, [primary], primary, layout), { x: 0, y: 24, width: 480, height: 700 })
})
test('minimum dimensions never place an oversized window outside a small work area', () => {
  assert.deepEqual(reachableWindowBounds({ x: 9000, y: 9000, width: 1600, height: 1200 }, { x: 100, y: 100, width: 320, height: 240 }, 900, 400), { x: 100, y: 100, width: 320, height: 240 })
  assert.throws(() => reachableWindowBounds({ x: 0, y: 0, width: 0, height: 200 }, primary.workArea), /positive/)
})
test('display choice uses largest intersection, then nearest work area for disconnected coordinates', () => {
  assert.equal(displayForBounds({ x: -300, y: 100, width: 600, height: 400 }, [primary, secondary], primary).id, 1)
  assert.equal(displayForBounds({ x: -4000, y: 100, width: 600, height: 400 }, [primary, secondary], primary).id, 2)
})
test('hidden windows reflow on unplug without being shown or changing capture state', () => {
  const displays = new Displays(), memory = memoryStore(), manager = new WindowStateManager(displays, memory.store)
  const window = new Window({ x: -1800, y: 0, width: 480, height: 700 })
  manager.attach('overlay', window, layout)
  displays.values = [primary]; displays.emit('display-removed')
  assert.deepEqual(window.bounds, { x: 0, y: 24, width: 480, height: 700 })
  assert.equal((memory.values.get('overlay') as { displayId: string }).displayId, '1')
  manager.dispose(); assert.equal(displays.listenerCount('display-removed'), 0)
})
test('minimized windows retain normal bounds and reflow when restored', () => {
  const displays = new Displays(), memory = memoryStore(), manager = new WindowStateManager(displays, memory.store)
  const normal = { x: -1800, y: 0, width: 480, height: 700 }, window = new Window(normal)
  manager.attach('overlay', window, layout)
  window.minimized = true; window.bounds = { x: -32000, y: -32000, width: 1, height: 1 }; window.emit('move')
  manager.save('overlay')
  assert.deepEqual((memory.values.get('overlay') as { bounds: WindowBounds }).bounds, normal)
  displays.values = [primary]; displays.emit('display-removed')
  window.minimized = false; window.bounds = normal; window.emit('restore')
  assert.deepEqual(window.bounds, { x: 0, y: 24, width: 480, height: 700 })
  manager.dispose()
})
test('maximized geometry does not replace remembered normal bounds', () => {
  const displays = new Displays(), memory = memoryStore(), manager = new WindowStateManager(displays, memory.store)
  const normal = { x: 900, y: 84, width: 480, height: 700 }, window = new Window(normal)
  manager.attach('overlay', window, layout)
  window.maximized = true; window.bounds = primary.workArea; window.emit('resize'); manager.save('overlay')
  assert.deepEqual((memory.values.get('overlay') as { bounds: WindowBounds }).bounds, normal)
  manager.dispose()
})
test('closing before debounce expires saves the last observed normal bounds and removes listeners', () => {
  const displays = new Displays(), memory = memoryStore(), manager = new WindowStateManager(displays, memory.store, undefined, 60_000)
  const window = new Window(layout.defaultBounds)
  manager.attach('overlay', window, layout)
  window.bounds = { ...window.bounds, x: 400 }; window.emit('move')
  window.destroyed = true; window.emit('closed')
  assert.equal((memory.values.get('overlay') as { bounds: WindowBounds }).bounds.x, 400)
  assert.equal(window.listenerCount('move'), 0); manager.dispose()
})
test('storage failures are reported without moving windows or crashing topology processing', () => {
  const displays = new Displays(), errors: unknown[] = [], manager = new WindowStateManager(displays, { read: () => null, write: () => { throw new Error('Disk full') } }, error => errors.push(error))
  const window = new Window(layout.defaultBounds); manager.attach('overlay', window, layout)
  assert.doesNotThrow(() => manager.save('overlay')); assert.equal(errors.length, 1)
  manager.dispose()
})
test('cleanup for a replaced window cannot detach or overwrite its replacement', () => {
  const displays = new Displays(), memory = memoryStore(), manager = new WindowStateManager(displays, memory.store)
  const old = new Window(layout.defaultBounds), replacement = new Window({ ...layout.defaultBounds, x: 300 })
  const cleanupOld = manager.attach('overlay', old, layout)
  manager.attach('overlay', replacement, layout); cleanupOld()
  assert.equal(replacement.listenerCount('move'), 1); assert.equal(old.listenerCount('move'), 0)
  manager.save('overlay'); assert.equal((memory.values.get('overlay') as { bounds: WindowBounds }).bounds.x, 300)
  manager.dispose()
})
test('topology reflow lowers restrictive native minima for a small monitor and restores layout minima on a larger monitor', () => {
  class RestrictiveWindow extends Window {
    minimum = { width: 900, height: 400 }
    setMinimumSize(width: number, height: number) { this.minimum = { width, height } }
    override setBounds(bounds: WindowBounds) { super.setBounds({ ...bounds, width: Math.max(this.minimum.width, bounds.width), height: Math.max(this.minimum.height, bounds.height) }) }
  }
  const displays = new Displays(), memory = memoryStore(), manager = new WindowStateManager(displays, memory.store)
  const window = new RestrictiveWindow({ x: 100, y: 100, width: 1280, height: 840 })
  const workspaceLayout = { defaultBounds: window.bounds, minWidth: 900, minHeight: 400 }
  manager.attach('workspace', window, workspaceLayout)
  displays.values = [{ id: 1, workArea: { x: 0, y: 24, width: 640, height: 300 } }]; displays.emit('display-metrics-changed')
  assert.deepEqual(window.minimum, { width: 640, height: 300 }); assert.deepEqual(window.bounds, { x: 0, y: 24, width: 640, height: 300 })
  displays.values = [primary]; displays.emit('display-metrics-changed')
  assert.deepEqual(window.minimum, { width: 900, height: 400 }); assert.equal(window.bounds.width, 900); assert.equal(window.bounds.height, 400)
  manager.dispose()
})
test('atomic geometry store survives reopening and recovers a corrupt file without touching session storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-window-'))
  try {
    const path = join(directory, 'geometry.json'), state = snapshotWindowState(layout.defaultBounds, [primary], primary)
    writeFileSync(path, 'invalid JSON')
    const store = jsonWindowStateStore(path)
    assert.equal(store.read('overlay'), undefined)
    store.write('overlay', state); store.write('workspace', { ...state, bounds: { ...state.bounds, width: 1000 } })
    assert.deepEqual(jsonWindowStateStore(path).read('overlay'), state)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace.bounds.width, 1000)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
