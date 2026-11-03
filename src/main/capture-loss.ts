import type { AudioChannel } from '../shared/types'
import type { DesktopPlatform } from './platform'

/** The status the renderer pipeline reports when a track ends or its context closes. */
export const AUDIO_DEVICE_DISCONNECTED = 'Audio device disconnected.'

export interface SourceLossEffects {
  /** The lost source revokes the verified computer-audio access receipt, so setup must be run again. */
  clearVerification: boolean
  /** A surviving source should restart both transports, so the lost one reopens on the device that replaced it. */
  reconnectSurvivors: boolean
}

/**
 * What a source that stopped during a session means for the session. Where screen consent gates computer audio (macOS)
 * a stopped source is a revoked consent. Elsewhere (the Windows loopback) it is an endpoint change: a headset unplugged or
 * a Bluetooth profile switch ends the stream while nothing was revoked, and a restart on the new default device repairs it.
 */
export function sourceLossEffects(platform: Pick<DesktopPlatform, 'screenAccessGatesSystemAudio'>, channel: AudioChannel, status: string): SourceLossEffects {
  const gated = platform.screenAccessGatesSystemAudio
  return {
    clearVerification: channel === 'system' && gated,
    reconnectSurvivors: status === AUDIO_DEVICE_DISCONNECTED && (channel === 'microphone' || (channel === 'system' && !gated))
  }
}
