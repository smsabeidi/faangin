import type { DesktopPlatform, MediaAccessPorts, MediaAccessState } from './types'

const ELECTRON_STATES: ReadonlySet<string> = new Set(['granted', 'denied', 'restricted', 'not-determined'])
// Windows 11 names the page Privacy & security and Windows 10 names it Privacy. "denied" is deliberate: the renderer's audio status
// classifiers (meter, guidance and question-source health) key on it, as they do on the macOS message.
const MICROPHONE_PAGE = 'Windows Settings → Privacy & security (Privacy on Windows 10) → Microphone'
const MICROPHONE_OFF_MESSAGE = `Microphone access was denied: Windows has it turned off for apps. Turn it on in ${MICROPHONE_PAGE}, then try again.`
// WASAPI loopback follows the default render device and never asks for consent, so only the device choice can fail the check.
const SYSTEM_AUDIO_UNAVAILABLE_MESSAGE = 'Computer audio could not be verified. Make sure a playback device is set as default in Windows Sound settings, then retry the access check.'

// Windows exposes one global privacy switch for desktop apps; there is no per-app prompt to await.
function microphoneStatus(ports: MediaAccessPorts): MediaAccessState {
  try { const status = ports.getMediaAccessStatus('microphone'); return ELECTRON_STATES.has(status) ? status as MediaAccessState : 'unknown' } catch { return 'unknown' }
}

export const win32Platform: DesktopPlatform = {
  id: 'win32',
  displayName: 'Windows',
  settingsAppName: 'Windows Settings',
  appPresence: 'taskbar',
  recoveryMenuName: 'Tray',
  supportsHiddenAppIcon: false,
  quitsWhenAllWindowsClosed: true,
  screenPermissionRequired: false,
  screenAccessGatesSystemAudio: false,
  promptsForMicrophone: false,
  supportsWindowMaterial: false,
  credentialStoreName: 'Windows credential protection (DPAPI)',
  // Must equal the electron-builder appId so taskbar grouping and notifications attribute to the installed app.
  appUserModelId: 'com.faangin.desktop',
  defaultDeviceName: 'Windows PC',
  // Notepad "ANSI" and Word's plain-text export use the Windows ANSI code page; Western locales are Windows-1252.
  legacyTextEncoding: 'windows-1252',
  // Chromium registers global hot keys with RegisterHotKey and no MOD_NOREPEAT, so Windows posts WM_HOTKEY for every auto-repeat of a held chord
  // (after the 250 ms to 1 s repeat delay, then every 33 to 400 ms). 1100 ms clears the longest delay, and the guard slides with every callback.
  globalShortcutRepeatGuardMs: 1100,
  // Screen capture needs no consent on Windows; getMediaAccessStatus('screen') is always 'granted' there.
  permissionStatus: (kind, ports) => kind === 'screen' ? 'not-required' : microphoneStatus(ports),
  // Screen capture has no settings page; computer audio points at Sound, where the captured default playback device is chosen.
  permissionSettingsUrl: kind => kind === 'microphone' ? 'ms-settings:privacy-microphone' : kind === 'system-audio' ? 'ms-settings:sound' : null,
  systemAudioUnavailableMessage: () => SYSTEM_AUDIO_UNAVAILABLE_MESSAGE,
  // Electron maps the per-user switch to 'denied' and the device-wide switch or group policy to 'restricted'; both stop the device
  // from opening, so both block. Chromium still opens the device for 'not-determined' and 'unknown'.
  async microphoneAccess(ports) {
    const status = microphoneStatus(ports)
    return status === 'denied' || status === 'restricted' ? { allowed: false, message: MICROPHONE_OFF_MESSAGE } : { allowed: true }
  },
  pendingMicrophoneMessage: () => `Microphone access could not be confirmed. Check ${MICROPHONE_PAGE}, then try again.`,
  // Electron drops WS_THICKFRAME for transparent windows anyway; declaring it keeps the trade-off visible: no rectangular DWM shadow
  // or animation around the transparent card, and no edge-drag resizing (the renderer's 'overlay-resize' IPC remains the resize path).
  // minimizable is false because a minimized overlay has no taskbar button (skipTaskbar) to restore it from, and Win+Down or Alt+Space can minimize
  // an active frameless window; index.ts also suppresses the system menu. skipTaskbar and maximizable are not repeated here: index.ts sets both for the overlay on every platform.
  overlayWindowOptions: () => ({ thickFrame: false, minimizable: false }),
  // The application menu would otherwise paint a menu bar on every framed window; the tray menu is the recovery path here.
  workspaceWindowOptions: () => ({ autoHideMenuBar: true }),
  // No native material on Windows: the workspace is always solid and only the overlay's renderer tint is transparent.
  windowBackground: ({ isOverlay, reduceTransparency, dark }) => isOverlay && !reduceTransparency ? '#00000000' : dark ? '#111111' : '#f5f5f7',
  // setVibrancy is macOS-only; the solid or transparent colour is the whole material here.
  applyWindowMaterial: (window, input) => window.setBackgroundColor(win32Platform.windowBackground(input)),
  // 'screen-saver' maps to HWND_TOPMOST, the only always-on-top tier Windows has; setVisibleOnAllWorkspaces does nothing on Windows.
  applyOverlayLevel: window => window.setAlwaysOnTop(true, 'screen-saver'),
  // WM_SYSCOLORCHANGE is what Windows broadcasts when a high-contrast theme is switched. nativeTheme 'updated' follows once Chromium
  // re-reads its colours, and the caller's refresh is coalesced, so the extra notification only keeps the appearance in step.
  // Electron removed 'high-contrast-color-scheme-changed' with the nativeTheme migration, so it is deliberately not registered.
  subscribeAccessibilityChanges(ports, callback) {
    ports.on('color-changed', callback)
    return () => { ports.removeListener('color-changed', callback) }
  },
  // 32px stays crisp in the notification area at 200% scaling and downsamples cleanly below; Windows has no template-image tinting.
  trayIcon: (iconPath, ports) => ports.createFromPath(iconPath).resize({ width: 32, height: 32 }),
  credentialEncryptionAvailable: ports => ports.isEncryptionAvailable(),
  credentialUnavailableMessage: action => action === 'read'
    ? 'Windows credential protection (DPAPI) is unavailable. Sign in to your Windows account and restart Faangin.'
    : 'Windows credential protection (DPAPI) is unavailable, so no key was saved. Sign in to your Windows account and try again.',
  // The Run value is rewritten on every call, so a reinstall into another directory or a retained profile with no Run value starts working again.
  // `enabled` defaults to true and rewrites the StartupApproved value, which would silently undo a Disable in Task Manager or Windows Settings,
  // so the current state is carried through. A launch never creates the entry for a user who has the preference off.
  applyLoginItem(ports, openAtLogin, trigger) {
    if (!openAtLogin && trigger === 'launch') return
    const name = win32Platform.appUserModelId?.toLowerCase()
    const enabled = ports.getLoginItemSettings().launchItems?.find(item => item.name.toLowerCase() === name)?.enabled ?? true
    ports.setLoginItemSettings({ openAtLogin, enabled })
  },
  // Chromium views menus read a single '&' as a mnemonic marker and drop it from the text; '&&' draws a literal ampersand.
  menuLabel: label => label.replace(/&/g, '&&')
}
