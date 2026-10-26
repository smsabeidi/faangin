export type CapturePolicyPhase = 'idle' | 'starting' | 'running' | 'paused' | 'suspended' | 'resuming' | 'ending'
export type CapturePolicyReason = 'manual' | 'sleep' | 'idle' | 'device-change'
export interface CapturePolicyState { phase: CapturePolicyPhase; sessionId: string | null; generation: number | null; reason: CapturePolicyReason | null; asleep: boolean; lastActivityAt: number | null }
export interface CaptureDecision { type: 'pause' | 'resume' | 'end' | 'restart'; reason: CapturePolicyReason; sessionId: string; generation: number; revision: number }
export interface CapturePolicyOptions { idleTimeoutMs: number; activityThreshold?: number; now?: () => number }

/** Desired capture lifecycle only. The owner must fence/tear down OS sources before accepting pause, sleep, or Stop. */
export class CapturePolicy {
  private stateValue: CapturePolicyState = { phase: 'idle', sessionId: null, generation: null, reason: null, asleep: false, lastActivityAt: null }
  private revision = 0
  private idleTimeoutMs: number
  private threshold: number
  private now: () => number
  constructor(options: CapturePolicyOptions) {
    this.idleTimeoutMs = this.timeout(options.idleTimeoutMs)
    this.threshold = options.activityThreshold ?? .015
    if (!Number.isFinite(this.threshold) || this.threshold < 0 || this.threshold > 1) throw new Error('Audio activity threshold must be between zero and one.')
    this.now = options.now ?? (() => performance.now())
  }
  private timeout(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60 * 1000) throw new Error('Idle timeout must be between zero and 24 hours; zero disables it.')
    return value
  }
  private time(value: number): number { if (!Number.isFinite(value) || value < 0) throw new Error('Capture time must be finite and nonnegative.'); return value }
  state(): CapturePolicyState { return { ...this.stateValue } }
  configureIdleTimeout(value: number): void { this.idleTimeoutMs = this.timeout(value) }
  /** Generation zero tracks revocable user intent before the first OS acquisition owns a generation. */
  prepare(sessionId: string, at = this.now()): CaptureDecision {
    if (!sessionId) throw new Error('Capture requires a session.')
    this.time(at)
    if (this.stateValue.asleep) throw new Error('Audio capture cannot start while the computer is asleep.')
    if (this.stateValue.phase !== 'idle') throw new Error('Stop existing capture before starting another session.')
    this.revision++
    this.stateValue = { phase: 'starting', sessionId, generation: 0, reason: null, asleep: false, lastActivityAt: at }
    return this.decision('resume', 'manual')!
  }
  begin(sessionId: string, generation: number, at = this.now()): void {
    if (!sessionId || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Capture requires a session and positive generation.')
    this.time(at)
    if (this.stateValue.asleep) throw new Error('Audio capture cannot start while the computer is asleep.')
    if (this.stateValue.phase !== 'idle') throw new Error('Use a current resume decision before replacing an active capture policy.')
    this.revision++
    this.stateValue = { phase: 'running', sessionId, generation, reason: null, asleep: false, lastActivityAt: at }
  }
  /** Invalidates pending wake/device/resume work, including when capture hardware has already stopped. */
  stop(): void {
    this.revision++
    this.stateValue = { phase: 'idle', sessionId: null, generation: null, reason: null, asleep: this.stateValue.asleep, lastActivityAt: null }
  }
  activity(generation: number, level: number, at = this.now()): boolean {
    if (this.stateValue.phase !== 'running' || generation !== this.stateValue.generation || !Number.isFinite(level) || level <= this.threshold || level > 1) return false
    const time = this.time(at)
    this.stateValue.lastActivityAt = Math.max(this.stateValue.lastActivityAt ?? time, time)
    return true
  }
  private decision(type: CaptureDecision['type'], reason: CapturePolicyReason): CaptureDecision | null {
    const { sessionId, generation } = this.stateValue
    if (!sessionId || generation === null) return null
    return { type, reason, sessionId, generation, revision: this.revision }
  }
  pause(): CaptureDecision | null {
    if (this.stateValue.phase === 'idle' || this.stateValue.phase === 'ending' || (this.stateValue.phase === 'paused' && this.stateValue.reason === 'manual')) return null
    this.revision++
    this.stateValue.phase = 'paused'; this.stateValue.reason = 'manual'
    return this.decision('pause', 'manual')
  }
  resume(): CaptureDecision | null {
    if (this.stateValue.phase !== 'paused' || this.stateValue.asleep) return null
    this.revision++; this.stateValue.phase = 'resuming'
    return this.decision('resume', 'manual')
  }
  suspend(): CaptureDecision | null {
    if (this.stateValue.asleep) return null
    this.stateValue.asleep = true; this.revision++
    if (this.stateValue.phase === 'idle' || this.stateValue.phase === 'paused' || this.stateValue.phase === 'ending') return null
    this.stateValue.phase = 'suspended'; this.stateValue.reason = 'sleep'
    return this.decision('pause', 'sleep')
  }
  wake(): CaptureDecision | null {
    if (!this.stateValue.asleep) return null
    this.stateValue.asleep = false; this.revision++
    if (this.stateValue.phase !== 'suspended') return null
    this.stateValue.phase = 'resuming'
    return this.decision('resume', 'sleep')
  }
  deviceChanged(): CaptureDecision | null {
    if (this.stateValue.asleep || (this.stateValue.phase !== 'running' && this.stateValue.phase !== 'resuming' && this.stateValue.phase !== 'starting')) return null
    this.revision++; this.stateValue.phase = 'resuming'; this.stateValue.reason = 'device-change'
    return this.decision('restart', 'device-change')
  }
  isCurrent(decision: CaptureDecision): boolean {
    return decision.revision === this.revision && decision.sessionId === this.stateValue.sessionId && decision.generation === this.stateValue.generation && this.stateValue.phase !== 'idle'
  }
  /** Call after successful hardware reacquisition; late completion after Stop/another event is rejected. */
  resumed(decision: CaptureDecision, generation: number, at = this.now()): boolean {
    if (!this.isCurrent(decision) || this.stateValue.asleep || (this.stateValue.phase !== 'resuming' && this.stateValue.phase !== 'starting') || (decision.type !== 'resume' && decision.type !== 'restart')) return false
    if (!Number.isSafeInteger(generation) || generation <= decision.generation) throw new Error('Resumed capture requires a new generation.')
    const time = this.time(at)
    this.revision++; this.stateValue.phase = 'running'; this.stateValue.reason = null; this.stateValue.generation = generation; this.stateValue.lastActivityAt = time
    return true
  }
  /** Reacquisition failure remains paused and visible; it never loops or falls back to another provider. */
  resumeFailed(decision: CaptureDecision): boolean {
    if (!this.isCurrent(decision) || (this.stateValue.phase !== 'resuming' && this.stateValue.phase !== 'starting')) return false
    this.revision++; this.stateValue.phase = 'paused'; this.stateValue.reason = decision.reason
    return true
  }
  poll(at = this.now()): CaptureDecision | null {
    const time = this.time(at)
    if (this.stateValue.phase !== 'running' || !this.idleTimeoutMs || this.stateValue.lastActivityAt === null) return null
    if (time < this.stateValue.lastActivityAt) { this.stateValue.lastActivityAt = time; return null }
    if (time - this.stateValue.lastActivityAt < this.idleTimeoutMs) return null
    this.revision++
    const decision = this.decision('end', 'idle')
    // Keep the idle decision current until teardown finishes, but never admit another wake/restart.
    this.stateValue.phase = 'ending'; this.stateValue.reason = 'idle'
    return decision
  }
}
