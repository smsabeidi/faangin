import type { Answer, Session } from '../../shared/types'

export interface AnswerStreamScheduler {
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
  setTimer: (callback: () => void, delayMs: number) => number
  clearTimer: (handle: number) => void
}

export interface AnswerStreamUpdate {
  sessionId: string
  contextEpoch: number
  answerId: string
  requestId: string
  text: string
  firstTokenMs?: number
}

interface StreamRecord {
  answer: Answer
  text: string
  firstTokenMs?: number
  published: boolean
  dirty: boolean
  cancelled: boolean
  terminal?: Answer
}

/** Keep token delivery independent of rendering without delaying the first text. */
export class AnswerStreamBatcher {
  private sessionId: string | null = null
  private contextEpoch: number | null = null
  private generation = 0
  private scheduleRevision = 0
  private frame: number | null = null
  private timer: number | null = null
  private disposed = false
  private readonly streams = new Map<string, StreamRecord>()

  constructor(
    private readonly scheduler: AnswerStreamScheduler,
    private readonly publish: (updates: AnswerStreamUpdate[], generation: number) => void,
    private readonly maxWaitMs = 32,
  ) {}

  isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation }

  /** State refreshes must retain text that has arrived but has not reached a frame. */
  reconcile(session: Session | null): Session | null {
    if (this.disposed) return session
    if (this.sessionId !== (session?.id ?? null) || this.contextEpoch !== (session?.contextEpoch ?? null)) {
      this.clearScheduled()
      this.streams.clear()
      this.generation++
      this.sessionId = session?.id ?? null
      this.contextEpoch = session?.contextEpoch ?? null
    }
    if (!session) return null
    const present = new Set(session.answers.map(answer => answer.requestId))
    // A request admission can precede an older in-flight getState response. Only
    // a session/context change retires it; a stale snapshot cannot remove it.
    const incoming = [...session.answers, ...[...this.streams.values()].filter(record => !present.has(record.answer.requestId)).map(record => record.answer)]
    const answers = incoming.map(answer => {
      const existing = this.streams.get(answer.requestId)
      if (existing?.answer.id === answer.id && existing.terminal) return existing.terminal
      if (answer.status !== 'streaming') {
        this.streams.set(answer.requestId, { answer, text: answer.text, firstTokenMs: answer.firstTokenMs, published: !!answer.text.trim(), dirty: false, cancelled: false, terminal: answer })
        return answer
      }
      const record: StreamRecord = existing?.answer.id === answer.id ? existing : { answer, text: '', published: false, dirty: false, cancelled: false }
      record.answer = answer
      if (answer.text.length > record.text.length) record.text = answer.text
      record.firstTokenMs ??= answer.firstTokenMs
      record.published = !!record.text.trim()
      record.dirty = false
      this.streams.set(answer.requestId, record)
      return { ...answer, text: record.text, firstTokenMs: record.firstTokenMs, ...(record.cancelled ? { status: 'cancelled' as const } : {}) }
    })
    // Every pending string is included in the reconciled snapshot above.
    this.clearScheduled()
    return { ...session, answers }
  }

  start(answer: Answer): Answer | null {
    if (this.disposed || answer.sessionId !== this.sessionId || answer.status !== 'streaming') return null
    const existing = this.streams.get(answer.requestId)
    if (existing?.answer.id === answer.id) {
      if (existing.terminal) return null
      return { ...answer, text: existing.text, firstTokenMs: existing.firstTokenMs, ...(existing.cancelled ? { status: 'cancelled' as const } : {}) }
    }
    this.streams.set(answer.requestId, { answer, text: answer.text, firstTokenMs: answer.firstTokenMs, published: !!answer.text.trim(), dirty: false, cancelled: false })
    return answer
  }

  delta(event: { sessionId: string; requestId: string; delta: string; firstTokenMs?: number }): void {
    if (this.disposed || event.sessionId !== this.sessionId || !event.delta) return
    const record = this.streams.get(event.requestId)
    if (!record || record.terminal || record.cancelled) return
    record.text += event.delta
    if (!record.published && !record.text.trim()) return
    record.firstTokenMs ??= event.firstTokenMs
    if (!record.published) {
      record.published = true
      this.publish([this.update(record)], this.generation)
    } else {
      record.dirty = true
      this.schedule()
    }
  }

  /** Canonical completion replaces the partial string, including failure/cancellation. */
  complete(answer: Answer): Answer | null {
    if (this.disposed || answer.sessionId !== this.sessionId || answer.status === 'streaming') return null
    const record = this.streams.get(answer.requestId)
    if (!record || record.answer.id !== answer.id || record.terminal) return null
    record.answer = answer
    record.text = answer.text
    record.firstTokenMs = answer.firstTokenMs
    record.dirty = false
    record.terminal = answer
    this.clearWhenIdle()
    return answer
  }

  /** Show every received character before suppressing further delivery. */
  cancel(requestId: string): Answer | null {
    if (this.disposed) return null
    const record = this.streams.get(requestId)
    if (!record || record.terminal || record.cancelled) return null
    record.cancelled = true
    record.dirty = false
    this.clearWhenIdle()
    return { ...record.answer, text: record.text, firstTokenMs: record.firstTokenMs, status: 'cancelled' }
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.clearScheduled()
    this.streams.clear()
  }

  private update(record: StreamRecord): AnswerStreamUpdate {
    return { sessionId: this.sessionId!, contextEpoch: this.contextEpoch!, answerId: record.answer.id, requestId: record.answer.requestId, text: record.text, firstTokenMs: record.firstTokenMs }
  }

  private schedule(): void {
    if (this.frame !== null || this.timer !== null) return
    const revision = ++this.scheduleRevision
    const generation = this.generation
    const flush = () => {
      if (!this.isCurrent(generation) || revision !== this.scheduleRevision) return
      this.clearScheduled()
      const updates: AnswerStreamUpdate[] = []
      for (const record of this.streams.values()) {
        if (record.dirty && !record.terminal && !record.cancelled) {
          record.dirty = false
          updates.push(this.update(record))
        }
      }
      if (updates.length) this.publish(updates, generation)
    }
    if (this.scheduler.requestFrame) this.frame = this.scheduler.requestFrame(flush)
    this.timer = this.scheduler.setTimer(flush, this.maxWaitMs)
  }

  private clearWhenIdle(): void {
    if (![...this.streams.values()].some(record => record.dirty && !record.terminal && !record.cancelled)) this.clearScheduled()
  }

  private clearScheduled(): void {
    this.scheduleRevision++
    if (this.frame !== null) this.scheduler.cancelFrame?.(this.frame)
    if (this.timer !== null) this.scheduler.clearTimer(this.timer)
    this.frame = null
    this.timer = null
  }
}
