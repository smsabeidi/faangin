import type { GenerateInput, Settings } from '../shared/types'

export interface CaptureSolveSnapshot {
  sessionId: string
  epoch: number
  sourceId?: string
  smart: boolean
  connectionIdentity?: string
}
/** Public routing/capability settings only; credentials are never fingerprinted. */
export function captureSolveConnectionIdentity(settings: Settings): string {
  return JSON.stringify([settings.chatProvider, settings.fastModel, settings.smartModel, settings.smartMode, settings.compatibleChatEndpoint, settings.compatibleChatModel, settings.compatibleChatSmartModel, settings.compatibleChatVision])
}
export interface CaptureSolveState {
  sessionId: string
  phase: 'capturing' | 'solving'
  requestId?: string
}
interface CaptureSolvePorts {
  snapshot(sessionId: string): CaptureSolveSnapshot
  assertCurrent(snapshot: CaptureSolveSnapshot): void
  capture(snapshot: CaptureSolveSnapshot, assertCurrent: () => void): Promise<{ id: string; sessionId: string }>
  select(sessionId: string, imageId: string): void
  generate(input: GenerateInput): Promise<{ requestId: string }>
  finished(requestId: string): Promise<void>
  cancelCapture(sessionId: string): void
  changed(): void
}
interface CaptureSolveJob {
  snapshot: CaptureSolveSnapshot
  state: CaptureSolveState
  promise: Promise<{ requestId: string }>
  cancelled: boolean
}

/** One capture and one answer, shared by every window and the global shortcut. */
export class CaptureSolveCoordinator {
  private active: CaptureSolveJob | null = null
  constructor(private readonly ports: CaptureSolvePorts) {}

  state(): CaptureSolveState | null { return this.active ? { ...this.active.state } : null }
  preparing(): boolean { return this.active?.state.phase === 'capturing' }

  run(sessionId: string): Promise<{ requestId: string }> {
    if (this.active) {
      if (this.active.snapshot.sessionId === sessionId) return this.active.promise
      return Promise.reject(new Error('Capture & solve is already running in another session.'))
    }
    let snapshot: CaptureSolveSnapshot
    try { snapshot = this.ports.snapshot(sessionId); this.ports.assertCurrent(snapshot) }
    catch (error) { return Promise.reject(error) }
    const job: CaptureSolveJob = { snapshot, state: { sessionId, phase: 'capturing' }, cancelled: false, promise: undefined! }
    this.active = job
    // Reserve ownership before calling capture, including a second IPC arriving
    // before the first native acquisition or React state update has started.
    job.promise = Promise.resolve().then(() => this.prepare(job))
    this.ports.changed()
    return job.promise
  }

  cancel(sessionId?: string): void {
    const job = this.active
    if (!job || (sessionId && job.snapshot.sessionId !== sessionId)) return
    job.cancelled = true; this.active = null
    if (job.state.phase === 'capturing') this.ports.cancelCapture(job.snapshot.sessionId)
    this.ports.changed()
  }

  private assertCurrent(job: CaptureSolveJob): void {
    if (job.cancelled || this.active !== job) throw new Error('Capture & solve was cancelled. Capture again when you are ready.')
    this.ports.assertCurrent(job.snapshot)
  }
  private release(job: CaptureSolveJob): void {
    if (this.active === job) { this.active = null; this.ports.changed() }
  }
  private async prepare(job: CaptureSolveJob): Promise<{ requestId: string }> {
    try {
      this.assertCurrent(job)
      const image = await this.ports.capture(job.snapshot, () => this.assertCurrent(job))
      this.assertCurrent(job)
      if (!image.id || image.sessionId !== job.snapshot.sessionId) throw new Error('The captured image does not belong to the current session.')
      this.ports.select(job.snapshot.sessionId, image.id)
      this.assertCurrent(job)
      job.state.phase = 'solving'
      this.ports.changed()
      const result = await this.ports.generate({ sessionId: job.snapshot.sessionId, action: 'solve', attachmentIds: [image.id], smart: job.snapshot.smart })
      job.state.requestId = result.requestId
      if (this.active === job) this.ports.changed()
      // The IPC acknowledges dispatch; ownership lasts until this answer ends.
      // Repeated shortcut presses during streaming never queue another frame.
      void this.ports.finished(result.requestId).catch(() => {}).finally(() => this.release(job))
      return result
    } catch (error) { this.release(job); throw error }
  }
}

/** Only one-shot captures may be replaced to keep repeated questions one step. */
export class CaptureSolveImages {
  private readonly owned = new Map<string, Set<string>>()
  replacement(sessionId: string, images: ReadonlyArray<{ id: string; createdAt: number }>): string | undefined {
    if (images.length < 4) return undefined
    const owned = this.owned.get(sessionId)
    const oldest = images.filter(image => owned?.has(image.id)).sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!oldest) throw new Error('Four reference images are attached. Remove an image before using Capture & solve.')
    return oldest.id
  }
  committed(sessionId: string, imageId: string, replacedId?: string): void {
    const owned = this.owned.get(sessionId) ?? new Set<string>()
    if (replacedId) owned.delete(replacedId)
    owned.add(imageId); this.owned.set(sessionId, owned)
  }
  removed(sessionId: string, imageId: string): void { this.owned.get(sessionId)?.delete(imageId) }
  clear(sessionId: string): void { this.owned.delete(sessionId) }
}
