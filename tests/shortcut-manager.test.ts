import test from 'node:test'
import assert from 'node:assert/strict'
import { RETIRED_SHORTCUT_PRESETS, SHORTCUT_PRESETS, ShortcutManager, applyStartupShortcutBindings, normalizeAccelerator, resolveShortcutBindings, shortcutLabel, type ShortcutAction, type ShortcutBinding, type ShortcutRegistrar } from '../src/main/shortcut-manager'
import { settingsPatch } from '../src/main/validation'

class Registrar implements ShortcutRegistrar {
  callbacks = new Map<string, () => void>(); occupied = new Set<string>(); throwing = new Set<string>(); released: string[] = []
  register(accelerator: string, callback: () => void) {
    if (this.throwing.has(accelerator)) throw new Error('Native registration failure')
    if (this.occupied.has(accelerator) || this.callbacks.has(accelerator)) return false
    this.callbacks.set(accelerator, callback); return true
  }
  unregister(accelerator: string) { this.callbacks.delete(accelerator); this.released.push(accelerator) }
}
const binding = (action: ShortcutAction, accelerator: string): ShortcutBinding => ({ action, label: action, accelerator })

test('platform and modifier aliases normalize to the same physical accelerator', () => {
  assert.equal(normalizeAccelerator('CmdOrCtrl+Return', 'darwin'), 'Command+Enter')
  assert.equal(normalizeAccelerator('Shift+Cmd+Enter', 'darwin'), 'Command+Shift+Enter')
  assert.equal(normalizeAccelerator('CommandOrControl+Return', 'win32'), 'Control+Enter')
  assert.equal(normalizeAccelerator('Ctrl+Enter', 'win32'), 'Control+Enter')
  assert.equal(normalizeAccelerator('Cmd+Backslash', 'darwin'), 'Command+\\')
  assert.equal(normalizeAccelerator('Ctrl+Plus', 'win32'), 'Control+Plus')
})
test('malformed accelerators cannot trap unmodified typing or silently duplicate modifiers', () => {
  for (const input of ['A', 'Shift++', 'CommandOrControl+Cmd+Enter', 'Command+Shift+NoSuchKey', 'Command+Bogus+Enter', '']) assert.throws(() => normalizeAccelerator(input, 'darwin'))
  assert.equal(normalizeAccelerator('F12', 'darwin'), 'F12')
})
test('platform labels reflect actual registered modifiers', () => {
  assert.equal(shortcutLabel('CommandOrControl+Shift+Enter', 'darwin'), '⌘⇧↩')
  assert.equal(shortcutLabel('CommandOrControl+Shift+Enter', 'win32'), 'Ctrl+Shift+Enter')
})
test('the Faangin and Cue presets remain distinct and always expose a stop action', () => {
  const baseline = resolveShortcutBindings('faangin', {}, 'darwin')
  assert.equal(baseline.find(item => item.action === 'screenshot')!.accelerator, 'Command+Shift+S')
  const cue = resolveShortcutBindings('cue', {}, 'darwin')
  assert.equal(cue.find(item => item.action === 'solve')!.accelerator, 'Command+H')
  assert.equal(cue.some(item => item.action === 'screenshot'), false)
  assert.deepEqual(SHORTCUT_PRESETS, ['faangin', 'cue'])
  for (const preset of SHORTCUT_PRESETS) assert.ok(resolveShortcutBindings(preset, {}, 'darwin').some(item => item.action === 'stop'))
})

test('saved settings that name a retired keymap fall back to Faangin instead of failing validation', () => {
  for (const preset of RETIRED_SHORTCUT_PRESETS) assert.deepEqual(settingsPatch({ shortcutPreset: preset }), { shortcutPreset: 'faangin' })
  assert.deepEqual(settingsPatch({ shortcutPreset: 'cue' }), { shortcutPreset: 'cue' })
  assert.throws(() => settingsPatch({ shortcutPreset: 'unknown' }))
})
test('custom override disables one shortcut and enables another without modifying preset defaults', () => {
  const custom = resolveShortcutBindings('faangin', { screenshot: null, reset: 'Cmd+G' }, 'darwin')
  assert.equal(custom.some(item => item.action === 'screenshot'), false)
  assert.equal(custom.find(item => item.action === 'reset')!.accelerator, 'Command+G')
  assert.ok(resolveShortcutBindings('faangin', {}, 'darwin').some(item => item.action === 'screenshot'))
})

