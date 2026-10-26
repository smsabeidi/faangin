import type { TranscriptTurn } from '../shared/types'

export interface LiveReplyCandidate {
  turn: TranscriptTurn
  generation: number
  epoch: number
}

export interface LiveReplyInterruption {
  type: 'interview-interruption'
  reason: 'new-speech' | 'new-question'
  transcriptId?: string
}

export interface LiveReplyState {
  phase: 'off' | 'listening' | 'waiting' | 'generating' | 'paused'
  reason?: string
}

export interface LiveReplyClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LiveReplyHooks {
  allowed(candidate: LiveReplyCandidate): boolean
  busy(): boolean
  run(candidate: LiveReplyCandidate, signal: AbortSignal): Promise<void>
  onState(state: LiveReplyState): void
}

export interface LiveReplyLimits {
  coalesceMs: number
  minIntervalMs: number
  maxPerWindow: number
  windowMs: number
  busyPollMs: number
}

export const LIVE_REPLY_LIMITS: Readonly<LiveReplyLimits> = {
  coalesceMs: 120, minIntervalMs: 800, maxPerWindow: 20, windowMs: 60_000, busyPollMs: 80,
}

const defaultClock: LiveReplyClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface ActiveReply { revision: number; abort: AbortController; candidate: LiveReplyCandidate }

const identity = (candidate: LiveReplyCandidate): string => JSON.stringify([candidate.turn.sessionId, candidate.generation, candidate.epoch, candidate.turn.channel, candidate.turn.id])
const textIdentity = (candidate: LiveReplyCandidate): string => candidate.turn.text.trim().replace(/\s+/g, ' ').toLowerCase()
const hasText = (candidate: LiveReplyCandidate): boolean => /[\p{L}\p{N}]/u.test(candidate.turn.text)
const freezeCandidate = (candidate: LiveReplyCandidate): LiveReplyCandidate => ({ ...candidate, turn: { ...candidate.turn } })
const sameScope = (a: LiveReplyCandidate, b: LiveReplyCandidate): boolean => a.turn.sessionId === b.turn.sessionId && a.turn.channel === b.turn.channel && a.generation === b.generation && a.epoch === b.epoch

/** One main-process owner schedules finalized speech; renderer windows only display its events. */
export class LiveReplyCoordinator {
  private readonly hooks: LiveReplyHooks
  private readonly clock: LiveReplyClock
  private readonly limits: LiveReplyLimits
  private state: LiveReplyState = { phase: 'off' }
  private enabled = false
  private paused = false
  private revision = 0
  private timerRevision = 0
  private timer: unknown | null = null
  private pending: LiveReplyCandidate | null = null
  private readyAt = 0
  private latestTargetAt: number | null = null
  private scope: LiveReplyCandidate | null = null
  private settling = false
  private settlingTarget: LiveReplyCandidate | null = null
  private active: ActiveReply | null = null
  private readonly seen = new Set<string>()
  private starts: number[] = []
  private lastStart: number | null = null
  private readonly reconsideredContext = new Set<string>()

