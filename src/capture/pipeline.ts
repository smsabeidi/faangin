import type { AudioChannel } from '../shared/types'
import { AudioHealthTracker, AUDIO_HEALTH_MESSAGES, type AudioHealth } from './audio-health'
import { SOURCE_VAD_OPTIONS, VoiceActivity } from './vad'

interface PipelineOptions {
  stream: MediaStream
  context: AudioContext
  channel?: AudioChannel
  current(): boolean
  frame(pcm: ArrayBuffer): void
  commit(utteranceComplete: boolean): void
  level(level: number): void
  status(message: string, failed?: boolean): void
  now?: () => number
  watch?: (check: () => void) => () => void
}

/** Owns all native resources for one source; readiness means real PCM has arrived. */
export class AudioPipeline {
  private closed = false
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private gain: GainNode | null = null
  private cancelWatch: (() => void) | null = null
  private vad: VoiceActivity
  private health: AudioHealthTracker
  private now: () => number
  private startedAt: number
  private heardFrame = false
  private reportedHealth: AudioHealth = 'listening'
  private reportedMessage = 'Listening'
  private mutedTracks = new Set<MediaStreamTrack>()
  private lastLevel = -Infinity
  private resuming = false
  constructor(private options: PipelineOptions) {
    this.now = options.now ?? (() => performance.now())
    this.startedAt = this.now()
    this.health = new AudioHealthTracker(this.startedAt)
    this.vad = new VoiceActivity(options.frame, options.commit, SOURCE_VAD_OPTIONS[options.channel ?? 'microphone'])
  }
  inputDeviceId(): string | undefined { return this.closed ? undefined : this.options.stream.getAudioTracks()[0]?.getSettings().deviceId }
  private current(): boolean { return !this.closed && this.options.current() }
  private report(message: string): void {
    if (!this.current() || message === this.reportedMessage) return
    this.reportedMessage = message; this.options.status(message)
  }
  private fail(message: string): void {
    if (!this.current()) return
    this.stop()
    this.options.status(message, true)
  }
  private check = (): void => {
    if (!this.current()) return
    const at = this.now(), context = this.options.context
    if (context.state === 'closed') { this.fail('Audio device disconnected.'); return }
    // The OS can suspend an AudioContext during an output/headset change. Resume the existing
    // source before asking the user to repeat permissions or reconnect both transports.
    if (context.state !== 'running' && !this.resuming) {
      this.resuming = true
      void context.resume().catch(() => { this.fail('Audio could not resume. Reconnect this source.') }).finally(() => { this.resuming = false })
    }
    if (this.mutedTracks.size) { this.report('Audio source is muted — waiting for audio.'); return }
    if (!this.heardFrame) {
      if (at - this.startedAt > 8_000) this.fail(AUDIO_HEALTH_MESSAGES['no-frames'])
      return
    }
    const next = this.health.read(at)
    if (next === this.reportedHealth) return
    this.reportedHealth = next
    if (next === 'no-frames') this.fail(AUDIO_HEALTH_MESSAGES[next])
    else this.report(AUDIO_HEALTH_MESSAGES[next])
  }
  async start(workletUrl: string, createNode: (context: AudioContext) => AudioWorkletNode = context => new AudioWorkletNode(context, 'faangin-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })): Promise<void> {
    try {
      const { stream, context } = this.options
      await context.audioWorklet.addModule(workletUrl)
      if (!this.current()) { this.stop(); return }
      this.source = context.createMediaStreamSource(stream)
      this.node = createNode(context)
      this.node.onprocessorerror = () => this.fail('Audio processing stopped. Reconnect this source.')
      this.gain = context.createGain(); this.gain.gain.value = 0
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(context.destination)
      this.node.port.onmessage = event => {
        if (!this.current()) return
        const data = event.data as { pcm?: unknown; level?: unknown } | null
        if (!data || !(data.pcm instanceof ArrayBuffer) || data.pcm.byteLength !== 960 || typeof data.level !== 'number') return
        const at = this.now()
        if (!this.health.push(data.level, at)) return
        if (!this.heardFrame) { this.heardFrame = true; this.reportedMessage = 'Listening'; this.options.status('Listening') }
        this.check()
        if (!this.current()) return
        if (at - this.lastLevel >= 100) { this.lastLevel = at; this.options.level(this.mutedTracks.size ? 0 : Math.min(1, data.level * 5)) }
        if (!this.mutedTracks.size) this.vad.push(data.pcm, data.level)
      }
      for (const track of stream.getAudioTracks()) {
        if (track.muted) this.mutedTracks.add(track)
        track.onended = () => this.fail('Audio device disconnected.')
        track.onmute = () => {
          if (!this.current()) return
          this.mutedTracks.add(track); this.vad.stop(true)
          this.options.level(0)
          this.report('Audio source is muted — waiting for audio.')
        }
        track.onunmute = () => {
          if (!this.current()) return
          this.mutedTracks.delete(track)
          if (this.mutedTracks.size) return
          // Unmute precedes the resumed worklet frames. Give those frames a fresh
          // watchdog window instead of treating the intentional mute as a disconnect.
          this.startedAt = this.now(); this.health = new AudioHealthTracker(this.startedAt); this.reportedHealth = 'listening'
          if (this.heardFrame) this.report('Listening')
        }
      }
      this.startedAt = this.now()
      this.health = new AudioHealthTracker(this.startedAt)
      const watch = this.options.watch ?? (check => { const timer = setInterval(check, 1000); return () => clearInterval(timer) })
      this.cancelWatch = watch(this.check)
      await context.resume()
      if (!this.current()) this.stop()
    } catch (error) { this.stop(); throw error }
  }
  stop(): void {
    if (this.closed) return
    this.closed = true; this.cancelWatch?.(); this.cancelWatch = null; this.vad.stop(false)
    if (this.node) { this.node.port.onmessage = null; this.node.onprocessorerror = null; this.node.disconnect() }
    this.source?.disconnect(); this.gain?.disconnect()
    for (const track of this.options.stream.getTracks()) { track.onended = null; track.onmute = null; track.onunmute = null; track.stop() }
    this.mutedTracks.clear()
    void this.options.context.close().catch(() => {})
  }
}
