import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeImage } from 'electron'
import { darwinPlatform, desktopPlatform, linuxPlatform, platformId, win32Platform, type AppearancePorts, type DesktopPlatform, type LoginItemPorts, type MediaAccessPorts, type OverlayLevelPorts, type PlatformId, type SafeStoragePorts, type TrayImagePorts, type WindowMaterialPorts } from '../src/main/platform'

const platforms: Record<PlatformId, DesktopPlatform> = { darwin: darwinPlatform, win32: win32Platform, linux: linuxPlatform }

function mediaPorts(states: Partial<Record<'microphone' | 'screen', string>> = {}, prompt = true) {
  const calls: string[] = []
  const ports: MediaAccessPorts = {
    getMediaAccessStatus: kind => { calls.push(`status:${kind}`); const status = states[kind]; if (status === 'throw') throw new Error('unreadable'); return status ?? 'granted' },
    askForMediaAccess: async kind => { calls.push(`ask:${kind}`); return prompt }
  }
  return { calls, ports }
}

function materialPorts() {
  const calls: string[] = []
  const ports: WindowMaterialPorts = { setBackgroundColor: color => { calls.push(`background:${color}`) }, setVibrancy: material => { calls.push(`vibrancy:${material}`) } }
  return { calls, ports }
}

function levelPorts() {
  const calls: string[] = []
  const ports: OverlayLevelPorts = {
    setAlwaysOnTop: (flag, level, relative) => { calls.push(`top:${flag}:${level}:${relative}`) },
    setVisibleOnAllWorkspaces: (visible, options) => { calls.push(`workspaces:${visible}:${JSON.stringify(options)}`) }
  }
  return { calls, ports }
}

function appearancePorts() {
  const calls: string[] = []
  const listeners = new Map<string, Array<() => void>>()
  let nextId = 41
  const ports: AppearancePorts = {
    subscribeWorkspaceNotification(event, callback) { calls.push(`subscribe:${event}`); listeners.set(String(nextId), [callback]); return nextId++ },
    unsubscribeWorkspaceNotification(id) { calls.push(`unsubscribe:${id}`); listeners.delete(String(id)) },
    on(event, callback) { calls.push(`on:${event}`); listeners.set(event, [...(listeners.get(event) ?? []), callback]) },
    removeListener(event, callback) { calls.push(`off:${event}`); listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== callback)) }
  }
  const fire = (key: string) => { for (const callback of listeners.get(key) ?? []) callback() }
  return { calls, listeners, fire, ports }
}

interface FakeImage { source: string; template: boolean; width: number | null; height: number | null; setTemplateImage(value: boolean): void; resize(options: { width?: number; height?: number }): FakeImage }
function fakeImage(source: string, width: number | null = null, height: number | null = null): FakeImage {
  return {
    source, template: false, width, height,
    setTemplateImage(value) { this.template = value },
    resize(options) { return fakeImage(this.source, options.width ?? this.width, options.height ?? this.height) }
  }
}
function imagePorts(): TrayImagePorts {
  return { createFromPath: path => fakeImage(`path:${path}`) as unknown as NativeImage, createFromDataURL: url => fakeImage(url) as unknown as NativeImage }
}
function storagePorts(available: boolean, backend = 'keychain'): SafeStoragePorts {
  return { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend }
}

