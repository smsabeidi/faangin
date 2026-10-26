import type { AudioChannel } from '../shared/types'

// Quiet headset and loopback speech often sits below the old .015 RMS gate.
// A lower onset plus release hysteresis keeps those words while still rejecting silence.
export const SPEECH_START_LEVEL = .006
export const SPEECH_END_LEVEL = .004
const FRAME_MS = 20

export interface VoiceActivityOptions { silenceMs?: number; maxSegmentMs?: number }

/** Endpoint quickly after a question while allowing slightly longer local thinking pauses. */
export const SOURCE_VAD_OPTIONS: Readonly<Record<AudioChannel, Readonly<Required<VoiceActivityOptions>>>> = {
  system: { silenceMs: 320, maxSegmentMs: 6_000 },
  microphone: { silenceMs: 400, maxSegmentMs: 6_000 },
}

/** Bounded client VAD. Sources retain separate transports and source labels. */
export class VoiceActivity {
  private preRoll: ArrayBuffer[] = []
  private speaking = false
  private voiced = 0
  private silence = 0
  private frames = 0
  private silenceFrames: number
  private maxFrames: number
  constructor(private write: (frame: ArrayBuffer) => void, private commit: () => void, options: VoiceActivityOptions = {}) {
    const silenceMs = options.silenceMs ?? 600, maxSegmentMs = options.maxSegmentMs ?? 15_000
    if (!Number.isSafeInteger(silenceMs) || silenceMs < 100 || silenceMs > 2_000 || silenceMs % FRAME_MS ||
      !Number.isSafeInteger(maxSegmentMs) || maxSegmentMs < 1_000 || maxSegmentMs > 15_000 || maxSegmentMs % FRAME_MS) throw new Error('Invalid voice activity timing limits.')
    this.silenceFrames = silenceMs / FRAME_MS; this.maxFrames = maxSegmentMs / FRAME_MS
  }
  push(frame: ArrayBuffer, level: number): void {
    if (!(frame instanceof ArrayBuffer) || !frame.byteLength || !Number.isFinite(level) || level < 0 || level > 1) return
    const speech = level >= (this.speaking ? SPEECH_END_LEVEL : SPEECH_START_LEVEL)
    if (!this.speaking) {
      this.preRoll.push(frame)
      if (this.preRoll.length > 10) this.preRoll.shift()
      this.voiced = speech ? this.voiced + 1 : 0
      if (this.voiced < 3) return
      this.speaking = true; this.frames = this.preRoll.length; this.silence = 0
      for (const f of this.preRoll) this.write(f)
      this.preRoll = []
      return
    }
    this.write(frame); this.frames++; this.silence = speech ? 0 : this.silence + 1
    if (this.silence >= this.silenceFrames) {
      this.commit(); this.speaking = false; this.frames = 0; this.voiced = 0; this.silence = 0
    } else if (this.frames >= this.maxFrames) {
      // This is a transport chunk, not a new utterance. Keep admission open so the
      // following phonemes are sent immediately, once, without a new onset gate.
      this.commit(); this.frames = 0
    }
  }
  stop(commit = false): void {
    if (commit && this.speaking && this.frames) this.commit()
    this.preRoll = []; this.speaking = false; this.frames = 0; this.voiced = 0; this.silence = 0
  }
}
