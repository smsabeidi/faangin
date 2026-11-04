import type { AudioChannel, PlatformId } from '../shared/types'

function named(error: unknown): string { return error && typeof error === 'object' && 'name' in error ? String(error.name) : '' }

/** Output changes and newly added inputs do not revoke a healthy, selected input. */
export function microphoneMissing(deviceId: string | undefined, devices: Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]): boolean {
  return !!deviceId && deviceId !== 'default' && deviceId !== 'communications' && !devices.some(device => device.kind === 'audioinput' && device.deviceId === deviceId)
}

/** What Chromium reports for the OS default playback device; its label and group follow the device the OS currently routes to. */
export interface OutputIdentity { label: string; groupId: string }
type OutputDevice = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label' | 'groupId'>

export function defaultOutput(devices: OutputDevice[]): OutputIdentity | null {
  const device = devices.find(device => device.kind === 'audiooutput' && device.deviceId === 'default')
  return device ? { label: device.label, groupId: device.groupId } : null
}

/**
 * Windows opens the loopback stream against the default render endpoint at acquisition and never
 * migrates it, so a new default output (a headset plugged in mid-call) leaves it capturing silence.
 * A vanished default is left to the track's own `ended` event, which already triggers the restart.
 */
export function defaultOutputChanged(before: OutputIdentity | null, devices: OutputDevice[]): boolean {
  const after = defaultOutput(devices)
  return !!before && !!after && (before.label !== after.label || before.groupId !== after.groupId)
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

/** Windows has no screen-recording consent: a missing loopback track means no default playback device, not a permission. */
export function audioTrackMissing(channel: AudioChannel, platform: PlatformId): string {
  if (channel === 'microphone') return 'No microphone audio track was provided. Connect a microphone, then reconnect audio.'
  return platform === 'win32'
    ? 'No computer audio was provided. Set a default playback device in Windows Sound settings, then reconnect audio.'
    : 'No system audio track was provided. Allow screen and system audio recording in system settings, then reconnect audio.'
}

export function audioCaptureError(channel: AudioChannel, error: unknown, platform: PlatformId): string {
  const source = channel === 'system' ? 'System audio' : 'Microphone'
  switch (named(error)) {
    case 'NotAllowedError': case 'PermissionDeniedError':
      // On Windows only Faangin's own display-media handler can decline a loopback request; there is no privacy page to send the user to.
      if (channel === 'system' && platform === 'win32') return 'Computer audio could not be started. Choose Stop listening, then Start listening again. If it keeps failing, check the default playback device in Windows Sound settings.'
      return `${source} access was blocked. Choose Stop listening if it is still active. Check ${channel === 'system' ? 'screen and system audio' : 'microphone'} access in system settings. If access is already allowed, fully quit and reopen Faangin. Then choose Start listening.`
    case 'NotFoundError': case 'DevicesNotFoundError': return `${source} is unavailable. Connect an audio device, then reconnect audio.`
    case 'NotReadableError': case 'TrackStartError':
      if (channel === 'microphone' && platform === 'win32') return 'Microphone could not start. Check that the device is connected and available, and that microphone access for desktop apps is on in Windows privacy settings, then reconnect audio.'
      return `${source} could not start. Check that the device is connected and available, then reconnect audio.`
    case 'OverconstrainedError': return 'The selected microphone is unavailable. Choose Default microphone in Settings, then reconnect audio.'
    case 'AbortError': return `${source} capture was interrupted. Reconnect audio to try again.`
    default: return error instanceof Error ? error.message : `${source} capture failed. Reconnect audio to try again.`
  }
}
