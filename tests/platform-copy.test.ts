import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { platformCopy, type PermissionCopyKind } from '../src/shared/platform-copy'
import Settings from '../src/renderer/src/Settings'

const kinds: PermissionCopyKind[] = ['microphone', 'screen', 'system-audio']
const mac = platformCopy('darwin'), windows = platformCopy('win32'), linux = platformCopy('linux')

test('each desktop platform names its own settings app, recovery menu, modifier key and device noun', () => {
  assert.deepEqual([mac.id, mac.name, mac.settingsApp, mac.recoveryMenu, mac.modifier, mac.modifierKey, mac.deviceNoun], ['darwin', 'macOS', 'System Settings', 'Menu bar', 'Command', '⌘', 'Mac'])
  assert.deepEqual([windows.id, windows.name, windows.settingsApp, windows.recoveryMenu, windows.modifier, windows.modifierKey, windows.deviceNoun], ['win32', 'Windows', 'Windows Settings', 'Tray', 'Ctrl', 'Ctrl', 'PC'])
  assert.deepEqual([linux.id, linux.name, linux.settingsApp, linux.recoveryMenu, linux.modifier, linux.modifierKey, linux.deviceNoun], ['linux', 'Linux', 'System Settings', 'Tray', 'Ctrl', 'Ctrl', 'PC'])
  for (const other of ['freebsd', 'openbsd', 'sunos', '']) assert.equal(platformCopy(other), linux)
  for (const copy of [mac, windows, linux]) { assert.equal(Object.isFrozen(copy), true); assert.throws(() => { (copy as { name: string }).name = 'elsewhere' }) }
})

test('only macOS has a screen-recording permission, a native consent prompt and a restart caveat', () => {
  assert.equal(mac.screenPermissionRequired, true)
  assert.equal(mac.promptsOnRequest, true)
  assert.equal(mac.microphonePath, 'System Settings → Privacy & Security → Microphone')
  assert.equal(mac.screenPath, 'System Settings → Privacy & Security → Screen & System Audio Recording')
  assert.equal(mac.restartNote, 'macOS may ask you to restart the app.')
  for (const kind of kinds) {
    assert.equal(mac.canOpenSettings(kind), true)
    assert.equal(mac.permissionAction(kind), 'enable Faangin')
    assert.match(mac.permissionHelp(kind), /^Open System Settings → Privacy & Security → .+ and enable Faangin\.$/)
  }
  assert.match(mac.permissionHelp('system-audio'), /Screen & System Audio Recording/)
  for (const copy of [windows, linux]) {
    assert.equal(copy.screenPermissionRequired, false)
    assert.equal(copy.promptsOnRequest, false)
    assert.equal(copy.screenPath, null)
    assert.equal(copy.restartNote, '')
    assert.equal(copy.canOpenSettings('screen'), false); assert.equal(copy.permissionAction('screen'), '')
    assert.equal(copy.permissionHelp('screen'), `${copy.name} does not need a screen-recording permission. Capture works as soon as you choose it.`)
    assert.match(copy.permissionHelp('system-audio'), /default playback device/)
    for (const kind of kinds) assert.doesNotMatch(copy.permissionHelp(kind), /macOS|System Settings|Screen & System Audio Recording/)
  }
})

test('Windows guidance names both global microphone switches and the Sound page its two deep links open; Linux has no deep link', () => {
  assert.equal(windows.canOpenSettings('microphone'), true)
  // Windows 10 calls the section Privacy and labels the toggles differently, so the path and the action are true on both supported versions.
  assert.equal(windows.microphonePath, 'Settings → Privacy & security (Privacy on Windows 10) → Microphone')
  assert.equal(windows.permissionAction('microphone'), 'turn on microphone access for this device and for desktop apps')
  assert.equal(windows.permissionHelp('microphone'), 'Open Settings → Privacy & security (Privacy on Windows 10) → Microphone and turn on microphone access for this device and for desktop apps.')
  // Mirrors win32Platform.permissionSettingsUrl('system-audio'), which opens ms-settings:sound.
  assert.equal(windows.canOpenSettings('system-audio'), true)
  assert.equal(windows.permissionAction('system-audio'), 'choose the speakers or headset you listen on as the output device')
  assert.equal(windows.permissionHelp('system-audio'), 'Computer audio is captured from your default playback device. Open Settings → System → Sound and choose the speakers or headset you listen on as the output device, and make sure it is not in exclusive mode.')
  assert.equal(linux.canOpenSettings('microphone'), false)
  assert.equal(linux.canOpenSettings('system-audio'), false); assert.equal(linux.permissionAction('system-audio'), '')
  assert.equal(linux.permissionHelp('system-audio'), 'Computer audio is captured from your default playback device. Make sure a playback device is active and not in exclusive mode.')
  assert.equal(linux.microphonePath, 'your desktop privacy settings')
  assert.equal(linux.permissionHelp('microphone'), 'Open your desktop privacy settings and enable Faangin.')
})

test('the Settings permission card speaks the OS it runs on', () => {
  const render = (platform: string, screen: string) => {
    const state: AppState = { settings: DEFAULT_SETTINGS, permissions: { platform, microphone: 'granted', screen }, shortcuts: [], accessibility: { reduceTransparency: false, reduceMotion: false, increaseContrast: false }, keyConfigured: false, chatConfigured: false, compatibleKeyConfigured: false, sessions: [], currentSession: null, version: 'fixture', windowKind: 'workspace', capture: { active: false, sessionId: null, microphone: 'Off', system: 'Off' } }
    return renderToStaticMarkup(createElement(Settings, { state, initialSection: 'capture', run: async (_label, task) => task(), notify() {} }))
  }
  const darwin = render('darwin', 'denied')
  assert.equal(darwin.match(/Open System Settings/g)?.length, 2)
  assert.match(darwin, /<strong>Screen recording<\/strong>/)
  assert.match(darwin, /check screen recording permission below/)
  assert.match(darwin, /a restart may be required by your operating system/)
  assert.match(darwin, /Command \+ , opens Settings/)
  const win32 = render('win32', 'not-required')
  assert.equal(win32.match(/Open Windows Settings/g)?.length, 1)
  assert.match(win32, /<strong>Screen capture<\/strong>/)
  assert.match(win32, /permission-badge granted"><svg[^>]*>.*?<\/svg> Not required</)
  assert.match(win32, /refresh again or restart Faangin/)
  assert.match(win32, /Ctrl \+ , opens Settings/)
  assert.doesNotMatch(win32, /Screen recording|screen recording permission|a restart may be required|System Settings|Not-required/)
})
