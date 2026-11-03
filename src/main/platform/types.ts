import type { BrowserWindowConstructorOptions, NativeImage } from 'electron'
import type { AccessPermissionKind, PlatformId } from '../../shared/types'

/**
 * Desktop platform contract.
 *
 * Every operating-system difference the main process cares about is expressed here once, so
 * `src/main/index.ts` never branches on `process.platform` directly. Implementations live in
 * `darwin.ts`, `win32.ts` and `linux.ts`; `index.ts` selects one. Methods take narrow "port"
 * objects instead of Electron classes so each implementation is unit-testable without Electron.
 *
 * Rules for maintainers:
 *  - Add a capability here first, then implement it for every platform (a no-op is a valid answer).
 *  - Keep this file free of runtime Electron imports; type-only imports are erased at build time.
 *  - User-facing copy that names the OS or its settings app belongs on the platform object, not in callers.
 */
export type { AccessPermissionKind, PlatformId }
/** The permissions an OS can report a status for; 'system-audio' is Faangin's own capture check and has no OS status. */
export type MediaPermissionKind = Exclude<AccessPermissionKind, 'system-audio'>

/**
 * Electron's media access statuses plus two Faangin values: `not-required` when the OS has no such
 * permission concept, and `unknown` when the status cannot be read on this OS.
 */
export type MediaAccessState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'not-required' | 'unknown'

/** Subset of Electron's `systemPreferences` used for permissions. */
export interface MediaAccessPorts {
  getMediaAccessStatus(kind: MediaPermissionKind): string
  askForMediaAccess(kind: 'microphone'): Promise<boolean>
}

export interface MicrophoneAccessResult {
  allowed: boolean
  /** Present when access is unavailable; already phrased for this OS. */
  message?: string
}

/** Subset of Electron's `BrowserWindow` used for window material. */
export interface WindowMaterialPorts {
  setBackgroundColor(color: string): void
  setVibrancy(material: 'window' | null): void
}

export type AlwaysOnTopLevel = 'normal' | 'floating' | 'torn-off-menu' | 'modal-panel' | 'main-menu' | 'status' | 'pop-up-menu' | 'screen-saver' | 'dock'

/** Subset of Electron's `BrowserWindow` used to keep the overlay above other apps. */
export interface OverlayLevelPorts {
  setAlwaysOnTop(flag: boolean, level?: AlwaysOnTopLevel, relativeLevel?: number): void
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void
}

/** Subset of Electron's `systemPreferences` used for accessibility-appearance change notifications. */
export interface AppearancePorts {
  subscribeWorkspaceNotification(event: string, callback: () => void): number
  unsubscribeWorkspaceNotification(id: number): void
  on(event: 'accent-color-changed' | 'color-changed', callback: () => void): unknown
  removeListener(event: 'accent-color-changed' | 'color-changed', callback: () => void): unknown
}

/** Subset of Electron's `nativeImage` used to build the tray icon. */
export interface TrayImagePorts {
  createFromPath(path: string): NativeImage
  createFromDataURL(dataURL: string): NativeImage
}

/** Subset of Electron's `safeStorage` used for credential encryption availability. */
export interface SafeStoragePorts {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
}

export interface WindowBackgroundInput {
  isOverlay: boolean
  reduceTransparency: boolean
  /** `nativeTheme.shouldUseDarkColors` at call time. */
  dark: boolean
}

