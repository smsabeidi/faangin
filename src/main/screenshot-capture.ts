export interface ScreenshotWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  getMediaSourceId(): string
  hide(): void
  showInactive(): void
  on(event: 'show', listener: () => void): unknown
  removeListener(event: 'show', listener: () => void): unknown
}

export interface ScreenshotSource<Image> {
  id: string
  name: string
  display_id: string
  thumbnail: Image
}

export interface ScreenshotDisplay {
  id: string
  width: number
  height: number
  scaleFactor: number
}

interface ScreenshotPorts<Image> {
  windows(): readonly ScreenshotWindow[]
  watchWindows(listener: (window: ScreenshotWindow) => void): () => void
  displays(): readonly ScreenshotDisplay[]
  sources(size: { width: number; height: number }): Promise<readonly ScreenshotSource<Image>[]>
  quitting(): boolean
  /** A user's explicit Hide during acquisition overrides temporary restoration. */
  mayRestore?(window: ScreenshotWindow): boolean
  settle?: () => Promise<void>
  timeoutMs?: number
  deadline?: (expire: () => void, milliseconds: number) => () => void
}

export interface CapturedScreenshot<Image> {
  source: ScreenshotSource<Image>
  /** Display scale is known only for a verified display source, not a window. */
  display?: ScreenshotDisplay
}

function ownedSourceId(window: ScreenshotWindow): string | undefined {
  if (window.isDestroyed()) return undefined
  try {
    const id = window.getMediaSourceId()
    if (window.isDestroyed()) return undefined
    if (!id.startsWith('window:')) throw new Error('Unverifiable window source')
    return id
  } catch {
    if (window.isDestroyed()) return undefined
    throw new Error('Faangin window ownership could not be verified. Try the screenshot again.')
  }
}

/** Resolve the requested source exactly; never silently switch to another display. */
export function resolveScreenshotSource<Image>(
  sources: readonly ScreenshotSource<Image>[], requestedId: string | undefined, primaryDisplayId: string,
  ownedIds: ReadonlySet<string>, before: readonly ScreenshotDisplay[], after: readonly ScreenshotDisplay[]
): CapturedScreenshot<Image> {
  if (requestedId && ownedIds.has(requestedId)) throw new Error('Faangin windows cannot be selected as screenshot sources.')
  const candidates = requestedId ? sources.filter(source => source.id === requestedId)
    : sources.filter(source => source.id.startsWith('screen:') && source.display_id === primaryDisplayId)
  if (candidates.length !== 1) throw new Error('The selected display or window is unavailable. Choose a capture source in Settings.')
  const source = candidates[0]
  if (ownedIds.has(source.id)) throw new Error('Faangin windows cannot be selected as screenshot sources.')
  if (source.id.startsWith('window:')) return { source }
  if (!source.id.startsWith('screen:') || !source.display_id) throw new Error('The selected display cannot be verified. Choose a capture source in Settings.')
  const previous = before.find(display => display.id === source.display_id), current = after.find(display => display.id === source.display_id)
  if (!previous || !current) throw new Error('The selected display was disconnected during capture. Choose a current display in Settings.')
  if (previous.width !== current.width || previous.height !== current.height || previous.scaleFactor !== current.scaleFactor) {
    throw new Error('The selected display changed during capture. Choose it again in Settings.')
  }
  return { source, display: { ...current } }
}

class WindowExclusion {
  readonly ownedIds = new Set<string>()
  private readonly windows = new Map<ScreenshotWindow, { restore: boolean; onShow: () => void }>()
  private unwatch: (() => void) | undefined
  private failure: Error | undefined
  private changed = false
  private open = false

  constructor(private readonly ports: Pick<ScreenshotPorts<unknown>, 'windows' | 'watchWindows' | 'quitting' | 'mayRestore'>) {}

  start(): void {
    this.open = true
    this.unwatch = this.ports.watchWindows(window => {
      this.changed = true
      try { this.include(window, false) } catch { this.failure = new Error('A Faangin window could not be excluded from the screenshot.') }
    })
    for (const window of this.ports.windows()) this.include(window, true)
    this.assertExcluded()
  }

