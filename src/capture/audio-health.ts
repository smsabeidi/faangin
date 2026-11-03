import type { AudioChannel, PlatformId } from '../shared/types'
import { SPEECH_START_LEVEL } from './vad'

export type AudioHealth = 'listening' | 'silent' | 'low-level' | 'no-frames'

export const AUDIO_HEALTH_MESSAGES: Record<AudioHealth, string> = {
  listening: 'Listening',
  silent: 'Silent — check the source if speech is playing.',
  'low-level': 'Low audio level — raise the source volume if speech is playing.',
  'no-frames': 'No audio frames — reconnect this source.'
}

/**
 * Windows loopback is the post-mix signal of the Default Device: it follows the master volume and mute,
 * and it is not the Default Communications Device that call apps route headsets to. Both produce a
 * silent pipeline that looks healthy, so the hint names the setting to change. A microphone pipeline
 * on Windows has none of this and keeps the shared copy.
 */
const WINDOWS_AUDIO_HEALTH_MESSAGES: Record<AudioHealth, string> = {
  ...AUDIO_HEALTH_MESSAGES,
  silent: 'Silent — Faangin hears the Windows Default Device. In Sound settings set your headset or speakers as Default Device (not only Default Communications Device), and unmute Windows volume.',
  'low-level': 'Low audio level — raise the Windows output volume; computer audio follows it.'
}

export function audioHealthMessages(platform: PlatformId, channel: AudioChannel): Readonly<Record<AudioHealth, string>> {
  return platform === 'win32' && channel === 'system' ? WINDOWS_AUDIO_HEALTH_MESSAGES : AUDIO_HEALTH_MESSAGES
}

/** Per-source diagnostics only. Energy is not evidence of recognized speech. */
export class AudioHealthTracker {
  private lastFrame: number
  private lastEnergy: number
  private lastAdequateLevel: number
  private adequateFrames = 0
  private heardEnergy = false

  constructor(startedAt: number) {
    if (!Number.isFinite(startedAt) || startedAt < 0) throw new Error('Invalid audio health start time.')
    this.lastFrame = this.lastEnergy = this.lastAdequateLevel = startedAt
  }

  push(level: number, at: number): boolean {
    if (!Number.isFinite(level) || level < 0 || level > 1 || !Number.isFinite(at) || at < this.lastFrame) return false
    this.lastFrame = at
    if (level > .003) { this.lastEnergy = at; this.heardEnergy = true }
    // Report the same onset level the VAD can actually admit as speech.
    this.adequateFrames = level >= SPEECH_START_LEVEL ? Math.min(3, this.adequateFrames + 1) : 0
    if (this.adequateFrames === 3) this.lastAdequateLevel = at
    return true
  }

  read(at: number): AudioHealth {
    if (!Number.isFinite(at) || at < this.lastFrame) throw new Error('Invalid audio health observation time.')
    if (at - this.lastFrame > 3_000) return 'no-frames'
    if (at - this.lastEnergy > 8_000) return 'silent'
    if (this.heardEnergy && at - this.lastAdequateLevel > 8_000) return 'low-level'
    return 'listening'
  }
}
