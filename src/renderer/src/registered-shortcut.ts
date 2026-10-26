import type { AppState } from '../../shared/types'

const legacyLabels = { assist: 'Assist', solve: 'Solve', reply: 'Suggested reply' } as const

/** Similar names are separate actions: Capture & solve must not suppress a local Solve fallback. */
export function hasRegisteredActionShortcut(shortcuts: AppState['shortcuts'], action: keyof typeof legacyLabels): boolean {
  return shortcuts.some(shortcut => shortcut.registered && (shortcut.id ? shortcut.id === action : shortcut.action === legacyLabels[action]))
}
