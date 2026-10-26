import type { Action } from '../../shared/types'

interface ComposerShortcutInput {
  prompt: string
  solve: boolean
  working: boolean
  busy: boolean
  registeredShortcut: boolean
}

/** Local fallback only: a registered native shortcut owns dispatch and must not be duplicated. */
export function composerShortcutRequest(input: ComposerShortcutInput): { action: Action; prompt: string } | null {
  if (input.working || input.busy || input.registeredShortcut) return null
  const prompt = input.prompt.trim()
  return { action: input.solve ? 'solve' : prompt ? 'ask' : 'assist', prompt }
}
