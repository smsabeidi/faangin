import { SPEECH_START_LEVEL } from './vad'

export type AudioHealth = 'listening' | 'silent' | 'low-level' | 'no-frames'

export const AUDIO_HEALTH_MESSAGES: Record<AudioHealth, string> = {
  listening: 'Listening',
  silent: 'Silent — check the source if speech is playing.',
  'low-level': 'Low audio level — raise the source volume if speech is playing.',
  'no-frames': 'No audio frames — reconnect this source.'
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
