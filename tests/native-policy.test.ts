import test from 'node:test'
import assert from 'node:assert/strict'
import { MacDockPolicy, OverlayInteractionPolicy, type OverlayWindowPort } from '../src/main/native-policy'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { settingsPatch } from '../src/main/validation'

class Window implements OverlayWindowPort {
  destroyed = false
  visible = false
  focused = false
  focusable = true
  skipTaskbar: boolean | null = null
  ignoresMouse = false
  blurCalls = 0
  focusCalls = 0
  focusableCalls = 0
  ignoreCalls = 0
  taskbarShown = 0
  /** Windows deactivates the window when it stops being focusable; macOS only changes the flag. */
  relinquishesFocus = false
  activeShows = 0
  inactiveShows = 0
  forwarded: unknown[] = []
  isDestroyed() { return this.destroyed }
  isFocused() { return this.focused }
  setIgnoreMouseEvents(value: boolean, ...options: unknown[]) { this.ignoresMouse = value; this.ignoreCalls++; this.forwarded.push(...options) }
  // Model Electron: macOS does not remove existing focus here, and Windows couples the call to SetSkipTaskbar(!focusable) and deactivates the window.
  setFocusable(value: boolean) { this.focusable = value; this.focusableCalls++; this.skipTaskbar = !value; if (this.relinquishesFocus && this.visible) this.focused = false }
  setSkipTaskbar(value: boolean) { this.skipTaskbar = value; if (!value) this.taskbarShown++ }
  blur() { this.focused = false; this.blurCalls++ }
  showInactive() { this.visible = true; this.inactiveShows++ }
  show() { this.visible = true; this.activeShows++; if (this.focusable) this.focused = true }
  focus() { this.focusCalls++; if (this.focusable) this.focused = true }
  hide() { this.visible = false; this.focused = false }
}

test('a new overlay accepts mouse input without requesting keyboard focus during background presentation', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window); policy.showOutput()
  assert.equal(policy.passive, false)
  assert.equal(window.ignoresMouse, false); assert.equal(window.focusable, true)
  assert.deepEqual(window.forwarded, [])
  assert.equal(window.visible, true); assert.equal(window.focused, false)
  assert.equal(window.activeShows + window.focusCalls, 0)
})

test('every native mode change re-asserts the hidden taskbar button that Windows couples to focusability', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window)
  assert.equal(window.skipTaskbar, true)
  policy.setPassive(true); assert.equal(window.skipTaskbar, true)
  policy.setPassive(false); assert.equal(window.skipTaskbar, true)
  policy.showOutput(); assert.equal(window.skipTaskbar, true)
})

test('revealing an already-visible overlay never repeats the focus-coupled native calls that Windows turns into a focus loss', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  window.relinquishesFocus = true
  policy.attach(window); policy.showInteractive()
  assert.equal(window.focused, true)
  const focusable = window.focusableCalls, ignore = window.ignoreCalls, shown = window.taskbarShown, blurs = window.blurCalls
  // Answer presentation, nudges and the toggle path all reveal an overlay that is already on screen.
  policy.showOutput(); policy.showOutput()
  assert.equal(window.focused, true) // The composer keeps keyboard focus while the answer lands.
  policy.toggleVisibility(); policy.toggleVisibility()
  assert.equal(window.focused, false) // hide() clears focus; the reveal itself did not.
  policy.showInteractive(); policy.showOutput(); policy.showOutput()
  assert.equal(window.focused, true)
  assert.equal(window.focusableCalls, focusable); assert.equal(window.ignoreCalls, ignore)
  assert.equal(window.taskbarShown, shown); assert.equal(window.blurCalls, blurs)
  assert.equal(window.skipTaskbar, true)
})

test('click-through reveals neither re-apply focusability nor blur again, while a real mode change still applies fully', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  window.relinquishesFocus = true
  policy.attach(window); policy.showInteractive(); policy.setPassive(true)
  assert.equal(window.focusable, false); assert.equal(window.ignoresMouse, true); assert.equal(window.blurCalls, 0)
  const focusable = window.focusableCalls, ignore = window.ignoreCalls
  policy.showOutput(); policy.showOutput(); policy.setPassive(true)
  assert.equal(window.focusableCalls, focusable); assert.equal(window.ignoreCalls, ignore)
  assert.equal(window.skipTaskbar, true)
  policy.setPassive(false)
  assert.equal(window.focusable, true); assert.equal(window.ignoresMouse, false)
  assert.equal(window.focusableCalls, focusable + 1); assert.equal(window.ignoreCalls, ignore + 1)
  assert.equal(window.skipTaskbar, true)
})

