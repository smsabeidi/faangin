import type { AudioChannel } from '../shared/types'

/** Reject late acquisitions without consuming the next valid start generation. */
export class MediaGeneration {
  private latest = 0
  private active: number | null = null
  private disabled = new Set<AudioChannel>()
  begin(generation: number): boolean {
    if (generation <= this.latest) return false
    this.latest = generation; this.active = generation; this.disabled.clear(); return true
  }
  accepts(generation: number, channel?: AudioChannel): boolean { return this.active === generation && (!channel || !this.disabled.has(channel)) }
  stopChannel(generation: number, channel: AudioChannel): boolean { if (this.active !== generation) return false; this.disabled.add(channel); return true }
  stop(generation: number): boolean { if (this.active !== generation) return false; this.active = null; return true }
  invalidate(): void { this.active = null }
}
