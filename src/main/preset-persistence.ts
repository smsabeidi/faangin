import { PresetCatalog, type PresetCatalogSnapshot, type SessionPresetChoice } from './presets'
import type { WorkspaceMode } from '../shared/types'

/** RAM edits cannot silently delete the saved preset choices of a shadowed session. */
export function durablePresetSnapshot(next: PresetCatalogSnapshot, previous: PresetCatalogSnapshot, disposition: (id: string) => { persistent: boolean; savedSnapshot: boolean; mode: WorkspaceMode } | null): PresetCatalogSnapshot {
  const snapshot = structuredClone(next), choices: Record<string, SessionPresetChoice> = {}
  for (const [id, choice] of Object.entries(next.choices)) if (disposition(id)?.persistent) choices[id] = structuredClone(choice)
  for (const [id, choice] of Object.entries(previous.choices)) {
    const session = disposition(id)
    if (!session || session.persistent || !session.savedSnapshot) continue
    const retained = (selected: string | null, kind: 'response' | 'notes') => selected && next.presets.some(preset => preset.id === selected && preset.kind === kind && (preset.mode === 'any' || preset.mode === session.mode)) ? selected : null
    choices[id] = { responseId: retained(choice.responseId, 'response'), noteTemplateId: retained(choice.noteTemplateId, 'notes') }
  }
  snapshot.choices = choices
  return new PresetCatalog(snapshot).snapshot()
}