test('a window object that replaces the overlay is fully re-applied even when the mode did not change', () => {
  const policy = new OverlayInteractionPolicy(), old = new Window(), replacement = new Window()
  policy.attach(old); policy.showOutput(); policy.showOutput()
  assert.equal(old.focusableCalls, 1); assert.equal(old.ignoreCalls, 1)
  policy.attach(replacement)
  assert.equal(replacement.focusableCalls, 1); assert.equal(replacement.ignoreCalls, 1)
  assert.equal(replacement.focusable, true); assert.equal(replacement.ignoresMouse, false)
  policy.showOutput(); assert.equal(replacement.focusableCalls, 1)
  policy.attach(replacement); assert.equal(replacement.focusableCalls, 2) // Re-attaching always re-applies.
})

test('enabling click-through on a focused interactive overlay relinquishes existing macOS key focus', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window); policy.showInteractive()
  assert.equal(window.focused, true)
  policy.setPassive(true)
  assert.equal(window.focusable, false); assert.equal(window.focused, false)
  assert.equal(window.blurCalls, 1); assert.equal(window.visible, true)
  policy.showOutput(); assert.equal(window.blurCalls, 1)
})

test('explicit recovery restores mouse and keyboard input, while answer reveals never focus even in interactive mode', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window); policy.setPassive(true); policy.showOutput(); policy.showInteractive()
  assert.equal(window.ignoresMouse, false); assert.equal(window.focusable, true); assert.equal(window.focused, true)
  policy.hide()
  const activeShows = window.activeShows, focusCalls = window.focusCalls
  policy.showOutput()
  assert.equal(policy.passive, false); assert.equal(window.focused, false)
  assert.equal(window.activeShows, activeShows); assert.equal(window.focusCalls, focusCalls)
})

test('hide/show toggles and move/answer reveals preserve passive mode without focusing', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window); policy.setPassive(true); policy.showOutput(); policy.toggleVisibility()
  assert.equal(window.visible, false); assert.equal(policy.desiredVisible, false)
  policy.toggleVisibility(); policy.showOutput(); policy.showOutput()
  assert.equal(window.visible, true); assert.equal(policy.passive, true)
  assert.equal(window.focusCalls + window.activeShows, 0)
})

test('an answer finishing after an explicit Hide cannot reopen the overlay', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window); policy.showOutput()
  const pendingAnswer = policy.checkpoint()
  policy.hide()
  assert.equal(policy.showOutput(pendingAnswer), false)
  assert.equal(window.visible, false); assert.equal(policy.desiredVisible, false)
  assert.equal(policy.showOutput(policy.checkpoint()), true)
})

test('an explicit interaction change supersedes a pending shortcut reveal without resetting mode', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window)
  const pending = policy.checkpoint()
  policy.showInteractive(); policy.setPassive(true)
  assert.equal(policy.showOutput(pending), false)
  assert.equal(policy.passive, true); assert.equal(window.focused, false)
})

test('temporary screenshot hiding does not invert the user visibility intent', () => {
  const policy = new OverlayInteractionPolicy(), window = new Window()
  policy.attach(window); policy.showOutput()
  window.hide() // Screenshot capture temporarily excludes owned windows.
  assert.equal(policy.desiredVisible, true)
  policy.toggleVisibility()
  assert.equal(policy.desiredVisible, false); assert.equal(window.visible, false)
})

