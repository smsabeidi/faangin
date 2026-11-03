import type { DesktopPlatform, MediaAccessPorts, MediaAccessState, MediaPermissionKind } from './types'

// 16px menu-bar glyph. As a template image macOS tints it for light, dark and highlighted menu-bar states.
const MENU_BAR_GLYPH = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgGGzgP5F4iBhAFqCqASQ5fXAaQBYYBgbQHwAAq6FHuddDHPYAAAAASUVORK5CYII='
const ELECTRON_STATES: ReadonlySet<string> = new Set(['granted', 'denied', 'restricted', 'not-determined'])

function readStatus(kind: MediaPermissionKind, ports: MediaAccessPorts): MediaAccessState {
  try { const status = ports.getMediaAccessStatus(kind); return ELECTRON_STATES.has(status) ? status as MediaAccessState : 'unknown' } catch { return 'unknown' }
}

export const darwinPlatform: DesktopPlatform = {
  id: 'darwin',
  displayName: 'macOS',
  settingsAppName: 'System Settings',
  appPresence: 'dock',
  recoveryMenuName: 'Menu bar',
  supportsHiddenAppIcon: true,
  quitsWhenAllWindowsClosed: false,
  screenPermissionRequired: true,
  screenAccessGatesSystemAudio: true,
  promptsForMicrophone: true,
  supportsWindowMaterial: true,
  credentialStoreName: 'Keychain',
  appUserModelId: null,
  defaultDeviceName: 'Mac',
  permissionStatus: readStatus,
  // Screen & System Audio Recording is one pane: computer audio is governed by the same consent as screen capture.
  permissionSettingsUrl: kind => `x-apple.systempreferences:com.apple.preference.security?${kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'}`,
  systemAudioUnavailableMessage: denied => denied
    ? 'Computer audio access was not allowed. Enable Faangin in Screen & System Audio Recording, then retry the access check.'
    : 'Computer audio could not be verified. Check your output device and system permissions, then retry the access check.',
  async microphoneAccess(ports) {
    return await ports.askForMediaAccess('microphone') ? { allowed: true } : { allowed: false, message: 'Microphone permission was denied. Open macOS permission settings.' }
  },
  pendingMicrophoneMessage: () => 'Microphone permission is still pending. Check macOS permission settings and try again.',
  overlayWindowOptions: () => ({}),
  // Vibrancy belongs to the framed workspace only: native HUD material under the transparent overlay would obscure the apps beneath it.
  workspaceWindowOptions: ({ reduceTransparency }) => reduceTransparency ? {} : { vibrancy: 'window', visualEffectState: 'followWindow' },
  windowBackground: ({ reduceTransparency, dark }) => reduceTransparency ? (dark ? '#111111' : '#f5f5f7') : '#00000000',
  // Re-applies the workspaceWindowOptions rule whenever accessibility or theme settings change.
  applyWindowMaterial(window, input) {
    window.setBackgroundColor(darwinPlatform.windowBackground(input))
    window.setVibrancy(input.isOverlay || input.reduceTransparency ? null : 'window')
  },
  applyOverlayLevel(window) {
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  },
  // Reduce Motion and Reduce Transparency toggles arrive here; nativeTheme only reports colour-scheme changes.
  subscribeAccessibilityChanges(ports, callback) {
    let id: number | null = ports.subscribeWorkspaceNotification('NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification', callback)
    return () => { if (id !== null) { ports.unsubscribeWorkspaceNotification(id); id = null } }
  },
  // The packaged icon is for the Dock and Finder; the menu bar wants the monochrome glyph.
  trayIcon(_iconPath, ports) {
    const image = ports.createFromDataURL(MENU_BAR_GLYPH)
    image.setTemplateImage(true)
    return image
  },
  credentialEncryptionAvailable: ports => ports.isEncryptionAvailable(),
  credentialUnavailableMessage: action => action === 'read' ? 'OS credential encryption is unavailable. Unlock your keychain and restart Faangin.' : 'OS credential encryption is unavailable. No key was saved.'
}
