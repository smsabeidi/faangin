import type { Settings, WorkspaceMode } from '../shared/types'

export type PresetKind = 'response' | 'notes'
export type PresetMode = WorkspaceMode | 'any'
export interface PresetDraft { name: string; kind: PresetKind; mode: PresetMode; instructions: string }
export interface PromptPreset extends PresetDraft { id: string; builtIn: boolean; createdAt: number; updatedAt: number; revision: number }
export interface SessionPresetChoice { responseId: string | null; noteTemplateId: string | null }
export interface PresetCatalogSnapshot { version: 1; revision: number; presets: PromptPreset[]; choices: Record<string, SessionPresetChoice> }
export const PRESET_LIMITS = { count: 100, choices: 1_000, name: 80, responseCharacters: 4_000, noteCharacters: 2_000 } as const

const defaults: Array<PresetDraft & { id: string }> = [
  { id: 'builtin:meeting-response', name: 'Meeting · concise assistance', kind: 'response', mode: 'meeting', instructions: 'Lead with the useful answer. Keep suggested spoken replies concise. Separate confirmed decisions from suggestions and ask a focused question when facts are missing.' },
  { id: 'builtin:interview-coach', name: 'Interview · reasoning coach', kind: 'response', mode: 'interview', instructions: 'Explain the reasoning and trade-offs before implementation. Use the selected interview stage and actual candidate attempt. Prefer an incremental hint for Hint; preserve the full structured contract for Solve.' },
  { id: 'builtin:system-design', name: 'Interview · system design', kind: 'response', mode: 'interview', instructions: 'Make scale assumptions explicit. Explain component boundaries, data flow, bottlenecks, failure modes, and trade-offs. Use concrete units in capacity estimates and ask for missing requirements.' },
  { id: 'builtin:behavioral', name: 'Interview · supported STAR stories', kind: 'response', mode: 'interview', instructions: 'Help organize supplied real experience into Situation, Task, Action, Result. Keep suggested wording conversational. Ask for missing evidence instead of inventing personal facts or metrics.' },
  { id: 'builtin:meeting-notes', name: 'Meeting · decisions and actions', kind: 'notes', mode: 'meeting', instructions: 'Summary; key topics; confirmed decisions; proposed ideas; action items with owners and due dates only when explicitly stated; open questions. Include transcript references where useful.' },
  { id: 'builtin:interview-notes', name: 'Interview · practice review', kind: 'notes', mode: 'interview', instructions: 'Problem and explicit constraints; approach discussed; candidate reasoning and implementation; supported correctness observations; edge cases; improvements to practice next. Do not invent a score or hiring outcome.' }
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid preset data.')
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported preset field.')
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) throw new Error('Invalid preset or session ID.')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid preset revision or timestamp.')
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Enter nonempty text of at most ${max} characters.`)
  return value
}
export function validatePresetDraft(value: unknown): PresetDraft {
  const data = object(value); fields(data, ['name', 'kind', 'mode', 'instructions'])
  if (data.kind !== 'response' && data.kind !== 'notes') throw new Error('Choose a response preset or note template.')
  if (!['meeting', 'interview', 'any'].includes(String(data.mode))) throw new Error('Choose a supported preset mode.')
  return { name: text(data.name, PRESET_LIMITS.name).trim(), kind: data.kind, mode: data.mode as PresetMode, instructions: text(data.instructions, data.kind === 'notes' ? PRESET_LIMITS.noteCharacters : PRESET_LIMITS.responseCharacters) }
}
function validatePreset(value: unknown): PromptPreset {
  const data = object(value); fields(data, ['id', 'name', 'kind', 'mode', 'instructions', 'builtIn', 'createdAt', 'updatedAt', 'revision'])
  const draft = validatePresetDraft({ name: data.name, kind: data.kind, mode: data.mode, instructions: data.instructions })
  const presetId = id(data.id), known = defaults.find(item => item.id === presetId)
  if (typeof data.builtIn !== 'boolean' || data.builtIn !== !!known || (!known && presetId.startsWith('builtin:'))) throw new Error('Invalid built-in preset identity.')
  const createdAt = integer(data.createdAt), updatedAt = integer(data.updatedAt)
  if (updatedAt < createdAt) throw new Error('Invalid preset timestamps.')
  return { ...draft, id: presetId, builtIn: data.builtIn, createdAt, updatedAt, revision: integer(data.revision) }
}
function emptyChoice(): SessionPresetChoice { return { responseId: null, noteTemplateId: null } }
function compatible(preset: PromptPreset, mode: WorkspaceMode): boolean { return preset.mode === 'any' || preset.mode === mode }

/** Serializable local configuration. Reading a choice never selects a preset implicitly. */
export class PresetCatalog {
  private state: PresetCatalogSnapshot
  private readonly now: () => number
  private readonly createId: () => string
  constructor(snapshot?: unknown, options: { now?: () => number; createId?: () => string } = {}) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID())
    if (snapshot === undefined) {
      const timestamp = integer(this.now())
      this.state = { version: 1, revision: 0, presets: defaults.map(preset => ({ ...preset, builtIn: true, createdAt: timestamp, updatedAt: timestamp, revision: 0 })), choices: {} }
      return
    }
    const data = object(snapshot); fields(data, ['version', 'revision', 'presets', 'choices'])
    if (data.version !== 1 || !Array.isArray(data.presets) || data.presets.length > PRESET_LIMITS.count) throw new Error('Invalid preset catalog version or size.')
    const presets = data.presets.map(validatePreset)
    if (new Set(presets.map(preset => preset.id)).size !== presets.length) throw new Error('Duplicate preset ID.')
    const choices = object(data.choices)
    if (Object.keys(choices).length > PRESET_LIMITS.choices) throw new Error('Too many saved session choices.')
    const validated: Record<string, SessionPresetChoice> = {}
    for (const [sessionId, value] of Object.entries(choices)) {
      id(sessionId); const choice = object(value); fields(choice, ['responseId', 'noteTemplateId'])
      const responseId = choice.responseId === null ? null : id(choice.responseId), noteTemplateId = choice.noteTemplateId === null ? null : id(choice.noteTemplateId)
      if (responseId && !presets.some(preset => preset.id === responseId && preset.kind === 'response')) throw new Error('A selected response preset is unavailable.')
      if (noteTemplateId && !presets.some(preset => preset.id === noteTemplateId && preset.kind === 'notes')) throw new Error('A selected note template is unavailable.')
      Object.defineProperty(validated, sessionId, { value: { responseId, noteTemplateId }, enumerable: true, writable: true, configurable: true })
    }
    this.state = { version: 1, revision: integer(data.revision), presets, choices: validated }
  }
  snapshot(): PresetCatalogSnapshot { return structuredClone(this.state) }
  list(): PromptPreset[] { return structuredClone(this.state.presets) }
  choice(sessionId: string): SessionPresetChoice { id(sessionId); return { ...(Object.hasOwn(this.state.choices, sessionId) ? this.state.choices[sessionId] : emptyChoice()) } }
  private changed(): void { this.state.revision = integer(this.state.revision + 1) }
  private find(presetId: string): PromptPreset {
    const preset = this.state.presets.find(item => item.id === id(presetId))
    if (!preset) throw new Error('This preset is unavailable. Refresh the preset list.')
    return preset
  }
  create(value: unknown): PromptPreset {
    const draft = validatePresetDraft(value)
    if (this.state.presets.length >= PRESET_LIMITS.count) throw new Error('Delete a preset before adding another. At most 100 presets can be saved.')
    const presetId = id(this.createId())
    if (presetId.startsWith('builtin:') || this.state.presets.some(item => item.id === presetId)) throw new Error('Preset ID collision.')
    const timestamp = integer(this.now()), preset = { ...draft, id: presetId, builtIn: false, createdAt: timestamp, updatedAt: timestamp, revision: 0 }
    this.state.presets.push(preset); this.changed(); return { ...preset }
  }
  update(presetId: string, value: unknown, expectedRevision: number): PromptPreset {
    const current = this.find(presetId)
    if (integer(expectedRevision) !== current.revision) throw new Error('This preset changed in another window. Refresh before saving your edits.')
    const draft = validatePresetDraft(value)
    // Changing a selected preset's kind/mode would silently change session configuration.
    if (draft.kind !== current.kind || draft.mode !== current.mode) throw new Error('Duplicate the preset to choose a different kind or mode.')
    Object.assign(current, draft, { revision: integer(current.revision + 1), updatedAt: Math.max(current.createdAt, integer(this.now())) })
    this.changed(); return { ...current }
  }
  duplicate(presetId: string): PromptPreset {
    const source = this.find(presetId)
    return this.create({ name: `${source.name.slice(0, PRESET_LIMITS.name - 7)} (copy)`, kind: source.kind, mode: source.mode, instructions: source.instructions })
  }
  delete(presetId: string): void {
    this.find(presetId); this.state.presets = this.state.presets.filter(item => item.id !== presetId)
    for (const choice of Object.values(this.state.choices)) {
      if (choice.responseId === presetId) choice.responseId = null
      if (choice.noteTemplateId === presetId) choice.noteTemplateId = null
    }
    this.changed()
  }
  restoreDefaults(): void {
    const custom = this.state.presets.filter(item => !item.builtIn)
    if (custom.length + defaults.length > PRESET_LIMITS.count) throw new Error('Delete a custom preset before restoring all built-in defaults.')
    const timestamp = integer(this.now())
    this.state.presets = [...defaults.map(draft => {
      const prior = this.state.presets.find(item => item.id === draft.id)
      return { ...draft, builtIn: true, createdAt: prior?.createdAt ?? timestamp, updatedAt: Math.max(prior?.createdAt ?? timestamp, timestamp), revision: prior ? integer(prior.revision + 1) : 0 }
    }), ...custom]
    this.changed()
  }
  select(sessionId: string, mode: WorkspaceMode, kind: PresetKind, presetId: string | null): SessionPresetChoice {
    id(sessionId)
    if (!['meeting', 'interview'].includes(mode) || !['response', 'notes'].includes(kind)) throw new Error('Choose a supported session and preset kind.')
    if (presetId !== null) {
      const preset = this.find(presetId)
      if (preset.kind !== kind || !compatible(preset, mode)) throw new Error('Choose a preset that supports this session mode.')
    }
    if (!Object.hasOwn(this.state.choices, sessionId) && Object.keys(this.state.choices).length >= PRESET_LIMITS.choices) throw new Error('Too many saved session preset choices.')
    const choice = this.choice(sessionId)
    choice[kind === 'response' ? 'responseId' : 'noteTemplateId'] = presetId
    Object.defineProperty(this.state.choices, sessionId, { value: choice, enumerable: true, writable: true, configurable: true })
    this.changed(); return { ...choice }
  }
  clearSession(sessionId: string): void { id(sessionId); if (Object.hasOwn(this.state.choices, sessionId)) { delete this.state.choices[sessionId]; this.changed() } }
  resolve(sessionId: string, mode: WorkspaceMode): { response: PromptPreset | null; notes: PromptPreset | null } {
    const choice = this.choice(sessionId)
    const resolve = (presetId: string | null, kind: PresetKind): PromptPreset | null => {
      if (!presetId) return null
      const preset = this.find(presetId)
      if (preset.kind !== kind || !compatible(preset, mode)) throw new Error('The saved preset does not support this session mode. Choose another preset.')
      return { ...preset }
    }
    return { response: resolve(choice.responseId, 'response'), notes: resolve(choice.noteTemplateId, 'notes') }
  }
  settingsFor(sessionId: string, mode: WorkspaceMode, settings: Settings): Settings {
    const selected = this.resolve(sessionId, mode)
    return { ...settings, instructions: selected.response?.instructions ?? settings.instructions, noteTemplate: selected.notes?.instructions ?? settings.noteTemplate }
  }
}
