export interface OverlayWindowPort {
  isDestroyed(): boolean
  isFocused(): boolean
  setIgnoreMouseEvents(ignore: boolean): void
  setFocusable(focusable: boolean): void
  blur(): void
  showInactive(): void
  show(): void
  focus(): void
  hide(): void
}

/** Native interaction and user visibility intent survive background updates and window recreation. */
export class OverlayInteractionPolicy {
  private window: OverlayWindowPort | null = null
  private passiveMode = false
  private visible = false
  private revision = 0

  get passive(): boolean { return this.passiveMode }
  get desiredVisible(): boolean { return this.visible }
  checkpoint(): number { return this.revision }

  attach(window: OverlayWindowPort): void { this.window = window; this.applyMode() }

  setPassive(value: boolean): void {
    this.revision++
    this.passiveMode = value
    this.applyMode()
  }

  private current(): OverlayWindowPort | null { return this.window && !this.window.isDestroyed() ? this.window : null }
  private applyMode(): void {
    const window = this.current()
    if (!window) return
    // Forwarded mouse moves let Chromium hover/cursors affect the underlying app.
    window.setIgnoreMouseEvents(this.passiveMode)
    window.setFocusable(!this.passiveMode)
    // Electron explicitly does not relinquish existing focus on macOS here.
    if (this.passiveMode && window.isFocused()) window.blur()
  }

  showOutput(expectedRevision?: number): boolean {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) return false
    const window = this.current()
    if (!window) return false
    this.applyMode()
    this.visible = true
    window.showInactive()
    return true
  }

  showInteractive(): boolean {
    this.setPassive(false)
    const window = this.current()
    if (!window) return false
    this.visible = true
    window.show()
    window.focus()
    return true
  }

  hide(): void {
    this.revision++
    this.visible = false
    this.current()?.hide()
  }

  toggleVisibility(): void {
    if (this.visible) this.hide()
    else { this.revision++; this.showOutput() }
  }
}

interface DockClock { now(): number; schedule(callback: () => void, delay: number): () => void }
interface MacDockPorts {
  platform: string
  setActivationPolicy(policy: 'regular' | 'accessory'): void
  hide(): void
  show(): Promise<void>
  onError(error: unknown): void
  clock?: DockClock
}

/** Standard accessory-app behavior; the status menu remains the recovery path. */
export class MacDockPolicy {
  private hidden: boolean | null = null
  private revision = 0
  private disposed = false
  private lastHide: number | null = null
  private cancelHide: (() => void) | undefined
  private readonly clock: DockClock

  constructor(private readonly ports: MacDockPorts) {
    this.clock = ports.clock ?? {
      now: () => performance.now(),
      schedule: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return () => clearTimeout(timer) }
    }
  }

  apply(hidden: boolean): void {
    if (this.disposed || this.ports.platform !== 'darwin' || this.hidden === hidden) return
    this.hidden = hidden
    const revision = ++this.revision
    this.cancelHide?.(); this.cancelHide = undefined
    try {
      this.ports.setActivationPolicy(hidden ? 'accessory' : 'regular')
      if (hidden) this.hideDock()
      else {
        void this.ports.show().then(() => {
          // A delayed show may complete after a newer Hide preference.
          if (!this.disposed && this.hidden && revision !== this.revision) {
            try { this.ports.setActivationPolicy('accessory'); this.hideDock() } catch (error) { this.ports.onError(error) }
          }
        }, error => { if (!this.disposed && revision === this.revision) this.ports.onError(error) })
      }
    } catch (error) { this.ports.onError(error) }
  }

  private hideDock(): void {
    this.cancelHide?.(); this.cancelHide = undefined
    // Electron documents that repeated dock.hide calls inside one second can be ignored.
    const remaining = this.lastHide === null ? 0 : 1100 - (this.clock.now() - this.lastHide)
    if (remaining > 0) {
      this.cancelHide = this.clock.schedule(() => {
        this.cancelHide = undefined
        if (!this.disposed && this.hidden) { try { this.hideDock() } catch (error) { this.ports.onError(error) } }
      }, remaining)
    } else { this.ports.hide(); this.lastHide = this.clock.now() }
  }

  dispose(): void { this.disposed = true; this.cancelHide?.(); this.cancelHide = undefined }
}