test('every preset includes independent interaction and workspace recovery shortcuts without physical collisions', () => {
  for (const platform of ['darwin', 'win32'] as const) for (const preset of SHORTCUT_PRESETS) {
    const resolved = resolveShortcutBindings(preset, {}, platform)
    assert.equal(resolved.find(item => item.action === 'capture-solve')?.accelerator, 'Control+Alt+S')
    assert.equal(resolved.find(item => item.action === 'toggle-interaction')?.accelerator, 'Control+Alt+I')
    assert.equal(resolved.find(item => item.action === 'show-workspace')?.accelerator, 'Control+Alt+W')
    assert.equal(new Set(resolved.map(item => item.accelerator)).size, resolved.length)
  }
})

test('capture and solve supports overrides or menu-only operation without changing separate capture and solve actions', () => {
  const custom = resolveShortcutBindings('faangin', { 'capture-solve': 'Cmd+Shift+K' }, 'darwin')
  assert.equal(custom.find(item => item.action === 'capture-solve')?.accelerator, 'Command+Shift+K')
  assert.equal(custom.find(item => item.action === 'screenshot')?.accelerator, 'Command+Shift+S')
  assert.equal(custom.find(item => item.action === 'solve')?.accelerator, 'Command+Shift+Enter')
  assert.equal(resolveShortcutBindings('faangin', { 'capture-solve': null }, 'darwin').some(item => item.action === 'capture-solve'), false)
  assert.equal(shortcutLabel('Control+Alt+S', 'darwin'), '⌃⌥S')
})

test('a saved shortcut on the new default key survives startup and leaves only capture and solve unavailable', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  const overrides = { assist: 'Control+Alt+S' }
  assert.equal(applyStartupShortcutBindings(manager, 'faangin', overrides, 'darwin').ok, true)
  registrar.callbacks.get('Control+Alt+S')!()
  assert.deepEqual(actions, ['assist'])
  assert.equal(manager.bindings().some(binding => binding.action === 'capture-solve'), false)
  assert.ok(manager.bindings().some(binding => binding.action === 'show-workspace'))
  assert.ok(resolveShortcutBindings('faangin', overrides, 'darwin').some(binding => binding.action === 'capture-solve'))
  manager.dispose()
})

test('another app owning the new default cannot disable existing startup shortcuts', () => {
  const registrar = new Registrar(), manager = new ShortcutManager(registrar, () => {}, 'darwin')
  registrar.occupied.add('Control+Alt+S')
  assert.equal(applyStartupShortcutBindings(manager, 'faangin', {}, 'darwin').ok, true)
  assert.equal(manager.bindings().some(binding => binding.action === 'capture-solve'), false)
  assert.ok(registrar.callbacks.has('Command+Shift+S'))
  assert.ok(registrar.callbacks.has('Control+Alt+I'))
  assert.ok(registrar.callbacks.has('Control+Alt+W'))
  manager.dispose()
})

test('explicit capture and solve conflicts keep atomic rejection for startup and user edits', () => {
  const registrar = new Registrar(), manager = new ShortcutManager(registrar, () => {}, 'darwin')
  assert.equal(manager.apply(resolveShortcutBindings('faangin', {}, 'darwin')).ok, true)
  const old = manager.bindings()
  assert.equal(applyStartupShortcutBindings(manager, 'faangin', { 'capture-solve': 'Cmd+Enter' }, 'darwin').ok, false)
  assert.deepEqual(manager.bindings(), old)
  assert.equal(manager.apply(resolveShortcutBindings('faangin', { screenshot: 'Control+Alt+S' }, 'darwin')).ok, false)
  assert.deepEqual(manager.bindings(), old)
  manager.dispose()
})

