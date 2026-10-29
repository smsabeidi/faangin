import type { AudioChannel } from '../shared/types'

function named(error: unknown): string { return error && typeof error === 'object' && 'name' in error ? String(error.name) : '' }

/** Output changes and newly added inputs do not revoke a healthy, selected input. */
export function microphoneMissing(deviceId: string | undefined, devices: Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]): boolean {
  return !!deviceId && deviceId !== 'default' && deviceId !== 'communications' && !devices.some(device => device.kind === 'audioinput' && device.deviceId === deviceId)
}

/** A saved input can disappear when a headset is unplugged or browser device IDs rotate. */
export async function acquireMicrophone(media: Pick<MediaDevices, 'getUserMedia'>, deviceId: string, current: () => boolean, fallback: () => void): Promise<MediaStream> {
  const constraints = (selected: string): MediaStreamConstraints => ({ audio: { ...(selected ? { deviceId: { exact: selected } } : {}), channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false })
  try { return await media.getUserMedia(constraints(deviceId)) }
  catch (error) {
    const missing = named(error) === 'NotFoundError' || (named(error) === 'OverconstrainedError' && (!('constraint' in Object(error)) || (error as { constraint?: string }).constraint === 'deviceId'))
    if (!deviceId || !missing || !current()) throw error
    fallback()
    return media.getUserMedia(constraints(''))
  }
}

export function audioCaptureError(channel: AudioChannel, error: unknown): string {
  const source = channel === 'system' ? 'System audio' : 'Microphone'
  switch (named(error)) {
    case 'NotAllowedError': case 'PermissionDeniedError':
      return `${source} access was blocked. Choose Stop listening if it is still active. Check ${channel === 'system' ? 'screen and system audio' : 'microphone'} access in system settings. If access is already allowed, fully quit and reopen Faangin. Then choose Start listening.`
    case 'NotFoundError': case 'DevicesNotFoundError': return `${source} is unavailable. Connect an audio device, then reconnect audio.`
    case 'NotReadableError': case 'TrackStartError': return `${source} could not start. Check that the device is connected and available, then reconnect audio.`
    case 'OverconstrainedError': return 'The selected microphone is unavailable. Choose Default microphone in Settings, then reconnect audio.'
    case 'AbortError': return `${source} capture was interrupted. Reconnect audio to try again.`
    default: return error instanceof Error ? error.message : `${source} capture failed. Reconnect audio to try again.`
  }
}
