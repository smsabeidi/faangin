import type { WindowKind } from '../../shared/types'

type ModifierKeyEvent = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>
type SettingsKeyEvent = ModifierKeyEvent & Pick<KeyboardEvent, 'key' | 'preventDefault'>

/** Cmd is the app modifier on macOS and Ctrl elsewhere, so the Windows key never triggers local actions; until the platform is known both are honoured. */
export function primaryModifierPressed(event: ModifierKeyEvent, platform?: string): boolean {
  if (!platform) return event.metaKey || event.ctrlKey
  return platform === 'darwin' ? event.metaKey : event.ctrlKey
}

/** The overlay has no local Settings view: open the real workspace surface. */
export function handleSettingsShortcut(event: SettingsKeyEvent, windowKind: WindowKind | undefined, openWorkspaceSettings: () => Promise<unknown>, openLocalSettings: () => void, platform?: string): boolean {
  if (!primaryModifierPressed(event, platform) || event.key !== ',') return false
  event.preventDefault()
  if (windowKind === 'overlay') void openWorkspaceSettings()
  else openLocalSettings()
  return true
}
