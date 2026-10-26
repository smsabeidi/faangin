import type { WindowKind } from '../../shared/types'

type SettingsKeyEvent = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key' | 'preventDefault'>

/** The overlay has no local Settings view: open the real workspace surface. */
export function handleSettingsShortcut(event: SettingsKeyEvent, windowKind: WindowKind | undefined, openWorkspaceSettings: () => Promise<unknown>, openLocalSettings: () => void): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.key !== ',') return false
  event.preventDefault()
  if (windowKind === 'overlay') void openWorkspaceSettings()
  else openLocalSettings()
  return true
}