test('platform facts describe each OS once and the selector maps Node platform names onto them', () => {
  assert.equal(desktopPlatform('darwin'), darwinPlatform)
  assert.equal(desktopPlatform('win32'), win32Platform)
  for (const name of ['linux', 'freebsd', 'openbsd', 'sunos']) { assert.equal(platformId(name), 'linux'); assert.equal(desktopPlatform(name), linuxPlatform) }
  assert.deepEqual([darwinPlatform.id, darwinPlatform.displayName, darwinPlatform.appPresence, darwinPlatform.recoveryMenuName, darwinPlatform.settingsAppName], ['darwin', 'macOS', 'dock', 'Menu bar', 'System Settings'])
  assert.deepEqual([win32Platform.id, win32Platform.displayName, win32Platform.appPresence, win32Platform.recoveryMenuName, win32Platform.settingsAppName], ['win32', 'Windows', 'taskbar', 'Tray', 'Windows Settings'])
  assert.deepEqual([linuxPlatform.id, linuxPlatform.displayName, linuxPlatform.appPresence, linuxPlatform.recoveryMenuName], ['linux', 'Linux', 'taskbar', 'Tray'])
  const flags = (platform: DesktopPlatform) => [platform.supportsHiddenAppIcon, platform.quitsWhenAllWindowsClosed, platform.screenPermissionRequired, platform.screenAccessGatesSystemAudio, platform.promptsForMicrophone, platform.supportsWindowMaterial]
  assert.deepEqual(flags(darwinPlatform), [true, false, true, true, true, true])
  assert.deepEqual(flags(win32Platform), [false, true, false, false, false, false])
  assert.deepEqual(flags(linuxPlatform), [false, true, false, false, false, false])
  assert.deepEqual([darwinPlatform.appUserModelId, win32Platform.appUserModelId, linuxPlatform.appUserModelId], [null, 'com.faangin.desktop', null])
  assert.deepEqual([darwinPlatform.defaultDeviceName, win32Platform.defaultDeviceName, linuxPlatform.defaultDeviceName], ['Mac', 'Windows PC', 'Linux PC'])
  assert.deepEqual([darwinPlatform.credentialStoreName, win32Platform.credentialStoreName], ['Keychain', 'Windows credential protection (DPAPI)'])
  assert.deepEqual([darwinPlatform.legacyTextEncoding, win32Platform.legacyTextEncoding, linuxPlatform.legacyTextEncoding], [null, 'windows-1252', null])
  // Windows posts a hot-key callback for every keyboard auto-repeat (the longest repeat delay is one second); macOS and the unverified Linux do not need a guard.
  assert.deepEqual([darwinPlatform.globalShortcutRepeatGuardMs, win32Platform.globalShortcutRepeatGuardMs, linuxPlatform.globalShortcutRepeatGuardMs], [0, 1100, 0])
  assert.ok(win32Platform.globalShortcutRepeatGuardMs > 1000)
})

test('permission statuses pass Electron values through, mark unreadable ones unknown and skip permissions the OS lacks', () => {
  for (const state of ['granted', 'denied', 'restricted', 'not-determined']) {
    assert.equal(darwinPlatform.permissionStatus('microphone', mediaPorts({ microphone: state }).ports), state)
    assert.equal(darwinPlatform.permissionStatus('screen', mediaPorts({ screen: state }).ports), state)
    assert.equal(win32Platform.permissionStatus('microphone', mediaPorts({ microphone: state }).ports), state)
  }
  for (const state of ['unknown', 'bogus', 'throw']) {
    assert.equal(darwinPlatform.permissionStatus('screen', mediaPorts({ screen: state }).ports), 'unknown')
    assert.equal(win32Platform.permissionStatus('microphone', mediaPorts({ microphone: state }).ports), 'unknown')
  }
  const windows = mediaPorts({ screen: 'denied' })
  assert.equal(win32Platform.permissionStatus('screen', windows.ports), 'not-required')
  assert.deepEqual(windows.calls, [], 'Windows never asks the OS about screen recording')
  const linux = mediaPorts({ microphone: 'denied', screen: 'denied' })
  assert.deepEqual([linuxPlatform.permissionStatus('microphone', linux.ports), linuxPlatform.permissionStatus('screen', linux.ports)], ['unknown', 'unknown'])
  assert.deepEqual(linux.calls, [])
})

