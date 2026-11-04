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

test('a display source with an empty display ID is only verifiable against the sole display, and an unknown source kind never is', () => {
  const emptyDisplayId = source('screen:unknown:0', ''), unrecognizedKind = source('desktop:1:0')
  const twoDisplays = [display('1'), display('2')]
  assert.throws(() => resolveScreenshotSource([emptyDisplayId], emptyDisplayId.id, '1', owned, twoDisplays, twoDisplays), /cannot be verified/)
  assert.throws(() => resolveScreenshotSource([emptyDisplayId], undefined, '', owned, twoDisplays, twoDisplays), /cannot be verified/)
  assert.throws(() => resolveScreenshotSource([emptyDisplayId], emptyDisplayId.id, '1', owned, [], []), /cannot be verified/)
  assert.throws(() => resolveScreenshotSource([unrecognizedKind], unrecognizedKind.id, '1', owned, displays, displays), /cannot be verified/)
})

test('a duplicated or remote display with an empty display ID is captured when it is the only display, using that display’s verified metrics', () => {
  // Win+P Duplicate and Remote Desktop present one logical display whose source Windows leaves unlabeled.
  const unlabeled = source('screen:0:0', ''), remote = display('7', { width: 1920, height: 1080, scaleFactor: 1.5 })
  for (const requestedId of [undefined, unlabeled.id]) {
    const result = resolveScreenshotSource([unlabeled], requestedId, '7', owned, [remote], [remote])
    assert.strictEqual(result.source, unlabeled); assert.deepEqual(result.display, remote); assert.notStrictEqual(result.display, remote)
  }
  assert.deepEqual(resolveScreenshotSource([unlabeled, source('window:other:0', '')], undefined, '7', owned, [remote], [remote]).display, remote)
  // The pairing keeps every guard a labeled source has.
  assert.throws(() => resolveScreenshotSource([unlabeled], unlabeled.id, '7', owned, [remote], [display('7', { scaleFactor: 1 })]), /changed during capture/)
  assert.throws(() => resolveScreenshotSource([unlabeled], undefined, '7', owned, [remote], [display('7', { width: 1280 })]), /changed during capture/)
  assert.throws(() => resolveScreenshotSource([unlabeled], unlabeled.id, '7', owned, [remote], [{ ...remote, id: '8' }]), /cannot be verified/)
  assert.throws(() => resolveScreenshotSource([unlabeled], undefined, '7', owned, [remote], [{ ...remote, id: '8' }]), /unavailable/)
  assert.throws(() => resolveScreenshotSource([unlabeled], undefined, '7', new Set([unlabeled.id]), [remote], [remote]), /Faangin windows cannot be selected/)
})

test('an unlabeled screen is never guessed once the choice is ambiguous', () => {
  const unlabeled = source('screen:0:0', ''), other = source('screen:1:0', ''), mismatched = source('screen:1:0', '9'), only = [display('7')]
  assert.throws(() => resolveScreenshotSource([unlabeled, other], undefined, '7', owned, only, only), /unavailable/)
  assert.throws(() => resolveScreenshotSource([unlabeled, mismatched], undefined, '7', owned, only, only), /unavailable/)
  assert.throws(() => resolveScreenshotSource([mismatched], undefined, '7', owned, only, only), /unavailable/)
  assert.throws(() => resolveScreenshotSource([source('window:other:0', '')], undefined, '7', owned, only, only), /unavailable/)
  const pair = [display('7'), display('8')]
  assert.throws(() => resolveScreenshotSource([unlabeled], undefined, '7', owned, pair, pair), /unavailable/)
  assert.throws(() => resolveScreenshotSource([unlabeled], unlabeled.id, '7', owned, pair, pair), /cannot be verified/)
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

test('Windows-shaped sources resolve by the numeric display_id Electron maps from the monitor, at any DPI scale', () => {
  // Electron on Windows names screens `screen:<index>:0`, reports display_id as the display::win id and windows as `window:<HWND>:0`.
  const laptop = display('2528732444', { width: 1536, height: 864, scaleFactor: 1.25 }), external = display('1234567890', { width: 2560, height: 1440, scaleFactor: 1.5 })
  const screens = [source('screen:0:0', '2528732444'), source('screen:1:0', '1234567890')], windowsDisplays = [laptop, external]
  const primary = resolveScreenshotSource(screens, undefined, '2528732444', owned, windowsDisplays, windowsDisplays)
  assert.strictEqual(primary.source, screens[0]); assert.deepEqual(primary.display, laptop)
  const chosen = resolveScreenshotSource(screens, 'screen:1:0', '2528732444', owned, windowsDisplays, windowsDisplays)
  assert.strictEqual(chosen.source, screens[1]); assert.deepEqual(chosen.display, external)
  const hwnd = source('window:131726:0', '')
  assert.deepEqual(resolveScreenshotSource([...screens, hwnd], hwnd.id, '2528732444', owned, windowsDisplays, windowsDisplays), { source: hwnd })
  // An unlabeled screen among several displays is not guessed: the default and explicit paths both refuse to pick which monitor it is.
  const duplicated = source('screen:0:0', '')
  assert.throws(() => resolveScreenshotSource([duplicated, screens[1]], undefined, '2528732444', owned, windowsDisplays, windowsDisplays), /unavailable/)
  assert.throws(() => resolveScreenshotSource([duplicated], duplicated.id, '2528732444', owned, windowsDisplays, windowsDisplays), /cannot be verified/)
  // Only the DIP bounds and scale are compared, so physical-pixel thumbnails on a mixed-DPI desktop need no conversion.
  assert.throws(() => resolveScreenshotSource(screens, 'screen:1:0', '2528732444', owned, windowsDisplays, [laptop, display('1234567890', { width: 2560, height: 1440, scaleFactor: 1 })]), /changed during capture/)
})

test('window capture does not infer scale from a display ID or demand stable display metrics', () => {
  const foreignWindow = source('window:other:0')
  const result = resolveScreenshotSource([foreignWindow], foreignWindow.id, '1', owned, displays, [display('1', { scaleFactor: 1 })])
  assert.strictEqual(result.source, foreignWindow)
  assert.equal(Object.hasOwn(result, 'display'), false)
  assert.deepEqual(resolveScreenshotSource([foreignWindow], foreignWindow.id, '1', owned, [], []), { source: foreignWindow })
})