test('a failed shortcut edit cannot remove previously registered overlay recovery shortcuts', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  assert.equal(manager.apply(resolveShortcutBindings('faangin', {}, 'darwin')).ok, true)
  registrar.occupied.add('Command+J')
  assert.equal(manager.apply(resolveShortcutBindings('faangin', { 'toggle-interaction': 'Cmd+J', 'show-workspace': null }, 'darwin')).ok, false)
  registrar.callbacks.get('Control+Alt+I')!(); registrar.callbacks.get('Control+Alt+W')!()
  assert.deepEqual(actions, ['toggle-interaction', 'show-workspace'])
  assert.ok(manager.bindings().some(item => item.action === 'show-workspace'))
  manager.dispose()
})
test('registrations are owned locally and dispatch the committed action', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  registrar.occupied.add('Command+P')
  assert.equal(manager.apply([binding('assist', 'Cmd+Enter')]).ok, true)
  registrar.callbacks.get('Command+Enter')!(); assert.deepEqual(actions, ['assist'])
  manager.dispose(); assert.equal(registrar.callbacks.size, 0); assert.equal(registrar.occupied.has('Command+P'), true)
})
test('a native conflict rolls back staged keys while retaining the previous keymap and callback', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  manager.apply([binding('assist', 'Cmd+Enter')]); registrar.occupied.add('Command+B')
  const result = manager.apply([binding('solve', 'Cmd+Shift+Enter'), binding('hide', 'Cmd+B')])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.failures[0].action, 'hide')
  assert.equal(registrar.callbacks.has('Command+Shift+Enter'), false)
  registrar.callbacks.get('Command+Enter')!(); assert.deepEqual(actions, ['assist'])
  assert.deepEqual(manager.bindings().map(item => item.action), ['assist']); manager.dispose()
})
test('callback action swaps commit without unregistering existing native keys', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  manager.apply([binding('assist', 'Cmd+Enter'), binding('solve', 'Cmd+Shift+Enter')])
  const first = registrar.callbacks.get('Command+Enter')
  assert.equal(manager.apply([binding('solve', 'Cmd+Enter'), binding('assist', 'Cmd+Shift+Enter')]).ok, true)
  assert.equal(registrar.callbacks.get('Command+Enter'), first); assert.equal(registrar.released.length, 0)
  first!(); assert.deepEqual(actions, ['solve']); manager.dispose()
})
test('collision validation occurs before native registrations and handles aliases', () => {
  const registrar = new Registrar(), manager = new ShortcutManager(registrar, () => {}, 'darwin')
  const result = manager.apply([binding('assist', 'Cmd+Return'), binding('solve', 'CommandOrControl+Enter')])
  assert.equal(result.ok, false); assert.equal(registrar.callbacks.size, 0)
  assert.equal(manager.apply([binding('assist', 'Cmd+Enter'), binding('assist', 'Cmd+A')]).ok, false)
})
test('new native callbacks cannot dispatch before all registrations commit', () => {
  const actions: ShortcutAction[] = [], registrar = new Registrar()
  const register = registrar.register.bind(registrar)
  registrar.register = (key, callback) => { callback(); return register(key, callback) }
  const manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  assert.equal(manager.apply([binding('solve', 'Cmd+Shift+Enter')]).ok, true)
  assert.deepEqual(actions, []); registrar.callbacks.get('Command+Shift+Enter')!(); assert.deepEqual(actions, ['solve']); manager.dispose()
})
test('native exceptions report failure and leave the previous bindings usable', () => {
  const registrar = new Registrar(), manager = new ShortcutManager(registrar, () => {}, 'darwin')
  manager.apply([binding('assist', 'Cmd+Enter')]); registrar.throwing.add('Command+H')
  assert.equal(manager.apply([binding('screenshot', 'Cmd+H')]).ok, false)
  assert.equal(registrar.callbacks.has('Command+Enter'), true); manager.dispose()
})
test('disabling all bindings leaves menu-only operation and prevents stale callback dispatch', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  manager.apply([binding('assist', 'Cmd+Enter')]); const old = registrar.callbacks.get('Command+Enter')!
  manager.apply([]); old(); assert.deepEqual(actions, []); assert.equal(registrar.callbacks.size, 0)
})
test('returned snapshots cannot mutate the live callback map', () => {
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'darwin')
  manager.apply([binding('assist', 'Cmd+Enter')]); manager.bindings()[0].action = 'solve'
  registrar.callbacks.get('Command+Enter')!(); assert.deepEqual(actions, ['assist']); manager.dispose()
})
