import test from 'node:test'
import assert from 'node:assert/strict'
import { screenshotRegionFromDrag, ScreenshotRegionStore, validateScreenshotRegion, type RegionFrame, type ScreenshotRegion } from '../src/main/screenshot-region'

const image = { width: 2000, height: 1000 }, rendered = { x: 80, y: 40, width: 500, height: 250 }
const whole = { x: 0, y: 0, ...image }

test('CSS drag coordinates map to the encoded pixel grid without multiplying the display scale again', () => {
  assert.deepEqual(screenshotRegionFromDrag({ x: 180, y: 65 }, { x: 330, y: 165 }, rendered, image), { x: 400, y: 100, width: 600, height: 400 })
})
test('reverse-direction dragging yields the same rectangle', () => {
  assert.deepEqual(screenshotRegionFromDrag({ x: 330, y: 165 }, { x: 180, y: 65 }, rendered, image), { x: 400, y: 100, width: 600, height: 400 })
})
test('dragging across image edges clamps the selection to the actual pixel grid', () => {
  assert.deepEqual(screenshotRegionFromDrag({ x: -1000, y: -1000 }, { x: 900, y: 900 }, rendered, image), whole)
  assert.equal(screenshotRegionFromDrag({ x: -100, y: 30 }, { x: 20, y: 20 }, rendered, image), null)
})
test('fractional CSS bounds conservatively include every touched pixel', () => {
  assert.deepEqual(screenshotRegionFromDrag({ x: 80.3, y: 40.3 }, { x: 80.7, y: 40.7 }, rendered, image), { x: 1, y: 1, width: 2, height: 2 })
})
test('zero-area, nonfinite and unmeasurable drags cannot create a region', () => {
  assert.equal(screenshotRegionFromDrag({ x: 100, y: 100 }, { x: 100, y: 200 }, rendered, image), null)
  assert.equal(screenshotRegionFromDrag({ x: NaN, y: 100 }, { x: 120, y: 200 }, rendered, image), null)
  assert.equal(screenshotRegionFromDrag({ x: 100, y: 100 }, { x: 120, y: 200 }, { ...rendered, width: 0 }, image), null)
})
test('resizing or moving a preview during a gesture invalidates its stale coordinate transform', () => {
  for (const key of ['x', 'y', 'width', 'height'] as const) assert.equal(screenshotRegionFromDrag({ x: 100, y: 100 }, { x: 200, y: 200 }, rendered, image, { ...rendered, [key]: rendered[key] + 1 }), null)
})
test('backend region validation accepts integer in-bounds edge selections and returns an independent rectangle', () => {
  const region = validateScreenshotRegion(whole, image)
  assert.deepEqual(region, whole); assert.notEqual(region, whole)
  assert.deepEqual(validateScreenshotRegion({ x: 1999, y: 999, width: 1, height: 1 }, image), { x: 1999, y: 999, width: 1, height: 1 })
})
test('backend validation rejects negative, fractional, nonfinite, empty and outside-image rectangles', () => {
  for (const region of [{ ...whole, x: -1 }, { ...whole, width: 0 }, { ...whole, height: -1 }, { ...whole, x: .5 }, { ...whole, width: NaN }, { ...whole, y: Infinity }, { ...whole, width: Number.MAX_SAFE_INTEGER }, { ...whole, x: 1 }, { ...whole, y: 1 }]) assert.throws(() => validateScreenshotRegion(region, image))
})
test('backend validation rejects malformed objects and extra fields before any crop callback', () => {
  for (const region of [null, [], 5, { x: 0, y: 0, width: 1 }, { ...whole, sessionId: 'other' }, Object.create(whole)]) assert.throws(() => validateScreenshotRegion(region, image))
  assert.throws(() => validateScreenshotRegion(whole, { width: .5, height: 1000 }))
})

function fixture() {
  let now = 1000
  const timers = new Set<() => void>(), store = new ScreenshotRegionStore<string>({ now: () => now, ttlMs: 100, maxPreviews: 2, schedule: expire => { timers.add(expire); return () => { timers.delete(expire) } } })
  const display = { id: 'retina', width: 1440, height: 900, scaleFactor: 2 }, displays = [display]
  const frame: RegionFrame<string> = { image: 'private full-frame pixels', width: 2000, height: 1000, sessionId: 'session', ownerId: 'workspace', epoch: 3, name: 'Retina display', display }
  const rect = { x: 100, y: 100, width: 300, height: 200 }
  const commit = (id: string, rectangle: unknown = rect, callback: (frame: RegionFrame<string>, rectangle: ScreenshotRegion) => string = () => 'cropped attachment') => store.commit(id, 'session', 'workspace', 3, displays, rectangle, callback)
  return { store, frame, displays, display, rect, commit, timers, advance: (ms: number) => { now += ms } }
}

