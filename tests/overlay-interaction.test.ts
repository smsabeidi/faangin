import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import OverlayInteractionButton from '../src/renderer/src/OverlayInteractionButton'
import { overlayInteractionDescription, overlayInteractionRecovery } from '../src/renderer/src/overlay-interaction'
import Settings from '../src/renderer/src/Settings'

const binding: AppState['shortcuts'][number] = { id: 'toggle-interaction', action: 'Toggle overlay interaction', accelerator: 'Control+Alt+I', registered: true }

test('overlay recovery advertises the registered platform binding and honors custom combinations', () => {
  assert.equal(overlayInteractionRecovery([binding], 'darwin').shortcut, '⌃⌥I')
  assert.match(overlayInteractionRecovery([binding], 'darwin').hint, /menu bar/)
  const custom = { ...binding, accelerator: 'Control+Alt+P' }
  assert.equal(overlayInteractionRecovery([custom], 'win32').shortcut, 'Ctrl+Alt+P')
  assert.match(overlayInteractionRecovery([custom], 'win32').hint, /system tray/)
  assert.equal(overlayInteractionRecovery([{ ...binding, id: undefined }], 'darwin').shortcut, '⌃⌥I')
})

test('disabled, unrelated, and invalid shortcuts never promise keyboard recovery that is unavailable', () => {
  for (const shortcuts of [[], [{ ...binding, registered: false }], [{ ...binding, id: 'hide' as const, action: 'Show / hide overlay' }], [{ ...binding, accelerator: 'Invalid shortcut' }]]) {
    const recovery = overlayInteractionRecovery(shortcuts, 'darwin')
    assert.equal(recovery.shortcut, null)
    assert.match(recovery.hint, /Make overlay interactive.*menu bar.*workspace/)
    assert.doesNotMatch(recovery.hint, /Press/)
  }
})

test('the click-through control names the opt-in, reflects pressed state and explains recovery before it becomes mouse-inaccessible', () => {
  const recovery = overlayInteractionRecovery([binding], 'darwin')
  const render = (enabled: boolean, busy = false) => renderToStaticMarkup(createElement(OverlayInteractionButton, { enabled, busy, recovery: recovery.hint, onChange: async () => {} }))
  assert.match(render(false), /Enable click-through/)
  assert.match(render(false), /aria-pressed="false"/)
  assert.match(render(false), /clicks and scrolling.*app underneath/)
  assert.match(render(false), /⌃⌥I/)
  assert.match(render(true), /Click-through on/)
  assert.match(render(true), /aria-pressed="true"/)
  assert.match(render(true, true), /disabled=/)
  assert.doesNotMatch(overlayInteractionDescription(true, recovery.hint), /undetectable|invisible|Activity Monitor|hide.*cursor/i)
})

test('appearance settings expose deliberate interactive recovery and macOS Dock preference without claiming process hiding', () => {
  const render = (platform: NodeJS.Platform, clickThrough: boolean) => {
    const state: AppState = { settings: DEFAULT_SETTINGS, permissions: { platform, microphone: 'unknown', screen: 'unknown' }, shortcuts: [binding], overlayClickThrough: clickThrough, accessibility: { reduceTransparency: false, reduceMotion: false, increaseContrast: false }, keyConfigured: false, chatConfigured: false, compatibleKeyConfigured: false, sessions: [], currentSession: null, version: 'fixture', windowKind: 'workspace', capture: { active: false, sessionId: null, microphone: 'Off', system: 'Off' } }
    return renderToStaticMarkup(createElement(Settings, { state, initialSection: 'appearance', run: async (_label, task) => task(), notify() {} }))
  }
  const mac = render('darwin', true)
  assert.match(mac, /Make overlay interactive/)
  assert.doesNotMatch(mac, /Hide Dock icon/)
  assert.match(mac, /menu bar/)
  assert.match(mac, /⌃⌥I/)
  assert.doesNotMatch(mac, /undetectable|Activity Monitor|no traces/i)
  const windows = render('win32', false)
  assert.match(windows, /Open interactive overlay/)
  assert.match(windows, /system tray/)
  assert.doesNotMatch(windows, /Hide Dock icon/)
})
