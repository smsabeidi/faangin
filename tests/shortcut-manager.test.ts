import test from 'node:test'
import assert from 'node:assert/strict'
import { RETIRED_SHORTCUT_PRESETS, SHORTCUT_PRESETS, ShortcutManager, applyStartupShortcutBindings, normalizeAccelerator, overridesAfterRetiredPreset, resolveShortcutBindings, shortcutLabel, type ShortcutAction, type ShortcutBinding, type ShortcutRegistrar } from '../src/main/shortcut-manager'
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
  assert.equal(shortcutLabel('Super+Shift+S', 'linux'), 'Shift+Win+S')
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

test('Windows presets move stop off the Task Manager chord while macOS and Linux keep their bytes', () => {
  for (const preset of SHORTCUT_PRESETS) {
    const stop = (platform: 'darwin' | 'win32' | 'linux') => resolveShortcutBindings(preset, {}, platform).find(item => item.action === 'stop')!.accelerator
    assert.equal(stop('darwin'), 'Command+Shift+Escape')
    assert.equal(stop('linux'), 'Control+Shift+Escape')
    assert.equal(stop('win32'), 'Control+Alt+Escape')
    for (const binding of resolveShortcutBindings(preset, {}, 'win32')) assert.equal(normalizeAccelerator(binding.accelerator, 'win32'), binding.accelerator, 'no Windows default is a reserved chord')
  }
  assert.equal(shortcutLabel('Control+Alt+Escape', 'win32'), 'Ctrl+Alt+Escape')
  assert.equal(shortcutLabel('Control+Alt+Escape', 'darwin'), '⌃⌥⎋')
})

test('Windows rejects OS-reserved chords with a reason while the same input still normalizes on macOS and Linux', () => {
  assert.throws(() => normalizeAccelerator('CommandOrControl+Shift+Escape', 'win32'), /^Error: Ctrl\+Shift\+Escape opens Task Manager on Windows and cannot be a Faangin shortcut\. Choose a different key combination\.$/)
  assert.equal(normalizeAccelerator('CommandOrControl+Shift+Escape', 'darwin'), 'Command+Shift+Escape')
  assert.equal(normalizeAccelerator('CommandOrControl+Shift+Escape', 'linux'), 'Control+Shift+Escape')
  for (const input of ['Ctrl+Shift+Esc', 'Control+Alt+Delete', 'Ctrl+Escape', 'Alt+Tab', 'Shift+Alt+Tab', 'Ctrl+Alt+Tab', 'Alt+Esc', 'Alt+Shift+Escape', 'Alt+F4', 'Super+Shift+S', 'Meta+Enter']) {
    assert.throws(() => normalizeAccelerator(input, 'win32'), /Choose a different key combination\.$/, input)
    assert.throws(() => shortcutLabel(input, 'win32'), /Choose a different key combination\.$/, input)
    normalizeAccelerator(input, 'darwin'); normalizeAccelerator(input, 'linux')
  }
  assert.throws(() => normalizeAccelerator('Super+Shift+S', 'win32'), /^Error: Shortcuts with the Windows key are reserved by Windows\. Choose a different key combination\.$/)
  assert.throws(() => normalizeAccelerator('Alt+F4', 'win32'), /^Error: Alt\+F4 closes the active window on Windows/)
  for (const input of ['Control+Alt+Escape', 'Ctrl+Alt+Shift+Escape', 'Control+Alt+S', 'Ctrl+Shift+S', 'Alt+Shift+F4', 'F12']) normalizeAccelerator(input, 'win32')
  assert.throws(() => normalizeAccelerator('Cmd+Enter', 'win32'), /Windows has no Command key/)
  assert.equal(normalizeAccelerator('Cmd+Enter', 'linux'), 'Command+Enter')
  assert.throws(() => normalizeAccelerator('Shift++', 'win32'), /Use Plus/)
})

test('saving a reserved override on Windows fails cleanly and leaves the registered shortcuts unchanged', () => {
  assert.throws(() => resolveShortcutBindings('faangin', { stop: 'Control+Shift+Escape' }, 'win32'), /Task Manager/)
  const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'win32')
  assert.equal(manager.apply(resolveShortcutBindings('faangin', {}, 'win32')).ok, true)
  const old = manager.bindings(), callbacks = new Map(registrar.callbacks)
  const result = manager.apply([...old.filter(item => item.action !== 'stop'), binding('stop', 'Ctrl+Shift+Esc')])
  assert.equal(result.ok, false)
  if (!result.ok) { assert.match(result.message, /Task Manager/); assert.deepEqual(result.failures, []) }
  assert.deepEqual(manager.bindings(), old)
  assert.deepEqual(registrar.callbacks, callbacks); assert.deepEqual(registrar.released, [])
  registrar.callbacks.get('Control+Alt+Escape')!(); assert.deepEqual(actions, ['stop'])
  manager.dispose()
})

test('startup shortcuts register on Windows even though the OS owns Ctrl+Shift+Esc', () => {
  for (const preset of SHORTCUT_PRESETS) {
    const registrar = new Registrar(), actions: ShortcutAction[] = [], manager = new ShortcutManager(registrar, action => actions.push(action), 'win32')
    registrar.occupied.add('Control+Shift+Escape')
    assert.equal(applyStartupShortcutBindings(manager, preset, {}, 'win32').ok, true)
    assert.equal(manager.bindings().length, resolveShortcutBindings(preset, {}, 'win32').length)
    assert.equal(registrar.callbacks.has('Control+Shift+Escape'), false)
    registrar.callbacks.get('Control+Alt+Escape')!(); registrar.callbacks.get('Control+Alt+S')!()
    assert.deepEqual(actions, ['stop', 'capture-solve'])
    manager.dispose()
  }
})

test('the retired keymap collision rule follows the platform stop default', () => {
  for (const platform of ['darwin', 'win32'] as const) assert.deepEqual(overridesAfterRetiredPreset({ assist: 'CommandOrControl+Shift+S' }, platform), { assist: 'CommandOrControl+Shift+S', screenshot: null })
  assert.deepEqual(overridesAfterRetiredPreset({ hide: 'Ctrl+Alt+Esc' }, 'win32'), { hide: 'Ctrl+Alt+Esc', stop: null })
  assert.deepEqual(overridesAfterRetiredPreset({ hide: 'Ctrl+Alt+Esc' }, 'darwin'), { hide: 'Ctrl+Alt+Esc' })
  assert.deepEqual(overridesAfterRetiredPreset({ hide: 'Cmd+Shift+Esc' }, 'darwin'), { hide: 'Cmd+Shift+Esc', stop: null })
  const bindings = resolveShortcutBindings('faangin', overridesAfterRetiredPreset({ hide: 'Ctrl+Alt+Esc' }, 'win32'), 'win32')
  assert.equal(new Set(bindings.map(item => item.accelerator)).size, bindings.length)
  assert.equal(bindings.some(item => item.action === 'stop'), false)
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
