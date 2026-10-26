export interface MicrophoneDevice { deviceId: string; label: string }
export type MicrophoneListStatus = 'idle' | 'ready' | 'unsupported' | 'denied' | 'failed' | 'timeout' | 'cancelled'
export interface MicrophoneSnapshot { status: MicrophoneListStatus; devices: MicrophoneDevice[]; labelsRestricted: boolean; truncated: boolean; message: string }
export interface MicrophoneChoice { value: string; label: string; availability: 'default' | 'available' | 'unavailable' | 'unchecked' }
export const MICROPHONE_LIMITS = { devices: 64, deviceId: 256, label: 160 } as const
export const EMPTY_MICROPHONE_SNAPSHOT: MicrophoneSnapshot = { status: 'idle', devices: [], labelsRestricted: false, truncated: false, message: 'Refresh microphones to check the available inputs. Device discovery does not start capture.' }

/** Normalize only a bounded microphone inventory, never group IDs or other device metadata. */
export function normalizeMicrophoneDevices(value: unknown): { devices: MicrophoneDevice[]; labelsRestricted: boolean; truncated: boolean } {
  if (!Array.isArray(value)) throw new Error('Invalid microphone inventory.')
  const devices: MicrophoneDevice[] = [], seen = new Set<string>()
  let labelsRestricted = false
  for (let index = 0; index < Math.min(value.length, MICROPHONE_LIMITS.devices); index++) {
    const item = value[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if ('kind' in item && item.kind !== 'audioinput') continue
    const deviceId = item.deviceId
    if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > MICROPHONE_LIMITS.deviceId || /[\u0000-\u001F\u007F]/.test(deviceId)) { labelsRestricted = true; continue }
    if (seen.has(deviceId)) continue
    let label = typeof item.label === 'string' ? item.label.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() : ''
    label = label.slice(0, MICROPHONE_LIMITS.label)
    if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1)
    labelsRestricted ||= !label
    seen.add(deviceId); devices.push({ deviceId, label })
  }
  return { devices, labelsRestricted, truncated: value.length > MICROPHONE_LIMITS.devices }
}

/** The saved choice is always represented; discovery never substitutes another microphone. */
export function microphoneChoices(snapshot: MicrophoneSnapshot, selectedId: string): MicrophoneChoice[] {
  const choices: MicrophoneChoice[] = [{ value: '', label: 'System default microphone', availability: 'default' }]
  for (const [index, device] of snapshot.devices.entries()) choices.push({ value: device.deviceId, label: device.label || (device.deviceId === 'default' ? 'Default input — name unavailable' : device.deviceId === 'communications' ? 'Communications input — name unavailable' : `Microphone ${index + 1} — name unavailable`), availability: 'available' })
  if (selectedId && !choices.some(choice => choice.value === selectedId)) choices.push({ value: selectedId, label: snapshot.status === 'ready' ? 'Selected microphone — not available in this list' : 'Selected microphone — refresh to check availability', availability: snapshot.status === 'ready' ? 'unavailable' : 'unchecked' })
  return choices
}

/** Explicit inventory request only. No media stream, permission request, or automatic device selection. */
export async function refreshMicrophoneDevices(enumerate: (() => Promise<readonly MicrophoneDevice[]>) | undefined, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MicrophoneSnapshot> {
  const result = (status: MicrophoneListStatus, message: string): MicrophoneSnapshot => ({ status, message, devices: [], labelsRestricted: false, truncated: false })
  if (options.signal?.aborted) return result('cancelled', 'Microphone discovery was cancelled.')
  if (!enumerate) return result('unsupported', 'Microphone discovery is unavailable in this app window. You can keep the saved input or explicitly choose the system default.')
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid microphone discovery deadline.')
  return new Promise(resolve => {
    let settled = false
    const finish = (snapshot: MicrophoneSnapshot) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve(snapshot) }
    const abort = () => finish(result('cancelled', 'Microphone discovery was cancelled.'))
    const timer = setTimeout(() => finish(result('timeout', 'Microphone discovery timed out. Your selected input is unchanged; refresh again when the audio devices are ready.')), timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    const failed = (error: unknown) => {
      const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
      finish(result(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : 'failed', 'Microphone devices could not be listed. Check microphone access in system settings and refresh. Your selected input is unchanged.'))
    }
    try {
      Promise.resolve(enumerate()).then(value => {
        if (settled) return
        try {
          const inventory = normalizeMicrophoneDevices(value)
          finish({ ...inventory, status: 'ready', message: inventory.labelsRestricted ? 'Some device names are hidden by microphone permissions. Discovery does not request access; refresh after permission is granted during capture.' : inventory.devices.length ? 'Microphone list refreshed. Choose an input and save your settings for the next capture.' : 'No selectable microphones were returned. The device may be disconnected or access may be restricted. Your selected input is unchanged.' })
        } catch (error) { failed(error) }
      }, failed)
    } catch (error) { failed(error) }
  })
}