test('a recreated overlay receives the retained native mode before any show', () => {
  const policy = new OverlayInteractionPolicy(), old = new Window(), replacement = new Window()
  policy.attach(old); policy.setPassive(true); policy.showOutput(); old.destroyed = true
  assert.equal(policy.showOutput(), false)
  policy.attach(replacement)
  assert.equal(replacement.ignoresMouse, true); assert.equal(replacement.focusable, false)
  assert.equal(replacement.visible, false)
  policy.showInteractive(); replacement.destroyed = true
  const next = new Window(); policy.attach(next)
  assert.equal(policy.passive, false); assert.equal(next.ignoresMouse, false); assert.equal(next.focusable, true)
  assert.equal(next.visible, false); assert.equal(next.focusCalls + next.activeShows, 0)
})

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function dockFixture(platform = 'darwin') {
  let now = 0
  const timers = new Map<() => void, number>(), calls: string[] = [], errors: unknown[] = [], shows: ReturnType<typeof deferred>[] = []
  const policy = new MacDockPolicy({
    platform, setActivationPolicy: value => { calls.push(value) }, hide: () => { calls.push('hide') },
    show: () => { calls.push('show'); const item = deferred(); shows.push(item); return item.promise }, onError: error => { errors.push(error) },
    clock: { now: () => now, schedule: (callback, delay) => { timers.set(callback, now + delay); return () => { timers.delete(callback) } } }
  })
  return { policy, calls, errors, shows, timers, tick: (elapsed: number) => { now += elapsed; for (const [callback, at] of [...timers]) if (at <= now) { timers.delete(callback); callback() } } }
}

test('Dock hiding uses standard accessory activation and showing uses regular activation', async () => {
  const f = dockFixture()
  f.policy.apply(true); f.policy.apply(true)
  assert.deepEqual(f.calls, ['accessory', 'hide'])
  f.policy.apply(false); f.shows[0].resolve(); await Promise.resolve()
  assert.deepEqual(f.calls, ['accessory', 'hide', 'regular', 'show'])
})

test('rapid Dock changes retain the latest intent and respect the documented hide interval', async () => {
  const f = dockFixture()
  f.policy.apply(true); f.tick(100); f.policy.apply(false); f.policy.apply(true)
  assert.equal(f.calls.filter(item => item === 'hide').length, 1)
  f.shows[0].resolve(); await Promise.resolve()
  f.tick(999); assert.equal(f.calls.filter(item => item === 'hide').length, 1)
  f.tick(1); assert.equal(f.calls.filter(item => item === 'hide').length, 2)
  assert.equal(f.calls.at(-2), 'accessory'); assert.equal(f.calls.at(-1), 'hide')
})

test('showing the Dock cancels a queued hide and stale show completion cannot hide a newer visible preference', async () => {
  const f = dockFixture()
  f.policy.apply(true); f.policy.apply(false); f.policy.apply(true); f.policy.apply(false)
  assert.equal(f.timers.size, 0)
  f.shows[0].resolve(); f.shows[1].resolve(); await Promise.resolve(); f.tick(2000)
  assert.equal(f.calls.at(-1), 'show'); assert.equal(f.calls.filter(item => item === 'hide').length, 1)
})

test('Dock completion after disposal cannot change activation policy or schedule timers', async () => {
  const f = dockFixture()
  f.policy.apply(false); f.policy.apply(true); f.policy.dispose()
  const before = [...f.calls]
  f.shows[0].resolve(); await Promise.resolve(); f.tick(2000); f.policy.apply(false)
  assert.deepEqual(f.calls, before); assert.equal(f.timers.size, 0)
})

test('Dock visibility failures report once and stale failures do not overwrite a newer preference', async () => {
  const f = dockFixture()
  f.policy.apply(false); f.shows[0].reject(new Error('current failure')); await Promise.resolve()
  assert.equal(f.errors.length, 1)
  f.policy.apply(true); f.policy.apply(false); f.policy.apply(true)
  f.shows[1].reject(new Error('stale failure')); await Promise.resolve()
  assert.equal(f.errors.length, 1)
})

test('non-macOS platforms never call macOS activation or Dock APIs', () => {
  for (const platform of ['win32', 'linux']) {
    const f = dockFixture(platform)
    f.policy.apply(true); f.policy.apply(false); f.policy.dispose()
    assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0)
  }
})

test('Dock preference is strictly boolean and defaults to hidden for the macOS utility behavior', () => {
  assert.equal(DEFAULT_SETTINGS.hideDockIcon, true)
  assert.deepEqual(settingsPatch({ hideDockIcon: true }), { hideDockIcon: true })
  assert.deepEqual(settingsPatch({ hideDockIcon: false }), { hideDockIcon: false })
  for (const hideDockIcon of ['true', 1, null, undefined]) assert.throws(() => settingsPatch({ hideDockIcon }))
})
