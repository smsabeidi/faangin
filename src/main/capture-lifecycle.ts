import { CapturePolicy, type CaptureDecision } from './capture-policy'

export interface CaptureLease {
  generation: number
  /** Starts prepared sources. Abort/dispose must fence any late asynchronous completion. */
  activate(signal: AbortSignal): void | Promise<void>
  /** Synchronous fence: no more frames or new speech commits may be dispatched afterward. */
  stopAccepting(): void
  /** Discards unsent audio and drains only requests admitted before stopAccepting. */
  dispose(): void | Promise<void>
}
export interface CaptureLifecyclePorts {
  /** Acquires an owned generation without sending frames before activate. */
  acquire(sessionId: string, signal: AbortSignal): Promise<CaptureLease>
  status(sessionId: string, status: 'starting' | 'recording' | 'paused' | 'ended'): void
  error?(error: unknown): void
}

/** Coordinates revocable capture intent, owned generations, and asynchronous source acquisition. */
export class CaptureLifecycle {
  private active: CaptureLease | null = null
  private flight: { decision: CaptureDecision; abort: AbortController; promise: Promise<void> } | null = null
  private drains = new Set<Promise<void>>()
  private disposal = new WeakMap<CaptureLease, Promise<void>>()
  constructor(readonly policy: CapturePolicy, private ports: CaptureLifecyclePorts) {}
  start(sessionId: string): Promise<void> {
    const state = this.policy.state()
    if (state.phase !== 'idle') {
      if (state.sessionId !== sessionId) return Promise.reject(new Error('Stop the current session before capturing another.'))
      if (state.phase === 'paused') return this.resume()
      if (state.asleep || state.phase === 'suspended') return Promise.reject(new Error('Audio capture cannot start while the computer is asleep.'))
      return this.flight && !this.flight.abort.signal.aborted ? this.flight.promise : Promise.resolve()
    }
    const decision = this.policy.prepare(sessionId)
    this.status(sessionId, 'starting')
    return this.resumeDecision(decision, true)
  }
  /** Ownership transfer after a successful explicit Start. The lease is already active. */
  adopt(sessionId: string, lease: CaptureLease, at?: number): void {
    if (this.active || (this.flight && !this.flight.abort.signal.aborted)) throw new Error('Stop existing capture before adopting another generation.')
    this.flight = null
    this.policy.begin(sessionId, lease.generation, at)
    this.active = lease
    this.status(sessionId, 'recording')
  }
  private report(error: unknown): void { try { this.ports.error?.(error) } catch {} }
  private status(sessionId: string, status: Parameters<CaptureLifecyclePorts['status']>[1]): void {
    try { this.ports.status(sessionId, status) } catch (error) { this.report(error) }
  }
  private release(lease: CaptureLease): Promise<void> {
    const existing = this.disposal.get(lease)
    if (existing) return existing
    // Both callbacks are invoked synchronously, before an await can admit another frame.
    let work: void | Promise<void>
    try { lease.stopAccepting() } catch (error) { this.report(error) }
    try { work = lease.dispose() } catch (error) { work = Promise.reject(error) }
    const result = Promise.resolve(work).catch(error => { this.report(error) })
    this.disposal.set(lease, result); this.drains.add(result)
    void result.then(() => this.drains.delete(result))
    return result
  }
  private cancelAcquisition(): void { this.flight?.abort.abort() }
  private deactivate(): void {
    const lease = this.active; this.active = null
    if (lease) void this.release(lease)
  }
  private async waitForDrains(): Promise<void> { await Promise.all([...this.drains]) }
  private pauseDecision(decision: CaptureDecision | null): Promise<void> {
    if (!decision) return this.waitForDrains()
    this.cancelAcquisition(); this.deactivate()
    this.status(decision.sessionId, 'paused')
    return this.waitForDrains()
  }
  pause(): Promise<void> { return this.pauseDecision(this.policy.pause()) }
  suspend(): Promise<void> { return this.pauseDecision(this.policy.suspend()) }
  resume(): Promise<void> { return this.resumeDecision(this.policy.resume()) }
  wake(): Promise<void> { return this.resumeDecision(this.policy.wake()) }
  deviceChanged(): Promise<void> {
    // A burst of device notifications shares one in-flight restart, rather than opening repeated permission requests.
    if (this.flight?.decision.reason === 'device-change' && !this.flight.abort.signal.aborted && this.policy.isCurrent(this.flight.decision)) return this.flight.promise
    return this.resumeDecision(this.policy.deviceChanged())
  }
  private resumeDecision(decision: CaptureDecision | null, initial = false): Promise<void> {
    if (!decision) return this.flight && !this.flight.abort.signal.aborted ? this.flight.promise : Promise.resolve()
    this.cancelAcquisition(); this.deactivate()
    const flight = { decision, abort: new AbortController(), promise: Promise.resolve() }
    this.flight = flight
    flight.promise = (async () => {
      let lease: CaptureLease | null = null
      try {
        await this.waitForDrains()
        if (flight.abort.signal.aborted || !this.policy.isCurrent(decision)) return
        this.status(decision.sessionId, 'starting')
        lease = await this.ports.acquire(decision.sessionId, flight.abort.signal)
        if (flight.abort.signal.aborted || !this.policy.isCurrent(decision)) { await this.release(lease); return }
        if (!Number.isSafeInteger(lease.generation) || lease.generation <= decision.generation) throw new Error('Reacquired capture must own a newer generation.')
        this.active = lease
        await lease.activate(flight.abort.signal)
        if (flight.abort.signal.aborted || !this.policy.resumed(decision, lease.generation)) {
          if (this.active === lease) this.active = null
          await this.release(lease); return
        }
        this.status(decision.sessionId, 'recording')
      } catch (error) {
        if (lease) { if (this.active === lease) this.active = null; await this.release(lease) }
        if (!flight.abort.signal.aborted && this.policy.resumeFailed(decision)) {
          if (initial) { this.policy.stop(); this.status(decision.sessionId, 'ended'); throw error }
          else { this.status(decision.sessionId, 'paused'); this.report(error) }
        }
      } finally { if (this.flight === flight) this.flight = null }
    })()
    return flight.promise
  }
  /** Always ends desired intent, even when hardware has already been paused or was never reacquired. */
  stop(): Promise<void> {
    const sessionId = this.policy.state().sessionId
    this.policy.stop(); this.cancelAcquisition(); this.deactivate()
    if (sessionId) this.status(sessionId, 'ended')
    return this.waitForDrains()
  }
  poll(at?: number): Promise<void> | null {
    return this.policy.poll(at) ? this.stop() : null
  }
  activity(generation: number, level: number, at?: number): boolean { return this.policy.activity(generation, level, at) }
}