export interface DesktopPlatform {
  readonly id: PlatformId
  /** Marketing name for UI copy and diagnostics. */
  readonly displayName: 'macOS' | 'Windows' | 'Linux'
  /** The OS preferences app, named the way the OS names it (e.g. "System Settings", "Windows Settings"). */
  readonly settingsAppName: string
  /** Where the OS shows the running app outside its windows. */
  readonly appPresence: 'dock' | 'taskbar'
  /** Where the app's always-available recovery menu lives, for UI copy (e.g. "Menu bar", "Tray"). */
  readonly recoveryMenuName: string
  /** Whether the app can hide its Dock/taskbar presence (macOS accessory activation policy). */
  readonly supportsHiddenAppIcon: boolean
  /** Whether the process should quit once every window is closed (Windows/Linux convention). */
  readonly quitsWhenAllWindowsClosed: boolean
  /** Whether the OS has a screen-recording permission at all. */
  readonly screenPermissionRequired: boolean
  /** Whether computer-audio capture is gated behind screen-recording consent (macOS). */
  readonly screenAccessGatesSystemAudio: boolean
  /** Whether the OS shows its own microphone prompt that the app must await before capturing. */
  readonly promptsForMicrophone: boolean
  /** Whether workspace windows may use translucent native material (macOS vibrancy). */
  readonly supportsWindowMaterial: boolean
  /** Name of the OS-backed credential store, for error copy (e.g. "Keychain", "Windows credential protection (DPAPI)"). */
  readonly credentialStoreName: string
  /** Taskbar/notification identity. Must equal the electron-builder `appId`. `null` where the OS has no such concept. */
  readonly appUserModelId: string | null
  /** Default device label when the hostname is empty (e.g. "Mac", "Windows PC"). */
  readonly defaultDeviceName: string

  /** Reads one permission without prompting. Never throws; unreadable statuses are `unknown`. */
  permissionStatus(kind: MediaPermissionKind, ports: MediaAccessPorts): MediaAccessState
  /**
   * Deep link into the OS settings page for `kind`, or `null` when the OS has none. Computer audio has no
   * permission of its own: it points at the consent pane that gates it (macOS) or at the sound settings
   * where the captured playback device is chosen (Windows).
   */
  permissionSettingsUrl(kind: AccessPermissionKind): string | null
  /** Copy for a failed computer-audio check; `denied` when the OS or the app refused the capture rather than it producing no audio. */
  systemAudioUnavailableMessage(denied: boolean): string
  /**
   * Resolves microphone access immediately before capture starts. Prompts where the OS prompts
   * (macOS), reads the global privacy switch where it does not (Windows), and allows elsewhere.
   * Callers wrap this in their own timeout/abort handling.
   */
  microphoneAccess(ports: MediaAccessPorts): Promise<MicrophoneAccessResult>
  /** Copy shown when the OS prompt has not been answered within the capture start timeout. */
  pendingMicrophoneMessage(): string

  /** Extra `BrowserWindow` options for the floating overlay (transparent, frameless, always on top). */
  overlayWindowOptions(): BrowserWindowConstructorOptions
  /** Extra `BrowserWindow` options for framed workspace windows. */
  workspaceWindowOptions(input: { reduceTransparency: boolean }): BrowserWindowConstructorOptions
  /** Background colour for a UI window; transparent where the renderer or native material paints it. */
  windowBackground(input: WindowBackgroundInput): string
  /** Applies `windowBackground` and any native material to an existing window after an appearance change. */
  applyWindowMaterial(window: WindowMaterialPorts, input: WindowBackgroundInput): void
  /** Keeps the overlay above other apps, including full-screen apps where the OS allows it. */
  applyOverlayLevel(window: OverlayLevelPorts): void
  /** Subscribes to accessibility-appearance changes that `nativeTheme` `updated` does not report; returns an unsubscribe. */
  subscribeAccessibilityChanges(ports: AppearancePorts, callback: () => void): () => void
  /** Builds the tray/menu-bar icon from the packaged application icon path. */
  trayIcon(iconPath: string, ports: TrayImagePorts): NativeImage
  /** Whether OS-backed credential encryption is usable (rejects Linux plaintext fallback). */
  credentialEncryptionAvailable(ports: SafeStoragePorts): boolean
  /** Error copy for an unavailable credential store, phrased for this OS. */
  credentialUnavailableMessage(action: 'read' | 'save'): string
}
