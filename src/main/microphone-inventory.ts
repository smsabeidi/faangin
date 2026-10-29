import type { MicrophoneDevice } from '../shared/types'

/** Inventory is private device metadata, never profile, diagnostic, or prompt context. */
export function validateMicrophoneInventory(value: unknown): MicrophoneDevice[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Microphone inventory was unavailable. Refresh devices again.')
  const ids = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Microphone inventory was unavailable. Refresh devices again.')
    const { deviceId, label } = item as Record<string, unknown>
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 256 || /[\x00-\x1f\x7f]/.test(deviceId) || ids.has(deviceId) || typeof label !== 'string' || label.length > 160) throw new Error('Microphone inventory was unavailable. Refresh devices again.')
    ids.add(deviceId)
    return { deviceId, label: label.replace(/[\x00-\x1f\x7f]/g, ' ').trim() }
  })
}
