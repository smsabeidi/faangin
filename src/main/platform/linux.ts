import type { DesktopPlatform } from './types'

// Linux has no media-permission API in Electron; 'unknown' lets AccessSetupCoordinator treat both permissions as not required.
export const linuxPlatform: DesktopPlatform = {
  id: 'linux',
  displayName: 'Linux',
  settingsAppName: 'System Settings',
  appPresence: 'taskbar',
  recoveryMenuName: 'Tray',
  supportsHiddenAppIcon: false,
  quitsWhenAllWindowsClosed: true,
  screenPermissionRequired: false,
  screenAccessGatesSystemAudio: false,
  promptsForMicrophone: false,
  supportsWindowMaterial: false,
  credentialStoreName: 'Keyring',
  appUserModelId: null,
  defaultDeviceName: 'Linux PC',
  permissionStatus: () => 'unknown',
  permissionSettingsUrl: () => null,
  systemAudioUnavailableMessage: () => 'Computer audio could not be verified. Make sure a playback device is set as default in your system sound settings, then retry the access check.',
  microphoneAccess: async () => ({ allowed: true }),
  pendingMicrophoneMessage: () => 'Microphone access could not be confirmed. Check your system sound settings, then try again.',
  overlayWindowOptions: () => ({}),
  workspaceWindowOptions: () => ({}),
  windowBackground: ({ isOverlay, reduceTransparency, dark }) => isOverlay && !reduceTransparency ? '#00000000' : dark ? '#111111' : '#f5f5f7',
  // setVibrancy is macOS-only; the solid or transparent colour is the whole material here.
  applyWindowMaterial: (window, input) => window.setBackgroundColor(linuxPlatform.windowBackground(input)),
  applyOverlayLevel(window) {
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true)
  },
  // Desktop environments differ too much to subscribe generically; nativeTheme 'updated' and window focus drive refreshes here.
  subscribeAccessibilityChanges: () => () => {},
  // 22px is the panel size GNOME and KDE status-notifier hosts render tray icons at.
  trayIcon: (iconPath, ports) => ports.createFromPath(iconPath).resize({ width: 22, height: 22 }),
  // basic_text is Electron's plaintext fallback when no Secret Service or KWallet is available, so it is not credential encryption.
  credentialEncryptionAvailable: ports => ports.isEncryptionAvailable() && ports.getSelectedStorageBackend() !== 'basic_text',
  credentialUnavailableMessage: action => action === 'read' ? 'OS credential encryption is unavailable. Unlock your keychain and restart Faangin.' : 'OS credential encryption is unavailable. No key was saved.'
}