test('creating a preview retains no attachment consent and a successful crop is consumed exactly once', () => {
  const f = fixture(), selection: string[] = [], previews = f.store.create('one', f.frame)
  assert.equal(selection.length, 0); assert.equal(previews.expiresAt, 1100)
  assert.equal(f.commit('one', f.rect, (_frame, rectangle) => { assert.deepEqual(rectangle, f.rect); selection.push('cropped'); return 'cropped attachment' }), 'cropped attachment')
  assert.deepEqual(selection, ['cropped']); assert.equal(f.timers.size, 0)
  assert.throws(() => f.commit('one'), /expired or was discarded/)
})
test('a failed attachment commit preserves the original selection and preview for a smaller crop retry', () => {
  const f = fixture(), selected = ['existing']; f.store.create('one', f.frame)
  assert.throws(() => f.commit('one', whole, () => { throw new Error('Image memory cap') }), /memory cap/)
  assert.deepEqual(selected, ['existing']); assert.equal(f.timers.size, 1)
  assert.equal(f.commit('one', f.rect), 'cropped attachment')
})
test('malformed crop coordinates never dispatch a crop and leave the preview available', () => {
  const f = fixture(); f.store.create('one', f.frame)
  let calls = 0
  assert.throws(() => f.commit('one', { ...f.rect, x: -1 }, () => { calls++; return '' }))
  assert.equal(calls, 0); assert.equal(f.commit('one'), 'cropped attachment')
})
test('foreign windows and sessions cannot read, crop, or discard another preview', () => {
  const f = fixture(); f.store.create('one', f.frame)
  let calls = 0
  const crop = () => { calls++; return '' }
  assert.throws(() => f.store.commit('one', 'other', 'workspace', 3, f.displays, f.rect, crop), /different window or session/)
  assert.throws(() => f.store.commit('one', 'session', 'overlay', 3, f.displays, f.rect, crop), /different window or session/)
  assert.throws(() => f.store.discard('one', 'overlay'), /different window/)
  assert.equal(calls, 0); assert.equal(f.commit('one'), 'cropped attachment')
})
test('session reset invalidates a preview before its crop callback can receive private pixels', () => {
  const f = fixture(); f.store.create('one', f.frame)
  let calls = 0
  assert.throws(() => f.store.commit('one', 'session', 'workspace', 4, f.displays, f.rect, () => { calls++; return '' }), /session changed/)
  assert.equal(calls, 0); assert.equal(f.timers.size, 0); assert.throws(() => f.commit('one'), /expired or was discarded/)
})
test('display removal, resizing and scale changes invalidate a region preview without attachment mutation', () => {
  for (const displays of [[], [{ id: 'other', width: 1440, height: 900, scaleFactor: 2 }], [{ id: 'retina', width: 1280, height: 900, scaleFactor: 2 }], [{ id: 'retina', width: 1440, height: 800, scaleFactor: 2 }], [{ id: 'retina', width: 1440, height: 900, scaleFactor: 1 }]]) {
    const f = fixture(); f.store.create('one', f.frame)
    let calls = 0
    assert.throws(() => f.store.commit('one', 'session', 'workspace', 3, displays, f.rect, () => { calls++; return '' }), /display changed or disconnected/)
    assert.equal(calls, 0); assert.equal(f.timers.size, 0)
  }
})
test('verified display metadata is copied so mutable live display objects cannot change preview identity', () => {
  const f = fixture(); f.store.create('one', f.frame); f.display.scaleFactor = 1
  assert.throws(() => f.commit('one'), /display changed or disconnected/)
})
test('external window previews use their captured pixel grid without inventing a display scale', () => {
  const f = fixture(); f.store.create('one', { ...f.frame, display: undefined })
  assert.equal(f.store.commit('one', 'session', 'workspace', 3, [], f.rect, frame => { assert.equal(frame.display, undefined); return 'window crop' }), 'window crop')
})
test('expiry drops private preview pixels automatically and cannot be used to attach later', () => {
  const f = fixture(); f.store.create('one', f.frame)
  for (const expire of [...f.timers]) expire()
  assert.equal(f.timers.size, 0); assert.throws(() => f.commit('one'), /expired or was discarded/)
})
test('expiry is also enforced by clock at the exact deadline even if its timer has been delayed', () => {
  const f = fixture(); f.store.create('one', f.frame); f.advance(100)
  assert.throws(() => f.commit('one'), /expired or was discarded/); assert.equal(f.timers.size, 0)
})
test('a new preview in the same window supersedes the prior preview across session changes', () => {
  const f = fixture(); f.store.create('one', f.frame); f.store.create('two', { ...f.frame, sessionId: 'next' })
  assert.equal(f.timers.size, 1); assert.throws(() => f.commit('one'), /expired or was discarded/)
  assert.equal(f.store.commit('two', 'next', 'workspace', 3, f.displays, f.rect, () => 'next crop'), 'next crop')
})
test('preview capacity is bounded across windows and failed creation preserves existing previews', () => {
  const f = fixture(); f.store.create('one', f.frame); f.store.create('two', { ...f.frame, ownerId: 'overlay' })
  assert.throws(() => f.store.create('three', { ...f.frame, ownerId: 'third' }), /Close another region preview/)
  assert.equal(f.timers.size, 2); assert.equal(f.commit('one'), 'cropped attachment')
})
test('discard, reset, owner teardown and global cleanup are idempotent and session-scoped', () => {
  const f = fixture(); f.store.create('one', f.frame); f.store.create('two', { ...f.frame, sessionId: 'other', ownerId: 'overlay' })
  f.store.clearSession('session'); f.store.clearSession('session')
  assert.throws(() => f.commit('one'), /expired or was discarded/); assert.equal(f.timers.size, 1)
  f.store.clearOwner('overlay'); f.store.clearOwner('overlay'); assert.equal(f.timers.size, 0)
  f.store.discard('missing', 'workspace'); f.store.create('new', f.frame); f.store.clear(); f.store.clear(); assert.equal(f.timers.size, 0)
})
test('region preview configuration requires a finite positive capacity and lifetime', () => {
  for (const options of [{ ttlMs: 0 }, { ttlMs: Infinity }, { ttlMs: .5 }, { maxPreviews: 0 }, { maxPreviews: .5 }]) assert.throws(() => new ScreenshotRegionStore(options), /bounded lifetime and capacity/)
})
