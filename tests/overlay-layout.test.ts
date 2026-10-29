import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { constrainOverlayBounds, defaultOverlayBounds, overlayExpandedHeight, overlaySizeLimits, OVERLAY_LAYOUT } from '../src/main/overlay-layout'
import { restoreWindowBounds, snapshotWindowState, WindowStateManager, type WindowBounds, type WindowDisplay, type WindowLayout, type WindowStateStore } from '../src/main/window-state'

const primary: WindowDisplay = { id: 1, workArea: { x: 0, y: 33, width: 1512, height: 870 } }
const secondary: WindowDisplay = { id: 2, workArea: { x: -1920, y: -100, width: 1920, height: 1080 } }
function layout(collapsed = false, preferredHeight = 560): WindowLayout {
  return { defaultBounds: defaultOverlayBounds(primary.workArea, collapsed, preferredHeight), minWidth: 360, minHeight: collapsed ? 54 : 400,
    boundsPolicy: (bounds, area) => constrainOverlayBounds(bounds, area, collapsed, preferredHeight), sizeLimits: area => overlaySizeLimits(area, collapsed) }
}
function inside(bounds: WindowBounds, area: WindowBounds) {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y)
  assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height)
}

test('the reported production fullscreen geometry recovers to a compact overlay on startup', () => {
  const saved = { version: 1, bounds: { x: 0, y: 33, width: 1512, height: 949 }, displayId: '1', workArea: primary.workArea }
  const recovered = restoreWindowBounds(saved, [primary], primary, layout(false, 949))
  assert.deepEqual(recovered, { x: 1012, y: 93, width: 480, height: 560 })
  inside(recovered, primary.workArea)
  assert.equal(overlayExpandedHeight(949), 560)
  assert.equal(overlayExpandedHeight(Number.NaN), 560)
})

test('intentional reasonable sizing and negative-monitor positions survive restoration', () => {
  const bounds = { x: -1600, y: -70, width: 600, height: 720 }
  const saved = snapshotWindowState(bounds, [primary, secondary], primary)
  assert.deepEqual(restoreWindowBounds(saved, [primary, secondary], primary, layout()), bounds)
  const disconnected = restoreWindowBounds(saved, [primary], primary, layout())
  assert.equal(disconnected.width, 600); assert.equal(disconnected.height, 720)
  inside(disconnected, primary.workArea)
})

test('collapse is exactly 54 high and expansion uses a safe remembered height rather than the stored bar height', () => {
  const bar = { x: 800, y: 100, width: 520, height: 54 }
  const saved = snapshotWindowState(bar, [primary], primary)
  assert.deepEqual(restoreWindowBounds(saved, [primary], primary, layout(true)), bar)
  assert.equal(restoreWindowBounds(saved, [primary], primary, layout(false, 700)).height, 700)
  assert.equal(restoreWindowBounds(saved, [primary], primary, layout(false, 10_000)).height, 560)
  assert.equal(overlaySizeLimits(primary.workArea, true).maxHeight, 54)
})

test('explicit resize clamps at compact native limits without resetting the chosen width or position', () => {
  const resized = constrainOverlayBounds({ x: 200, y: 120, width: 950, height: 1100 }, primary.workArea, false, 560, false)
  assert.deepEqual(resized, { x: 200, y: 49, width: 720, height: 838 })
  assert.deepEqual(overlaySizeLimits(primary.workArea, false), { minWidth: 360, minHeight: 400, maxWidth: 720, maxHeight: 838 })
  inside(resized, primary.workArea)
})

test('small displays lower native minimum sizes and preserve a reachable header and resize corner', () => {
  const area = { x: 100, y: 80, width: 320, height: 240 }
  const bounds = defaultOverlayBounds(area)
  assert.deepEqual(overlaySizeLimits(area, false), { minWidth: 288, minHeight: 208, maxWidth: 288, maxHeight: 208 })
  assert.equal(bounds.width, 288); assert.equal(bounds.height, 208)
  inside(bounds, area)
  const bar = defaultOverlayBounds(area, true)
  assert.equal(bar.height, 54); inside(bar, area)
})

class Displays extends EventEmitter {
  values = [primary, secondary]
  getAllDisplays() { return this.values }
  getPrimaryDisplay() { return this.values[0] }
}
class NativeWindow extends EventEmitter {
  fullscreen = false; maximized = false; minimum = [360, 400]; maximum = [720, 840]
  constructor(public bounds: WindowBounds) { super() }
  isDestroyed() { return false }
  isMaximized() { return this.maximized }
  isMinimized() { return false }
  isFullScreen() { return this.fullscreen }
  getBounds() { return { ...this.bounds } }
  setBounds(bounds: WindowBounds) { this.bounds = { ...bounds }; this.emit('resize') }
  setMinimumSize(width: number, height: number) { this.minimum = [width, height] }
  setMaximumSize(width: number, height: number) { this.maximum = [width, height] }
}

test('fullscreen snapshots never overwrite the last ordinary overlay geometry', () => {
  const displays = new Displays(), values = new Map<string, unknown>()
  const store: WindowStateStore = { read: key => values.get(key), write: (key, state) => { values.set(key, state) } }
  const manager = new WindowStateManager(displays, store)
  const bounds = defaultOverlayBounds(primary.workArea), window = new NativeWindow(bounds)
  manager.attach('overlay', window, layout()); manager.save('overlay')
  window.fullscreen = true; window.bounds = primary.workArea; window.emit('resize'); manager.save('overlay')
  assert.deepEqual((values.get('overlay') as { bounds: WindowBounds }).bounds, bounds)
  manager.dispose()
})

test('display reflow updates native min/max constraints while retaining workspace state and compact overlay size', () => {
  const displays = new Displays(), values = new Map<string, unknown>()
  values.set('workspace', { untouched: true })
  const store: WindowStateStore = { read: key => values.get(key), write: (key, state) => { values.set(key, state) } }
  const manager = new WindowStateManager(displays, store)
  const window = new NativeWindow({ x: -1600, y: -70, width: 600, height: 720 })
  manager.attach('overlay', window, layout())
  displays.values = [{ id: 1, workArea: { x: 0, y: 33, width: 640, height: 450 } }]; displays.emit('display-removed')
  assert.deepEqual(window.minimum, [360, 400]); assert.deepEqual(window.maximum, [608, 418])
  inside(window.bounds, displays.values[0].workArea)
  assert.equal(window.bounds.height, 418); assert.equal(window.bounds.width, 600)
  assert.deepEqual(values.get('workspace'), { untouched: true })
  manager.dispose()
})
