export const SHORTCUT_ACTIONS = ['capture-solve', 'assist', 'reply', 'screenshot', 'solve', 'hide', 'toggle-interaction', 'show-workspace', 'stop', 'reset', 'toggle-capture', 'move-left', 'move-right', 'move-up', 'move-down', 'scroll-up', 'scroll-down'] as const
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]
export type ShortcutPreset = 'faangin' | 'cluely' | 'interviewcoder' | 'cue'
export type ShortcutOverrides = Partial<Record<ShortcutAction, string | null>>
export interface ShortcutBinding { action: ShortcutAction; label: string; accelerator: string }
export interface ShortcutRegistrar { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }
export interface ShortcutFailure { action: ShortcutAction; accelerator: string; message: string }
export type ShortcutApplyResult = { ok: true; bindings: ShortcutBinding[] } | { ok: false; bindings: ShortcutBinding[]; failures: ShortcutFailure[]; message: string }
const labels: Record<ShortcutAction, string> = {
  'capture-solve': 'Capture & solve',
  assist: 'Assist', reply: 'Suggested reply', screenshot: 'Capture screenshot', solve: 'Solve', hide: 'Show / hide overlay', stop: 'Stop capture', reset: 'Reset problem context',
  'toggle-interaction': 'Toggle overlay interaction', 'show-workspace': 'Show workspace',
  'toggle-capture': 'Start / stop capture', 'move-left': 'Move overlay left', 'move-right': 'Move overlay right', 'move-up': 'Move overlay up', 'move-down': 'Move overlay down', 'scroll-up': 'Scroll answers up', 'scroll-down': 'Scroll answers down'
}
const presets: Record<ShortcutPreset, ShortcutOverrides> = {
  faangin: { assist: 'CommandOrControl+Enter', screenshot: 'CommandOrControl+Shift+S', hide: 'CommandOrControl+Shift+Space', solve: 'CommandOrControl+Shift+Enter', stop: 'CommandOrControl+Shift+Escape' },
  cluely: { assist: 'CommandOrControl+Enter', hide: 'CommandOrControl+Backslash', 'toggle-capture': 'CommandOrControl+Shift+Backslash', 'scroll-up': 'CommandOrControl+Shift+Up', 'scroll-down': 'CommandOrControl+Shift+Down', stop: 'CommandOrControl+Shift+Escape' },
  interviewcoder: { screenshot: 'CommandOrControl+H', reset: 'CommandOrControl+G', hide: 'CommandOrControl+B', 'move-left': 'CommandOrControl+Left', 'move-right': 'CommandOrControl+Right', 'move-up': 'CommandOrControl+Up', 'move-down': 'CommandOrControl+Down', stop: 'CommandOrControl+Shift+Escape' },
  cue: { assist: 'CommandOrControl+Shift+Enter', reply: 'CommandOrControl+Enter', solve: 'CommandOrControl+H', hide: 'CommandOrControl+Shift+Slash', stop: 'CommandOrControl+Shift+Escape' }
}
const modifiers: Record<string, string> = { commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl', command: 'Command', cmd: 'Command', control: 'Control', ctrl: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Super', super: 'Super' }
const keys: Record<string, string> = { enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right', plus: 'Plus', minus: '-', '-': '-', backslash: '\\', '\\': '\\', slash: '/', '/': '/', comma: ',', ',': ',', period: '.', '.': '.' }
/** Canonicalizes platform aliases so Cmd+Return and CommandOrControl+Enter collide on macOS. */
export function normalizeAccelerator(value: string, platform = process.platform): string {
  if (typeof value !== 'string' || value.length > 160 || !value.trim()) throw new Error('Enter a keyboard shortcut with a key and modifier.')
  const parts = value.split('+').map(part => part.trim().toLowerCase())
  if (parts.some(part => !part)) throw new Error('Use Plus for the + key.')
  const keyInput = parts.pop()!, key = keys[keyInput] ?? (/^[a-z0-9]$/.test(keyInput) ? keyInput.toUpperCase() : /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(keyInput) ? keyInput.toUpperCase() : undefined)
  if (!key) throw new Error('This shortcut key is not supported.')
  const normalized = parts.map(part => {
    let modifier = modifiers[part]
    if (!modifier) throw new Error('This shortcut modifier is not supported.')
    if (modifier === 'CommandOrControl') modifier = platform === 'darwin' ? 'Command' : 'Control'
    if (modifier === 'Super' && platform === 'darwin') modifier = 'Command'
    return modifier
  })
  if (new Set(normalized).size !== normalized.length) throw new Error('A shortcut modifier was specified twice.')
  if (!normalized.length && !/^F\d+$/.test(key)) throw new Error('Global shortcuts require a modifier or function key.')
  const order = ['Command', 'Control', 'Alt', 'Shift', 'Super']
  normalized.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [...normalized, key].join('+')
}
export function shortcutLabel(accelerator: string, platform = process.platform): string {
  const normalized = normalizeAccelerator(accelerator, platform)
  if (platform !== 'darwin') return normalized.replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win')
  return normalized.split('+').map(part => ({ Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: '⎋', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space' }[part] ?? part)).join('')
}
export function resolveShortcutBindings(preset: ShortcutPreset, overrides: ShortcutOverrides = {}, platform = process.platform): ShortcutBinding[] {
  if (!Object.hasOwn(presets, preset)) throw new Error('Choose a supported shortcut preset.')
  for (const key of Object.keys(overrides)) if (!SHORTCUT_ACTIONS.includes(key as ShortcutAction)) throw new Error('This shortcut action is not supported.')
  const mapping = { 'capture-solve': 'Control+Alt+S', 'toggle-interaction': 'Control+Alt+I', 'show-workspace': 'Control+Alt+W', ...presets[preset], ...overrides }
  return SHORTCUT_ACTIONS.filter(action => mapping[action] != null).map(action => ({ action, label: labels[action], accelerator: normalizeAccelerator(mapping[action]!, platform) }))
}

/** A new optional default must not disable a previously working startup keymap. */
export function applyStartupShortcutBindings(manager: ShortcutManager, preset: ShortcutPreset, overrides: ShortcutOverrides = {}, platform = process.platform): ShortcutApplyResult {
  const configured = resolveShortcutBindings(preset, overrides, platform)
  const implicitCapture = !Object.hasOwn(overrides, 'capture-solve')
  const capture = configured.find(binding => binding.action === 'capture-solve')
  const savedConflict = implicitCapture && capture && configured.some(binding => binding.action !== 'capture-solve' && binding.accelerator === capture.accelerator)
  const bindings = savedConflict ? configured.filter(binding => binding.action !== 'capture-solve') : configured
  const result = manager.apply(bindings)
  if (!result.ok && implicitCapture && result.failures.length > 0 && result.failures.every(failure => failure.action === 'capture-solve')) {
    return manager.apply(bindings.filter(binding => binding.action !== 'capture-solve'))
  }
  return result
}

/** Newly registered callbacks stay dormant until every binding succeeds; existing callbacks read the committed map. */
export class ShortcutManager {
  private active = new Map<string, ShortcutBinding>()
  private owned = new Set<string>()
  constructor(private registrar: ShortcutRegistrar, private dispatch: (action: ShortcutAction) => void, private platform = process.platform) {}
  bindings(): ShortcutBinding[] { return [...this.active.values()].map(binding => ({ ...binding })) }
  apply(bindings: ShortcutBinding[]): ShortcutApplyResult {
    const desired = new Map<string, ShortcutBinding>(), actions = new Set<string>()
    try {
      for (const binding of bindings) {
        if (!SHORTCUT_ACTIONS.includes(binding.action)) throw new Error('This shortcut action is not supported.')
        const accelerator = normalizeAccelerator(binding.accelerator, this.platform)
        if (actions.has(binding.action)) throw new Error('An action has more than one shortcut.')
        if (desired.has(accelerator)) return { ok: false, bindings: this.bindings(), failures: [{ action: binding.action, accelerator, message: `${binding.label} conflicts with ${desired.get(accelerator)!.label}.` }], message: 'Two actions use the same keyboard shortcut. Your previous shortcuts are unchanged.' }
        actions.add(binding.action); desired.set(accelerator, { ...binding, accelerator })
      }
    } catch (error) { return { ok: false, bindings: this.bindings(), failures: [], message: error instanceof Error ? error.message : 'Invalid shortcut configuration.' } }
    const staged: string[] = [], failures: ShortcutFailure[] = []
    for (const [accelerator, binding] of desired) {
      if (this.owned.has(accelerator)) continue
      let registered = false
      try { registered = this.registrar.register(accelerator, () => { const current = this.active.get(accelerator); if (current) this.dispatch(current.action) }) } catch {}
      if (!registered) { failures.push({ action: binding.action, accelerator, message: 'Another app or the operating system owns this shortcut. Choose a different key combination.' }); break }
      this.owned.add(accelerator); staged.push(accelerator)
    }
    if (failures.length) {
      for (const accelerator of staged) this.release(accelerator)
      return { ok: false, bindings: this.bindings(), failures, message: 'Shortcut registration failed. Your previous shortcuts are unchanged; menu actions remain available.' }
    }
    // No native unregister is required for swaps: callbacks resolve their action at dispatch time.
    this.active = desired
    for (const accelerator of [...this.owned]) if (!desired.has(accelerator)) this.release(accelerator)
    return { ok: true, bindings: this.bindings() }
  }
  private release(accelerator: string): void {
    try { this.registrar.unregister(accelerator); this.owned.delete(accelerator) } catch { /* An orphan callback is dormant; retain ownership so dispose can retry. */ }
  }
  dispose(): void { this.active.clear(); for (const accelerator of [...this.owned]) this.release(accelerator) }
}