  private include(window: ScreenshotWindow, initial: boolean): void {
    if (!this.open || this.windows.has(window) || window.isDestroyed()) return
    const restore = initial && window.isVisible(), id = ownedSourceId(window)
    if (!id) return
    this.ownedIds.add(id)
    const onShow = () => {
      // A show request may race the native snapshot. Discard that snapshot even
      // when hiding again succeeds, rather than persist a possibly stale frame.
      this.changed = true
      try { if (!window.isDestroyed()) window.hide() } catch { this.failure = new Error('A Faangin window could not be excluded from the screenshot.') }
    }
    this.windows.set(window, { restore, onShow })
    window.on('show', onShow)
    if (!window.isDestroyed() && window.isVisible()) window.hide()
    if (!window.isDestroyed() && window.isVisible()) throw new Error('A Faangin window could not be excluded from the screenshot.')
  }

  assertExcluded(): void {
    if (this.failure) throw this.failure
    if (this.changed) throw new Error('Faangin windows changed during capture. Try the screenshot again.')
    for (const window of this.windows.keys()) {
      if (!window.isDestroyed() && window.isVisible()) throw new Error('A Faangin window could not be excluded from the screenshot.')
    }
  }

  restore(): void {
    this.open = false
    let failed = false
    try { this.unwatch?.() } catch { failed = true }
    for (const [window, { onShow }] of this.windows) {
      try { window.removeListener('show', onShow) } catch { if (!window.isDestroyed()) failed = true }
    }
    for (const [window, { restore }] of this.windows) {
      if (this.ports.quitting()) break
      try { if (restore && !window.isDestroyed() && !window.isVisible() && (this.ports.mayRestore?.(window) ?? true)) window.showInactive() } catch { if (!window.isDestroyed()) failed = true }
    }
    if (failed) throw new Error('Some Faangin windows could not be restored after capture. Reopen them from the app menu.')
  }
}

/** One native acquisition at a time, including a timed-out uncancellable call. */
export class ScreenshotCapture<Image> {
  private phase: 'idle' | 'active' | 'draining' = 'idle'
  private operation = 0
  private readonly requests = new Map<string, Set<AbortController>>()
  private readonly timeoutMs: number
  private readonly idleWaiters = new Set<() => void>()

  constructor(private readonly ports: ScreenshotPorts<Image>) {
    this.timeoutMs = ports.timeoutMs ?? 8000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Screen capture needs a finite positive deadline.')
  }

