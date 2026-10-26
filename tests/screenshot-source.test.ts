import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveScreenshotSource, type ScreenshotDisplay, type ScreenshotSource } from '../src/main/screenshot-capture'

const display = (id = '1', values: Partial<ScreenshotDisplay> = {}): ScreenshotDisplay => ({ id, width: 1512, height: 982, scaleFactor: 2, ...values })
const source = (id: string, displayId = '1'): ScreenshotSource<string> => ({ id, name: `Source ${id}`, display_id: displayId, thumbnail: `fixture:${id}` })
const primary = source('screen:1:0')
const displays = Object.freeze([Object.freeze(display())])
const owned = new Set<string>(['window:faangin:0'])

test('explicit external window is selected exactly even when a primary display source exists', () => {
  const foreignWindow = source('window:other:0', '')
  const result = resolveScreenshotSource([primary, foreignWindow], foreignWindow.id, '1', owned, displays, displays)
  assert.strictEqual(result.source, foreignWindow)
  assert.equal(result.display, undefined)
})

test('default capture selects only the primary screen rather than a window on that display', () => {
  const result = resolveScreenshotSource([source('window:other:0'), source('screen:2:0', '2'), primary], undefined, '1', owned, displays, displays)
  assert.strictEqual(result.source, primary)
  assert.deepEqual(result.display, display())
  assert.throws(() => resolveScreenshotSource([source('window:other:0')], undefined, '1', owned, displays, displays), /unavailable/)
})

test('owned window source is rejected even before it appears in the returned source list', () => {
  assert.throws(() => resolveScreenshotSource([primary], 'window:faangin:0', '1', owned, displays, displays), /Faangin windows cannot be selected/)
  assert.throws(() => resolveScreenshotSource([source('window:faangin:0')], 'window:faangin:0', '1', owned, displays, displays), /Faangin windows cannot be selected/)
})

test('default primary source is also checked against owned source IDs', () => {
  assert.throws(() => resolveScreenshotSource([primary], undefined, '1', new Set([primary.id]), displays, displays), /Faangin windows cannot be selected/)
})

test('a missing explicit source never falls back to the available primary display', () => {
  for (const requestedId of ['window:closed:0', 'screen:removed:0']) {
    assert.throws(() => resolveScreenshotSource([primary], requestedId, '1', owned, displays, displays), /unavailable/)
  }
  assert.throws(() => resolveScreenshotSource([source('screen:2:0', '2')], undefined, '1', owned, displays, displays), /unavailable/)
})

test('ambiguous duplicate exact IDs and duplicate primary screen sources are rejected', () => {
  const foreignWindow = source('window:other:0')
  assert.throws(() => resolveScreenshotSource([foreignWindow, { ...foreignWindow }], foreignWindow.id, '1', owned, displays, displays), /unavailable/)
  assert.throws(() => resolveScreenshotSource([primary, { ...primary }], primary.id, '1', owned, displays, displays), /unavailable/)
  assert.throws(() => resolveScreenshotSource([primary, source('screen:1:1')], undefined, '1', owned, displays, displays), /unavailable/)
})

test('a display source with an empty display ID or unknown source kind cannot be verified', () => {
  const emptyDisplayId = source('screen:unknown:0', ''), unrecognizedKind = source('desktop:1:0')
  assert.throws(() => resolveScreenshotSource([emptyDisplayId], emptyDisplayId.id, '1', owned, displays, displays), /cannot be verified/)
  assert.throws(() => resolveScreenshotSource([emptyDisplayId], undefined, '', owned, displays, displays), /cannot be verified/)
  assert.throws(() => resolveScreenshotSource([unrecognizedKind], unrecognizedKind.id, '1', owned, displays, displays), /cannot be verified/)
})

test('a source display ID must exist both before and after capture', () => {
  assert.throws(() => resolveScreenshotSource([primary], primary.id, '1', owned, [], displays), /disconnected during capture/)
  assert.throws(() => resolveScreenshotSource([primary], primary.id, '1', owned, displays, []), /disconnected during capture/)
  const unknownDisplay = source('screen:unknown:0', 'unknown')
  assert.throws(() => resolveScreenshotSource([unknownDisplay], unknownDisplay.id, '1', owned, displays, displays), /disconnected during capture/)
  assert.throws(() => resolveScreenshotSource([primary], primary.id, '1', owned, [display('2')], [display('2')]), /disconnected during capture/)
})

test('changed display width, height or scale invalidates the capture', () => {
  for (const changed of [{ width: 1920 }, { height: 1080 }, { scaleFactor: 1 }]) {
    assert.throws(() => resolveScreenshotSource([primary], primary.id, '1', owned, displays, [display('1', changed)]), /changed during capture/)
  }
})

test('explicit secondary screen carries its verified metrics rather than those of the primary display', () => {
  const secondary = source('screen:2:0', '2'), metrics = display('2', { width: 2560, height: 1440, scaleFactor: 1 })
  const allDisplays = [display(), metrics]
  const result = resolveScreenshotSource([primary, secondary], secondary.id, '1', owned, allDisplays, allDisplays)
  assert.strictEqual(result.source, secondary)
  assert.deepEqual(result.display, metrics)
})

test('verified display metadata is copied so later display changes cannot alter an admitted result', () => {
  const before = [display()], after = [display()]
  const result = resolveScreenshotSource([primary], primary.id, '1', owned, before, after)
  assert.notStrictEqual(result.display, after[0])
  after[0].width = 1
  after[0].scaleFactor = 0.5
  assert.deepEqual(result.display, display())
  result.display!.height = 42
  assert.equal(after[0].height, 982)
  assert.deepEqual(before[0], display())
})

test('window capture does not infer scale from a display ID or demand stable display metrics', () => {
  const foreignWindow = source('window:other:0')
  const result = resolveScreenshotSource([foreignWindow], foreignWindow.id, '1', owned, displays, [display('1', { scaleFactor: 1 })])
  assert.strictEqual(result.source, foreignWindow)
  assert.equal(Object.hasOwn(result, 'display'), false)
  assert.deepEqual(resolveScreenshotSource([foreignWindow], foreignWindow.id, '1', owned, [], []), { source: foreignWindow })
})