  constructor(options: { hooks: LiveReplyHooks; clock?: LiveReplyClock; limits?: Partial<LiveReplyLimits> }) {
    this.hooks = options.hooks
    this.clock = options.clock ?? defaultClock
    this.limits = { ...LIVE_REPLY_LIMITS, ...options.limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (name === 'coalesceMs' || name === 'minIntervalMs' ? 0 : 1)) throw new Error('Live suggestion limits must use valid whole milliseconds and a positive request count.')
    }
  }

  snapshot(): LiveReplyState { return { ...this.state } }

  /** Call only with an admitted final; allowed() remains the authoritative source/lifecycle gate. */
  offer(candidate: LiveReplyCandidate): void {
    if (!this.enabled || this.paused || !this.valid(candidate) || !this.allowed(candidate)) return
    if (this.scope && !sameScope(this.scope, candidate)) return
    const key = identity(candidate)
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 2_048) this.seen.delete(this.seen.values().next().value!)
    this.scope ??= freezeCandidate(candidate)
    const meaningful = hasText(candidate)
    const older = this.latestTargetAt !== null && candidate.turn.timestamp < this.latestTargetAt
    // An old provider segment must not release a newer, still-provisional question.
    const settlesSpeech = this.settling && (!this.settlingTarget || (!older && (identity(this.settlingTarget) === key || (meaningful && candidate.turn.timestamp >= this.settlingTarget.turn.timestamp))))
    if (settlesSpeech) { this.settling = false; this.settlingTarget = null }
    let replaced = false
    if (meaningful && !older) {
      const duplicateText = this.duplicateText(candidate)
      this.latestTargetAt = candidate.turn.timestamp
      if (!duplicateText) { this.pending = freezeCandidate(candidate); replaced = true }
    }
    if (!replaced && !settlesSpeech) return
    this.readyAt = this.clock.now() + this.limits.coalesceMs
    if (replaced) this.interrupt(candidate, 'new-question')
    this.schedule()
  }

  /** Partial identity is required to interrupt a transport; no-argument calls only hold queued work. */
  defer(candidate?: LiveReplyCandidate): void {
    if (!this.enabled || this.paused) return
    if (candidate) {
      if (!this.valid(candidate, true) || !hasText(candidate)) return
      // Reuse the final admission gate for source/lifecycle ownership, never for dispatching partials.
      const admitted = { ...candidate, turn: { ...candidate.turn, provisional: false } }
      if (!this.allowed(admitted) || (this.scope && !sameScope(this.scope, candidate)) || this.seen.has(identity(candidate)) ||
        (this.latestTargetAt !== null && candidate.turn.timestamp < this.latestTargetAt) ||
        (this.settlingTarget && candidate.turn.timestamp < this.settlingTarget.turn.timestamp) ||
        this.duplicateText(candidate)) return
      this.scope ??= freezeCandidate(candidate)
      this.settlingTarget = freezeCandidate(candidate)
    }
    this.settling = true
    this.clearTimer()
    if (candidate) this.interrupt(candidate, 'new-speech')
    this.reflectState()
  }

  /** A finalized other-source observation arrived before any answer was shown.
   * Reassess the same question with the fresh conversation, bounded by the same
   * spacing and rolling request limits. Callers must never use this for an
   * already-visible answer or provisional candidate speech.
   */
  contextChanged(observation: LiveReplyCandidate): void {
    const active = this.active
    if (!this.enabled || this.paused || !active || active.abort.signal.aborted || !this.valid(observation) || !hasText(observation) ||
      observation.turn.sessionId !== active.candidate.turn.sessionId || observation.generation !== active.candidate.generation ||
      observation.epoch !== active.candidate.epoch || observation.turn.channel === active.candidate.turn.channel || !this.allowed(active.candidate)) return
    const key = identity(observation)
    if (this.reconsideredContext.has(key)) return
    this.reconsideredContext.add(key)
    if (this.reconsideredContext.size > 2_048) this.reconsideredContext.delete(this.reconsideredContext.values().next().value!)
    this.pending = freezeCandidate(active.candidate)
    this.readyAt = this.clock.now() + this.limits.coalesceMs
    active.abort.abort({ type: 'interview-interruption', reason: 'new-speech', transcriptId: observation.turn.id } satisfies LiveReplyInterruption)
    this.schedule()
  }

  private duplicateText(candidate: LiveReplyCandidate): boolean {
    const active = this.active && !this.active.abort.signal.aborted ? this.active.candidate : null
    return [active, this.pending].some(target => target && sameScope(target, candidate) && textIdentity(target) === textIdentity(candidate))
  }

  private interrupt(candidate: LiveReplyCandidate, reason: LiveReplyInterruption['reason']): void {
    const active = this.active
    if (!active || active.revision !== this.revision || active.abort.signal.aborted || !sameScope(active.candidate, candidate) ||
      identity(active.candidate) === identity(candidate) || candidate.turn.timestamp < active.candidate.turn.timestamp ||
      textIdentity(active.candidate) === textIdentity(candidate)) return
    const interruption: LiveReplyInterruption = { type: 'interview-interruption', reason, transcriptId: candidate.turn.id }
    active.abort.abort(interruption)
  }

  /** Abort only coordinator-owned work. The owner resumes explicitly after a lifecycle/manual change. */
  reset(reason?: string): void {
    this.invalidate()
    this.enabled = false
    this.paused = false
    this.publish({ phase: 'off', ...(reason ? { reason } : {}) })
  }

  /** No-op for an already active coordinator; failures require an explicit resume. */
  resume(): void {
    if (this.enabled && !this.paused) return
    this.invalidate()
    this.enabled = true
    this.paused = false
    this.publish({ phase: 'listening' })
  }

  private valid(candidate: LiveReplyCandidate, provisional = false): boolean {
    return !!candidate?.turn && typeof candidate.turn.id === 'string' && !!candidate.turn.id &&
      typeof candidate.turn.sessionId === 'string' && !!candidate.turn.sessionId &&
      typeof candidate.turn.text === 'string' && (provisional || !candidate.turn.provisional) &&
      Number.isSafeInteger(candidate.turn.timestamp) && candidate.turn.timestamp >= 0 &&
      (candidate.turn.channel === 'system' || candidate.turn.channel === 'microphone') &&
      Number.isSafeInteger(candidate.generation) && candidate.generation > 0 &&
      Number.isSafeInteger(candidate.epoch) && candidate.epoch >= 0
  }

  private allowed(candidate: LiveReplyCandidate): boolean {
    try { return this.hooks.allowed(candidate) } catch { return false }
  }

  private invalidate(): void {
    this.revision++
    this.clearTimer()
    this.pending = null
    this.reconsideredContext.clear()
    this.latestTargetAt = null
    this.scope = null
    this.settling = false
    this.settlingTarget = null
    this.seen.clear()
    // Retain ownership until an aborted transport settles; re-enable cannot overlap it.
    this.active?.abort.abort()
    // Rate history survives resets/re-enabling so cancellation cannot bypass the cost limits.
  }

  private clearTimer(): void {
    this.timerRevision++
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private publish(next: LiveReplyState): void {
    if (this.state.phase === next.phase && this.state.reason === next.reason) return
    this.state = { ...next }
    this.hooks.onState(this.snapshot())
  }

  private reflectState(): void {
    if (!this.enabled || this.paused) return
    if (this.active && !this.active.abort.signal.aborted) this.publish({ phase: 'generating' })
    else if (this.settling) this.publish({ phase: 'waiting', reason: 'Waiting for speech to finish.' })
    else if (this.pending) this.publish({ phase: 'waiting', ...(this.active ? { reason: 'Updating for the latest question.' } : {}) })
    else if (this.active) this.publish({ phase: 'waiting', reason: 'Stopping the previous suggestion.' })
    else this.publish({ phase: 'listening' })
  }

  private schedule(): void {
    this.clearTimer()
    if (!this.enabled || this.paused) return
    if (!this.pending || this.settling || this.active) { this.reflectState(); return }
    const now = this.clock.now()
    this.starts = this.starts.filter(start => start > now - this.limits.windowMs)
    const spacingAt = this.lastStart === null ? now : this.lastStart + this.limits.minIntervalMs
    const limitAt = this.starts.length >= this.limits.maxPerWindow ? this.starts[0] + this.limits.windowMs : now
    const earliest = Math.max(this.readyAt, spacingAt, limitAt)
    this.publish({ phase: 'waiting', ...(limitAt > now ? { reason: 'Waiting for live suggestion request limit.' } : spacingAt > now ? { reason: 'Waiting between live suggestions.' } : {}) })
    const revision = this.revision, timerRevision = this.timerRevision
    this.timer = this.clock.setTimeout(() => {
      if (revision !== this.revision || timerRevision !== this.timerRevision) return
      this.timer = null
      this.dispatch()
    }, Math.max(0, earliest - now))
  }

  private dispatch(): void {
    if (!this.enabled || this.paused || this.settling || this.active || !this.pending) return
    const candidate = this.pending
    if (!this.allowed(candidate)) { this.pending = null; this.schedule(); return }
    if (this.hooks.busy()) {
      const revision = this.revision, timerRevision = this.timerRevision
      this.timer = this.clock.setTimeout(() => {
        if (revision !== this.revision || timerRevision !== this.timerRevision) return
        this.timer = null
        this.schedule()
      }, this.limits.busyPollMs)
      return
    }
    this.pending = null
    const now = this.clock.now()
    this.lastStart = now
    this.starts.push(now)
    const active: ActiveReply = { revision: this.revision, abort: new AbortController(), candidate }
    this.active = active
    this.publish({ phase: 'generating' })
    // A lifecycle change may be requested synchronously while the state is published.
    if (active.revision !== this.revision || active.abort.signal.aborted) { this.active = null; this.schedule(); return }
    try {
      Promise.resolve(this.hooks.run(candidate, active.abort.signal)).then(
        () => this.finish(active, false),
        () => this.finish(active, true),
      )
    } catch { this.finish(active, true) }
  }

  private finish(active: ActiveReply, failed: boolean): void {
    if (this.active !== active) return
    this.active = null
    if (active.revision !== this.revision || active.abort.signal.aborted) { this.schedule(); return }
    if (failed) {
      this.paused = true
      this.pending = null
      this.clearTimer()
      this.publish({ phase: 'paused', reason: 'The last automatic reply failed. Choose Resume automatic help to try again.' })
      return
    }
    this.schedule()
  }
}
