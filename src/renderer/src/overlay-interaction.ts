import { shortcutLabel } from '../../main/shortcut-manager'
import type { AppState } from '../../shared/types'

type InteractionShortcut = AppState['shortcuts'][number]

/** Only advertise the currently registered recovery binding, including custom overrides. */
export function overlayInteractionRecovery(shortcuts: readonly InteractionShortcut[], platform: string): { shortcut: string | null; hint: string } {
  const menu = platform === 'darwin' ? 'menu bar' : 'system tray'
  const binding = shortcuts.find(value => value.registered && (value.id === 'toggle-interaction' || value.action === 'Toggle overlay interaction'))
  if (binding) {
    try {
      const shortcut = shortcutLabel(binding.accelerator, platform as Parameters<typeof shortcutLabel>[1])
      return { shortcut, hint: `Press ${shortcut} to make the overlay interactive again, or use Make overlay interactive in the ${menu}.` }
    } catch { /* A stale or invalid binding must not promise a working shortcut. */ }
  }
  return { shortcut: null, hint: `Use Make overlay interactive in the ${menu}, or choose Make overlay interactive in the workspace.` }
}

export function overlayInteractionDescription(enabled: boolean, recovery: string): string {
  return `${enabled ? 'Click-through is on. Clicks and scrolling go to the app underneath.' : 'Enable click-through to send clicks and scrolling to the app underneath.'} ${recovery}`
}