test('permission settings deep links exist only where the OS has a page for them', () => {
  assert.equal(darwinPlatform.permissionSettingsUrl('microphone'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  assert.equal(darwinPlatform.permissionSettingsUrl('screen'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  assert.equal(darwinPlatform.permissionSettingsUrl('system-audio'), darwinPlatform.permissionSettingsUrl('screen'), 'screen consent gates computer audio on macOS')
  assert.equal(win32Platform.permissionSettingsUrl('microphone'), 'ms-settings:privacy-microphone')
  assert.equal(win32Platform.permissionSettingsUrl('screen'), null)
  assert.equal(win32Platform.permissionSettingsUrl('system-audio'), 'ms-settings:sound')
  for (const kind of ['microphone', 'screen', 'system-audio'] as const) assert.equal(linuxPlatform.permissionSettingsUrl(kind), null)
})

test('a failed computer-audio check names the consent pane on macOS and the default playback device elsewhere', () => {
  assert.equal(darwinPlatform.systemAudioUnavailableMessage(true), 'Computer audio access was not allowed. Enable Faangin in Screen & System Audio Recording, then retry the access check.')
  assert.equal(darwinPlatform.systemAudioUnavailableMessage(false), 'Computer audio could not be verified. Check your output device and system permissions, then retry the access check.')
  for (const denied of [true, false]) {
    assert.equal(win32Platform.systemAudioUnavailableMessage(denied), 'Computer audio could not be verified. Make sure a playback device is set as default in Windows Sound settings, then retry the access check.')
    assert.match(linuxPlatform.systemAudioUnavailableMessage(denied), /playback device.*system sound settings.*retry the access check/)
    for (const platform of [win32Platform, linuxPlatform]) assert.doesNotMatch(platform.systemAudioUnavailableMessage(denied), /Screen & System Audio Recording|macOS|not allowed/)
  }
})

test('macOS awaits the native microphone prompt and phrases denial and pending copy for its settings app', async () => {
  const granted = mediaPorts({}, true)
  assert.deepEqual(await darwinPlatform.microphoneAccess(granted.ports), { allowed: true })
  assert.deepEqual(granted.calls, ['ask:microphone'])
  const denied = mediaPorts({}, false)
  assert.deepEqual(await darwinPlatform.microphoneAccess(denied.ports), { allowed: false, message: 'Microphone permission was denied. Open macOS permission settings.' })
  assert.equal(darwinPlatform.pendingMicrophoneMessage(), 'Microphone permission is still pending. Check macOS permission settings and try again.')
})

test('Windows reads the global microphone switch without prompting and both switch states block capture', async () => {
  // Electron reports the per-user switch as 'denied' and the device-wide switch (or group policy) as 'restricted'.
  for (const state of ['denied', 'restricted']) {
    const blocked = mediaPorts({ microphone: state })
    assert.deepEqual(await win32Platform.microphoneAccess(blocked.ports), { allowed: false, message: 'Microphone access was denied: Windows has it turned off for apps. Turn it on in Windows Settings → Privacy & security (Privacy on Windows 10) → Microphone, then try again.' }, state)
    assert.deepEqual(blocked.calls, ['status:microphone'])
  }
  for (const state of ['granted', 'not-determined', 'unknown', 'throw']) {
    const ports = mediaPorts({ microphone: state })
    assert.deepEqual(await win32Platform.microphoneAccess(ports.ports), { allowed: true }, state)
    assert.ok(!ports.calls.includes('ask:microphone'), 'askForMediaAccess is macOS-only')
  }
  assert.match(win32Platform.pendingMicrophoneMessage(), /Windows Settings → Privacy & security \(Privacy on Windows 10\) → Microphone/)
  const linux = mediaPorts({ microphone: 'denied' })
  assert.deepEqual(await linuxPlatform.microphoneAccess(linux.ports), { allowed: true })
  assert.deepEqual(linux.calls, [])
  assert.ok(linuxPlatform.pendingMicrophoneMessage().length > 0)
})

test('window options give macOS vibrancy, hide the Windows menu bar and keep the Windows overlay a fixed transparent companion', () => {
  assert.deepEqual(darwinPlatform.overlayWindowOptions(), {})
  assert.deepEqual(darwinPlatform.workspaceWindowOptions({ reduceTransparency: false }), { vibrancy: 'window', visualEffectState: 'followWindow' })
  assert.deepEqual(darwinPlatform.workspaceWindowOptions({ reduceTransparency: true }), {})
  assert.deepEqual(win32Platform.overlayWindowOptions(), { thickFrame: false, minimizable: false }, 'skipTaskbar and maximizable are set for every overlay by index.ts; a minimized overlay has no taskbar button to restore it')
  for (const reduceTransparency of [false, true]) assert.deepEqual(win32Platform.workspaceWindowOptions({ reduceTransparency }), { autoHideMenuBar: true })
  assert.deepEqual(linuxPlatform.overlayWindowOptions(), {})
  assert.deepEqual(linuxPlatform.workspaceWindowOptions({ reduceTransparency: false }), {})
})

test('window backgrounds are transparent only where the renderer or native material paints the window', () => {
  const solid = (dark: boolean) => dark ? '#111111' : '#f5f5f7'
  for (const dark of [false, true]) {
    for (const platform of Object.values(platforms)) {
      assert.equal(platform.windowBackground({ isOverlay: true, reduceTransparency: false, dark }), '#00000000', `${platform.id} overlay`)
      assert.equal(platform.windowBackground({ isOverlay: true, reduceTransparency: true, dark }), solid(dark), `${platform.id} overlay with reduced transparency`)
      assert.equal(platform.windowBackground({ isOverlay: false, reduceTransparency: true, dark }), solid(dark), `${platform.id} workspace with reduced transparency`)
    }
    assert.equal(darwinPlatform.windowBackground({ isOverlay: false, reduceTransparency: false, dark }), '#00000000', 'vibrancy paints the macOS workspace')
    assert.equal(win32Platform.windowBackground({ isOverlay: false, reduceTransparency: false, dark }), solid(dark))
    assert.equal(linuxPlatform.windowBackground({ isOverlay: false, reduceTransparency: false, dark }), solid(dark))
  }
})

test('window material sets the background everywhere and adds vibrancy only on the macOS workspace', () => {
  const expectations: Array<[boolean, boolean, string[]]> = [
    [false, false, ['background:#00000000', 'vibrancy:window']], [true, false, ['background:#00000000', 'vibrancy:null']],
    [false, true, ['background:#111111', 'vibrancy:null']], [true, true, ['background:#111111', 'vibrancy:null']]
  ]
  for (const [isOverlay, reduceTransparency, expected] of expectations) {
    const window = materialPorts()
    darwinPlatform.applyWindowMaterial(window.ports, { isOverlay, reduceTransparency, dark: true })
    assert.deepEqual(window.calls, expected)
  }
  for (const platform of [win32Platform, linuxPlatform]) {
    const window = materialPorts()
    platform.applyWindowMaterial(window.ports, { isOverlay: false, reduceTransparency: false, dark: false })
    platform.applyWindowMaterial(window.ports, { isOverlay: true, reduceTransparency: false, dark: false })
    platform.applyWindowMaterial(window.ports, { isOverlay: false, reduceTransparency: true, dark: true })
    assert.deepEqual(window.calls, ['background:#f5f5f7', 'background:#00000000', 'background:#111111'], `${platform.id} never touches vibrancy`)
  }
})

test('overlay level uses the floating tier above full-screen apps on macOS, HWND_TOPMOST on Windows and all workspaces on Linux', () => {
  const mac = levelPorts(); darwinPlatform.applyOverlayLevel(mac.ports)
  assert.deepEqual(mac.calls, ['top:true:floating:undefined', 'workspaces:true:{"visibleOnFullScreen":true}'])
  const windows = levelPorts(); win32Platform.applyOverlayLevel(windows.ports)
  assert.deepEqual(windows.calls, ['top:true:screen-saver:undefined'])
  const linux = levelPorts(); linuxPlatform.applyOverlayLevel(linux.ports)
  assert.deepEqual(linux.calls, ['top:true:floating:undefined', 'workspaces:true:undefined'])
})

test('accessibility subscriptions pair every subscribe with one unsubscribe and never register the removed high-contrast event', () => {
  let fired = 0
  const mac = appearancePorts()
  const unsubscribeMac = darwinPlatform.subscribeAccessibilityChanges(mac.ports, () => { fired++ })
  assert.deepEqual(mac.calls, ['subscribe:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification'])
  mac.fire('41'); assert.equal(fired, 1)
  unsubscribeMac(); unsubscribeMac()
  assert.deepEqual(mac.calls, ['subscribe:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification', 'unsubscribe:41'])
  mac.fire('41'); assert.equal(fired, 1)
  const windows = appearancePorts()
  const unsubscribeWindows = win32Platform.subscribeAccessibilityChanges(windows.ports, () => { fired++ })
  assert.deepEqual(windows.calls, ['on:color-changed'])
  windows.fire('color-changed'); assert.equal(fired, 2)
  unsubscribeWindows()
  assert.deepEqual(windows.calls, ['on:color-changed', 'off:color-changed'])
  windows.fire('color-changed'); assert.equal(fired, 2)
  assert.ok(!windows.calls.some(call => call.includes('high-contrast')), 'Electron 44 has no high-contrast-color-scheme-changed event')
  const linux = appearancePorts()
  linuxPlatform.subscribeAccessibilityChanges(linux.ports, () => { fired++ })()
  assert.deepEqual(linux.calls, [])
})

test('tray icons are the template glyph on macOS and the resized packaged icon on Windows and Linux', () => {
  const mac = darwinPlatform.trayIcon('/app/resources/icon.png', imagePorts()) as unknown as FakeImage
  assert.match(mac.source, /^data:image\/png;base64,iVBORw0KGgo/)
  assert.equal(mac.template, true)
  assert.equal(mac.width, null, 'the 16px glyph is used at its native size')
  const windows = win32Platform.trayIcon('C:\\Faangin\\resources\\icon.png', imagePorts()) as unknown as FakeImage
  assert.deepEqual([windows.source, windows.width, windows.height, windows.template], ['path:C:\\Faangin\\resources\\icon.png', 32, 32, false])
  const linux = linuxPlatform.trayIcon('/opt/faangin/resources/icon.png', imagePorts()) as unknown as FakeImage
  assert.deepEqual([linux.source, linux.width, linux.height, linux.template], ['path:/opt/faangin/resources/icon.png', 22, 22, false])
})

test('credential encryption follows safeStorage, rejects the Linux plaintext backend and phrases failures per OS', () => {
  for (const platform of [darwinPlatform, win32Platform]) {
    assert.equal(platform.credentialEncryptionAvailable(storagePorts(true, 'basic_text')), true, `${platform.id} ignores the Linux-only backend name`)
    assert.equal(platform.credentialEncryptionAvailable(storagePorts(false)), false)
  }
  assert.equal(linuxPlatform.credentialEncryptionAvailable(storagePorts(true, 'gnome_libsecret')), true)
  assert.equal(linuxPlatform.credentialEncryptionAvailable(storagePorts(true, 'basic_text')), false)
  assert.equal(linuxPlatform.credentialEncryptionAvailable(storagePorts(false, 'kwallet')), false)
  for (const platform of [darwinPlatform, linuxPlatform]) {
    assert.equal(platform.credentialUnavailableMessage('read'), 'OS credential encryption is unavailable. Unlock your keychain and restart Faangin.')
    assert.equal(platform.credentialUnavailableMessage('save'), 'OS credential encryption is unavailable. No key was saved.')
  }
  for (const action of ['read', 'save'] as const) {
    const message = win32Platform.credentialUnavailableMessage(action)
    assert.match(message, /Windows credential protection \(DPAPI\)/)
    assert.match(message, /Windows account/)
  }
  assert.match(win32Platform.credentialUnavailableMessage('save'), /no key was saved/)
})

function loginPorts(items: Array<{ name: string; enabled: boolean }> | undefined = []) {
  const writes: Array<{ openAtLogin: boolean; enabled?: boolean }> = []
  const ports: LoginItemPorts = { getLoginItemSettings: () => ({ launchItems: items }), setLoginItemSettings: settings => { writes.push({ ...settings }) } }
  return { ports, writes }
}

test('macOS and Linux register the login item only when a setting is saved, exactly as before', () => {
  for (const platform of [darwinPlatform, linuxPlatform]) {
    for (const openAtLogin of [true, false]) {
      const save = loginPorts(); platform.applyLoginItem(save.ports, openAtLogin, 'save')
      assert.deepEqual(save.writes, [{ openAtLogin }], platform.id)
      const launch = loginPorts(); platform.applyLoginItem(launch.ports, openAtLogin, 'launch')
      assert.deepEqual(launch.writes, [], platform.id)
    }
  }
})

test('Windows rewrites the Run entry on save and on launch while preserving a Task Manager disable', () => {
  const name = win32Platform.appUserModelId!
  const fresh = loginPorts(); win32Platform.applyLoginItem(fresh.ports, true, 'save')
  assert.deepEqual(fresh.writes, [{ openAtLogin: true, enabled: true }], 'with no entry yet the item is enabled')
  const approved = loginPorts([{ name, enabled: true }]); win32Platform.applyLoginItem(approved.ports, true, 'save')
  assert.deepEqual(approved.writes, [{ openAtLogin: true, enabled: true }])
  // Turning Faangin off in Task Manager > Startup apps must survive an unrelated settings save and the next launch.
  const disabled = loginPorts([{ name, enabled: false }])
  win32Platform.applyLoginItem(disabled.ports, true, 'save'); win32Platform.applyLoginItem(disabled.ports, true, 'launch')
  assert.deepEqual(disabled.writes, [{ openAtLogin: true, enabled: false }, { openAtLogin: true, enabled: false }])
  // Only this app's entry counts, matched the way the registry matches value names.
  const other = loginPorts([{ name: 'Other app', enabled: false }, { name: name.toUpperCase(), enabled: false }]); win32Platform.applyLoginItem(other.ports, true, 'save')
  assert.deepEqual(other.writes, [{ openAtLogin: true, enabled: false }])
  const unrelated = loginPorts([{ name: 'Other app', enabled: false }]); win32Platform.applyLoginItem(unrelated.ports, true, 'save')
  assert.deepEqual(unrelated.writes, [{ openAtLogin: true, enabled: true }])
  const unreadable = loginPorts(undefined); win32Platform.applyLoginItem(unreadable.ports, true, 'launch')
  assert.deepEqual(unreadable.writes, [{ openAtLogin: true, enabled: true }])
})

test('Windows launch repairs a stale Run entry for a user who opted in and never enrols one who did not, while an explicit off removes the entry', () => {
  const optedOut = loginPorts(); win32Platform.applyLoginItem(optedOut.ports, false, 'launch')
  assert.deepEqual(optedOut.writes, [])
  const optedIn = loginPorts(); win32Platform.applyLoginItem(optedIn.ports, true, 'launch')
  assert.deepEqual(optedIn.writes, [{ openAtLogin: true, enabled: true }])
  const removal = loginPorts([{ name: win32Platform.appUserModelId!, enabled: false }]); win32Platform.applyLoginItem(removal.ports, false, 'save')
  assert.deepEqual(removal.writes, [{ openAtLogin: false, enabled: false }])
})

test('Windows and Linux escape ampersands in native menu labels so they are drawn, and macOS leaves its labels byte-identical', () => {
  for (const label of ['Capture & solve', 'Reset overlay size & position', 'Show workspace', '']) assert.equal(darwinPlatform.menuLabel(label), label)
  assert.equal(win32Platform.menuLabel('Capture & solve'), 'Capture && solve')
  assert.equal(win32Platform.menuLabel('Reset overlay size & position'), 'Reset overlay size && position')
  assert.equal(linuxPlatform.menuLabel('Capture & solve'), 'Capture && solve')
  assert.equal(win32Platform.menuLabel('Show workspace'), 'Show workspace')
  assert.equal(win32Platform.menuLabel('A & B & C'), 'A && B && C')
})
