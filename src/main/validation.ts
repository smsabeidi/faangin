import type { Action, AudioChannel, GenerateInput, InterviewContext, SessionListFilter, Settings, WorkspaceMode, WindowKind } from '../shared/types'
import { DEFAULT_INTERVIEW_CONTEXT, OVERLAY_OPACITY } from '../shared/types'
import { normalizeAccelerator, overridesAfterRetiredPreset, RETIRED_SHORTCUT_PRESETS, SHORTCUT_ACTIONS, SHORTCUT_PRESETS } from './shortcut-manager'
import { normalizeCompatibleChatEndpoint } from './compatible-chat'

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid request object.')
  return value as Record<string, unknown>
}
export function text(value: unknown, max = 100_000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) throw new Error('Invalid text value.')
  return value
}
export function id(value: unknown): string { return text(value, 100) }
export function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Invalid boolean value.'); return value }
export function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('Unsupported option.')
  return value as T
}
export const channel = (value: unknown): AudioChannel => oneOf(value, ['microphone', 'system'])
export const mode = (value: unknown): WorkspaceMode => oneOf(value, ['meeting', 'interview'])
export const windowKind = (value: unknown): WindowKind => oneOf(value, ['workspace', 'overlay'])
export function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Number is outside the allowed range.')
  return value
}
export function sessionListFilter(value: unknown): SessionListFilter {
  if (value === undefined) return {}
  const input = record(value); onlyKeys(input, ['updatedFrom', 'updatedBefore', 'mode'])
  const result: SessionListFilter = {}
  for (const key of ['updatedFrom', 'updatedBefore'] as const) if (input[key] !== undefined) {
    const number = finite(input[key], 0, 8_640_000_000_000_000)
    if (!Number.isSafeInteger(number)) throw new Error('Session dates must use whole milliseconds.')
    result[key] = number
  }
  if (input.mode !== undefined) result.mode = mode(input.mode)
  if (result.updatedFrom !== undefined && result.updatedBefore !== undefined && result.updatedFrom >= result.updatedBefore) throw new Error('Choose an end date on or after the start date.')
  return result
}
export function generation(value: unknown): number { const n = finite(value, 0, Number.MAX_SAFE_INTEGER); if (!Number.isInteger(n)) throw new Error('Invalid capture generation.'); return n }
export function onlyKeys(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(k => !keys.includes(k))) throw new Error('Unsupported request field.') }
export function settingsPatch(value: unknown): Partial<Settings> {
  const object = record(value)
  const result: Partial<Settings> = {}
  const strings: Record<string, number> = { fastModel: 100, smartModel: 100, transcriptionModel: 100, inputLanguage: 32, outputLanguage: 100, programmingLanguage: 100, profile: 100_000, jobDescription: 100_000, instructions: 30_000, noteTemplate: 20_000, microphoneDeviceId: 256, screenshotSourceId: 256, compatibleChatModel: 128, compatibleChatSmartModel: 128 }
  const booleans = ['microphone', 'systemAudio', 'liveSuggestions', 'privacyMode', 'includeHistory', 'launchAtLogin', 'hideDockIcon', 'smartMode', 'historyEnabled', 'compatibleChatVision', 'overlayCollapsed']
  onlyKeys(object, [...Object.keys(strings), ...booleans, 'theme', 'opacity', 'overlayExpandedHeight', 'fontSize', 'shortcutPreset', 'shortcutOverrides', 'captureIdleMinutes', 'chatProvider', 'compatibleChatEndpoint', 'liveSuggestionSource'])
  for (const [key, value] of Object.entries(object)) {
    if (strings[key]) (result as Record<string, unknown>)[key] = text(value, strings[key], !key.endsWith('Model') || key.startsWith('compatibleChat'))
    else if (booleans.includes(key)) (result as Record<string, unknown>)[key] = bool(value)
    else if (key === 'theme') result.theme = oneOf(value, ['dark', 'light', 'system'] as const)
    else if (key === 'chatProvider') result.chatProvider = oneOf(value, ['openai', 'compatible'] as const)
    else if (key === 'liveSuggestionSource') result.liveSuggestionSource = channel(value)
    else if (key === 'compatibleChatEndpoint') result.compatibleChatEndpoint = value === '' ? '' : normalizeCompatibleChatEndpoint(value)
    else if (key === 'opacity') result.opacity = finite(value, OVERLAY_OPACITY.min, OVERLAY_OPACITY.max)
    else if (key === 'overlayExpandedHeight') result.overlayExpandedHeight = Math.round(finite(value, 400, 10_000))
    else if (key === 'fontSize') result.fontSize = finite(value, 11, 24)
    // A retired keymap maps to Faangin's so older saved settings never fail validation and reset.
    else if (key === 'shortcutPreset') result.shortcutPreset = (RETIRED_SHORTCUT_PRESETS as readonly unknown[]).includes(value) ? 'faangin' : oneOf(value, SHORTCUT_PRESETS)
    else if (key === 'shortcutOverrides') {
      const overrides = record(value); onlyKeys(overrides, [...SHORTCUT_ACTIONS])
      result.shortcutOverrides = Object.fromEntries(Object.entries(overrides).map(([action, accelerator]) => [action, accelerator === null ? null : normalizeAccelerator(text(accelerator, 160))]))
    } else if (key === 'captureIdleMinutes') {
      const minutes = finite(value, 0, 1440)
      if (!Number.isInteger(minutes)) throw new Error('Idle timeout must use whole minutes.')
      result.captureIdleMinutes = minutes
    }
  }
  if ((RETIRED_SHORTCUT_PRESETS as readonly unknown[]).includes(object.shortcutPreset) && result.shortcutOverrides) result.shortcutOverrides = overridesAfterRetiredPreset(result.shortcutOverrides)
  return result
}
export function interviewContext(value: unknown): InterviewContext {
  const object = record(value)
  onlyKeys(object, Object.keys(DEFAULT_INTERVIEW_CONTEXT))
  return { company: text(object.company, 120, true), role: text(object.role, 200, true),
    round: oneOf(object.round, ['coding', 'system-design', 'behavioral']), stage: oneOf(object.stage, ['clarify', 'approach', 'implement', 'verify', 'optimize']),
    problem: text(object.problem, 8_000, true), constraints: text(object.constraints, 4_000, true), candidateAttempt: text(object.candidateAttempt, 12_000, true) }
}
export function sessionPatch(value: unknown): { title?: string; notes?: string; interview?: InterviewContext } {
  const object = record(value); onlyKeys(object, ['title', 'notes', 'interview'])
  return { ...(object.title !== undefined ? { title: text(object.title, 200) } : {}), ...(object.notes !== undefined ? { notes: text(object.notes, 200_000, true) } : {}), ...(object.interview !== undefined ? { interview: interviewContext(object.interview) } : {}) }
}
export const ACTIONS: readonly Action[] = ['ask', 'assist', 'reply', 'followup', 'draft', 'recap', 'hint', 'solve', 'review', 'debug', 'design', 'behavioral', 'notes']
export function generateInput(value: unknown): GenerateInput {
  const object = record(value); onlyKeys(object, ['sessionId', 'action', 'prompt', 'attachmentIds', 'smart', 'replaceActive'])
  const attachmentIds = object.attachmentIds === undefined ? [] : object.attachmentIds
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 4) throw new Error('At most four images may be selected.')
  return { sessionId: id(object.sessionId), action: oneOf(object.action, ACTIONS), prompt: object.prompt === undefined ? '' : text(object.prompt, 30_000, true), attachmentIds: attachmentIds.map(id), smart: object.smart === undefined ? undefined : bool(object.smart), ...(object.replaceActive === undefined ? {} : { replaceActive: bool(object.replaceActive) }) }
}
export function pcm(value: unknown): Uint8Array {
  if (!(value instanceof ArrayBuffer) || value.byteLength < 2 || value.byteLength > 48_000 || value.byteLength % 2) throw new Error('Invalid PCM frame.')
  return new Uint8Array(value)
}

/** Inspect dimensions before native decoding can allocate an oversized bitmap. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20)
  } else if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) break
      while (buffer[offset] === 0xff) offset++
      const marker = buffer[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker >= 0xd0 && marker <= 0xd7) continue
      if (offset + 2 > buffer.length) break
      const length = buffer.readUInt16BE(offset)
      if (length < 2 || offset + length > buffer.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) { height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break }
      offset += length
    }
  } else if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16)
    if (kind === 'VP8X') { width = buffer.readUIntLE(24, 3) + 1; height = buffer.readUIntLE(27, 3) + 1 }
    else if (kind === 'VP8L' && buffer[20] === 0x2f) { const bits = buffer.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1 }
    else if (kind === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 1 && buffer[25] === 0x2a) { width = buffer.readUInt16LE(26) & 0x3fff; height = buffer.readUInt16LE(28) & 0x3fff }
  }
  if (!width || !height || width > 16_000 || height > 16_000 || width * height > 24_000_000) throw new Error('Choose a valid PNG, JPEG or WebP image with at most 24 million pixels.')
  return { width, height }
}
