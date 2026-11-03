import type { DesktopPlatform, MediaAccessPorts, MediaAccessState } from './types'

const ELECTRON_STATES: ReadonlySet<string> = new Set(['granted', 'denied', 'restricted', 'not-determined'])
const MICROPHONE_OFF_MESSAGE = 'Microphone access is turned off for apps. Turn it on in Windows Settings → Privacy & security → Microphone, then try again.'
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
  pendingMicrophoneMessage: () => 'Microphone access could not be confirmed. Check Windows Settings → Privacy & security → Microphone, then try again.',
  // Electron drops WS_THICKFRAME for transparent windows anyway; declaring it keeps the trade-off visible: no rectangular DWM shadow
  // or animation around the transparent card, and no edge-drag resizing (the renderer's 'overlay-resize' IPC remains the resize path).
  // skipTaskbar and maximizable are not repeated here: index.ts sets both for the overlay on every platform.
  overlayWindowOptions: () => ({ thickFrame: false }),
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
    : 'Windows credential protection (DPAPI) is unavailable, so no key was saved. Sign in to your Windows account and try again.'
}
