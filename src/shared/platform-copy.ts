import type { DesktopPlatform, PlatformId } from '../main/platform/types'

/**
 * OS-specific copy for the renderer.
 *
 * The main process owns platform behaviour through `DesktopPlatform` (src/main/platform), but AppState
 * carries only the raw `permissions.platform` string, so the renderer derives the matching names, paths
 * and keys here from that id. Every dialog reads this one table, so no two screens can describe the same
 * OS differently. Pure data: no Electron, no React, no `process`.
 */
export type PermissionCopyKind = 'microphone' | 'screen' | 'system-audio'

export interface PlatformCopy {
  readonly id: PlatformId
  readonly name: DesktopPlatform['displayName']
  /** The OS preferences app, named the way the OS names it. */
  readonly settingsApp: string
  /** Where the always-available recovery menu lives. */
  readonly recoveryMenu: 'Menu bar' | 'Tray'
  /** The primary shortcut modifier in prose. Windows abbreviates to Ctrl because that is what its keycaps and `shortcutLabel` badges show. */
  readonly modifier: 'Command' | 'Ctrl'
  /** The same modifier as a key badge, matching `shortcutLabel` output. */
  readonly modifierKey: '⌘' | 'Ctrl'
  /** Where the OS keeps its microphone switch. */
  readonly microphonePath: string
  /** Where the OS keeps screen-recording consent, or null where no such permission exists. */
  readonly screenPath: string | null
  readonly screenPermissionRequired: boolean
  /** Whether a first request shows an OS consent prompt; elsewhere every request opens the settings app. */
  readonly promptsOnRequest: boolean
  /** How the OS's own UI calls the machine in short prose ("this Mac", "This PC"). */
  readonly deviceNoun: 'Mac' | 'PC'
  /** Appended where a permission change may need an app restart; empty elsewhere. */
  readonly restartNote: string
  /** Whether the app can deep-link into the OS settings page for `kind`. */
  canOpenSettings(kind: PermissionCopyKind): boolean
  /** What to change on the settings page for `kind`, as a clause callers place after its path; empty where there is no page. */
  permissionAction(kind: PermissionCopyKind): string
  /** Complete guidance for `kind`: the page to open and what to change there, or why nothing is needed. */
  permissionHelp(kind: PermissionCopyKind): string
}

const DARWIN_MICROPHONE = 'System Settings → Privacy & Security → Microphone'
// Computer audio has no pane of its own on macOS; screen-recording consent covers it.
const DARWIN_SCREEN = 'System Settings → Privacy & Security → Screen & System Audio Recording'
// Windows 11 calls the section Privacy & security and Windows 10 calls it Privacy, and the toggle labels differ between them too, so the action says what each switch does.
const WIN32_MICROPHONE = 'Settings → Privacy & security (Privacy on Windows 10) → Microphone'
// Desktop apps cannot be toggled individually on Windows; the two global switches (this device, and desktop apps) are the whole permission.
const WIN32_MICROPHONE_ACTION = 'turn on microphone access for this device and for desktop apps'
// Computer audio has no permission on Windows; the main process deep-links to Sound (ms-settings:sound), where the captured output device is chosen.
const WIN32_SOUND = 'Settings → System → Sound'
// Loopback follows the Default Device, which Settings calls the output device; a headset set only as the communications device stays silent.
const WIN32_SOUND_ACTION = 'choose the speakers or headset you listen on as the output device'
const LINUX_PRIVACY = 'your desktop privacy settings'
// Chromium captures loopback audio from the default render device, so the device is the only thing that can be wrong.
const PLAYBACK_HELP = 'Computer audio is captured from your default playback device. Make sure a playback device is active and not in exclusive mode.'
const noScreenPermission = (name: string) => `${name} does not need a screen-recording permission. Capture works as soon as you choose it.`

const darwin: PlatformCopy = Object.freeze({
  id: 'darwin',
  name: 'macOS',
  settingsApp: 'System Settings',
  recoveryMenu: 'Menu bar',
  modifier: 'Command',
  modifierKey: '⌘',
  microphonePath: DARWIN_MICROPHONE,
  screenPath: DARWIN_SCREEN,
  screenPermissionRequired: true,
  promptsOnRequest: true,
  deviceNoun: 'Mac',
  restartNote: 'macOS may ask you to restart the app.',
  canOpenSettings: () => true,
  permissionAction: () => 'enable Faangin',
  permissionHelp: kind => `Open ${kind === 'microphone' ? DARWIN_MICROPHONE : DARWIN_SCREEN} and enable Faangin.`
} satisfies PlatformCopy)

const win32: PlatformCopy = Object.freeze({
  id: 'win32',
  name: 'Windows',
  settingsApp: 'Windows Settings',
  recoveryMenu: 'Tray',
  modifier: 'Ctrl',
  modifierKey: 'Ctrl',
  microphonePath: WIN32_MICROPHONE,
  screenPath: null,
  screenPermissionRequired: false,
  promptsOnRequest: false,
  deviceNoun: 'PC',
  restartNote: '',
  canOpenSettings: kind => kind !== 'screen',
  permissionAction: kind => kind === 'microphone' ? WIN32_MICROPHONE_ACTION : kind === 'system-audio' ? WIN32_SOUND_ACTION : '',
  permissionHelp: kind => kind === 'microphone' ? `Open ${WIN32_MICROPHONE} and ${WIN32_MICROPHONE_ACTION}.` : kind === 'screen' ? noScreenPermission('Windows') : `Computer audio is captured from your default playback device. Open ${WIN32_SOUND} and ${WIN32_SOUND_ACTION}, and make sure it is not in exclusive mode.`
} satisfies PlatformCopy)

const linux: PlatformCopy = Object.freeze({
  id: 'linux',
  name: 'Linux',
  settingsApp: 'System Settings',
  recoveryMenu: 'Tray',
  modifier: 'Ctrl',
  modifierKey: 'Ctrl',
  microphonePath: LINUX_PRIVACY,
  screenPath: null,
  screenPermissionRequired: false,
  promptsOnRequest: false,
  deviceNoun: 'PC',
  restartNote: '',
  // Desktop environments differ too much for one deep link; the main process has none either.
  canOpenSettings: () => false,
  permissionAction: kind => kind === 'microphone' ? 'enable Faangin' : '',
  permissionHelp: kind => kind === 'microphone' ? `Open ${LINUX_PRIVACY} and enable Faangin.` : kind === 'screen' ? noScreenPermission('Linux') : PLAYBACK_HELP
} satisfies PlatformCopy)

/** Copy for the OS named by `AppState.permissions.platform`; anything that is not macOS or Windows is Linux, as in `platformId`. */
export function platformCopy(platform: string): PlatformCopy {
  return platform === 'darwin' ? darwin : platform === 'win32' ? win32 : linux
}