  /** Wait for the previous acquisition or uncancellable native drain without retrying it. */
  whenIdle(): Promise<void> {
    if (this.ports.quitting()) return Promise.reject(new Error('Faangin is closing. The screenshot was not saved.'))
    if (this.phase === 'idle') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const release = () => {
        clearTimeout(timer)
        this.idleWaiters.delete(release)
        if (this.ports.quitting()) reject(new Error('Faangin is closing. The screenshot was not saved.'))
        else resolve()
      }
      const timer = setTimeout(() => {
        this.idleWaiters.delete(release)
        reject(new Error('The previous screenshot is still finishing. Try Capture & solve again when the system capture service responds.'))
      }, this.timeoutMs)
      this.idleWaiters.add(release)
    })
  }

  private finishIdle(): void {
    this.phase = 'idle'
    for (const release of [...this.idleWaiters]) release()
  }

  invalidate(sessionId: string): void {
    for (const request of this.requests.get(sessionId) ?? []) request.abort(new Error('This session changed during capture. The screenshot was not saved.'))
  }

  async capture(request: { sessionId: string; sourceId?: string; primaryDisplayId: string; assertCurrent(): void }): Promise<CapturedScreenshot<Image>> {
    const abort = new AbortController(), pending = this.requests.get(request.sessionId) ?? new Set<AbortController>()
    pending.add(abort); this.requests.set(request.sessionId, pending)
    try {
      const before = this.ports.displays().map(display => ({ ...display })), exclusion = new WindowExclusion(this.ports)
      const captured = await this.run(async read => {
        request.assertCurrent()
        // Reject an owned source before hiding anything or asking the OS to capture.
        if (request.sourceId && this.ports.windows().some(window => ownedSourceId(window) === request.sourceId)) {
          throw new Error('Faangin windows cannot be selected as screenshot sources.')
        }
        exclusion.start()
        await (this.ports.settle?.() ?? new Promise<void>(resolve => setTimeout(resolve, 120)))
        request.assertCurrent(); exclusion.assertExcluded()
        const sources = await read({ width: 2560, height: 1600 })
        request.assertCurrent(); exclusion.assertExcluded()
        return resolveScreenshotSource(sources, request.sourceId, request.primaryDisplayId, exclusion.ownedIds, before, this.ports.displays())
      }, () => exclusion.restore(), abort.signal)
      request.assertCurrent()
      if (abort.signal.aborted) throw abort.signal.reason
      if (this.ports.quitting()) throw new Error('Faangin is closing. The screenshot was not saved.')
      return captured
    } finally {
      pending.delete(abort)
      if (!pending.size) this.requests.delete(request.sessionId)
    }
  }

  async listSources(): Promise<ScreenshotSource<Image>[]> {
    const ownedIds = new Set<string>()
    const remember = (window: ScreenshotWindow) => { const id = ownedSourceId(window); if (id) ownedIds.add(id) }
    let unwatch: (() => void) | undefined, changedError = false
    return this.run(async read => {
      for (const window of this.ports.windows()) remember(window)
      unwatch = this.ports.watchWindows(window => { try { remember(window) } catch { changedError = true } })
      const sources = await read({ width: 240, height: 150 })
      for (const window of this.ports.windows()) remember(window)
      if (changedError) throw new Error('Faangin windows changed while listing capture sources. Try again.')
      return sources.filter(source => !ownedIds.has(source.id))
    }, () => unwatch?.())
  }

  private async run<Result>(
    work: (read: (size: { width: number; height: number }) => Promise<readonly ScreenshotSource<Image>[]>) => Promise<Result>,
    cleanup: () => void,
    signal?: AbortSignal
  ): Promise<Result> {
    if (this.phase !== 'idle') throw new Error(this.phase === 'draining' ? 'The system capture service is still finishing the previous request. Try again when it responds.' : 'A screenshot request is already in progress. Try again when it finishes.')
    if (this.ports.quitting()) throw new Error('Faangin is closing. The screenshot was not saved.')
    this.phase = 'active'
    const operation = ++this.operation
    let finished = false, nativeSettled = true, nativeWork: Promise<readonly ScreenshotSource<Image>[]> | undefined
    let cancelDeadline: (() => void) | undefined
    const assertActive = () => {
      if (signal?.aborted) throw signal.reason
      if (finished) throw new Error('Screen capture timed out. Try again after the system capture service responds.')
      if (this.ports.quitting()) throw new Error('Faangin is closing. The screenshot was not saved.')
    }
    const read = (size: { width: number; height: number }) => {
      assertActive()
      nativeWork = this.ports.sources(size); nativeSettled = false
      void nativeWork.then(() => { nativeSettled = true }, () => { nativeSettled = true })
      return nativeWork
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      const expire = () => { finished = true; reject(new Error('Screen capture timed out. Try again after the system capture service responds.')) }
      cancelDeadline = this.ports.deadline ? this.ports.deadline(expire, this.timeoutMs) : (() => {
        const timer = setTimeout(expire, this.timeoutMs)
        return () => clearTimeout(timer)
      })()
    })
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (!signal) return
      onAbort = () => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([Promise.resolve().then(() => { assertActive(); return work(read) }), deadline, cancelled])
      assertActive()
      return result
    } finally {
      finished = true; cancelDeadline?.()
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      try { cleanup() } finally {
        if (nativeWork && !nativeSettled) {
          this.phase = 'draining'
          const release = () => { if (this.operation === operation) this.finishIdle() }
          void nativeWork.then(release, release)
        } else this.finishIdle()
      }
    }
  }
}
