import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface WindowDisplay { id: number | string; workArea: WindowBounds }
export interface SavedWindowState { version: 1; bounds: WindowBounds; displayId: string; workArea: WindowBounds }
export interface WindowLayout {
  defaultBounds: WindowBounds; minWidth: number; minHeight: number
  /** Optional surface-specific policy; workspace windows retain their ordinary sizing. */
  boundsPolicy?: (bounds: WindowBounds, area: WindowBounds) => WindowBounds
  sizeLimits?: (area: WindowBounds) => { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number }
}
export interface WindowStateStore { read(key: string): unknown; write(key: string, state: SavedWindowState): void }
export interface ManagedWindow {
  isDestroyed(): boolean
  isMaximized(): boolean
  isMinimized(): boolean
  isFullScreen?(): boolean
  getBounds(): WindowBounds
  setBounds(bounds: WindowBounds): void
  setMinimumSize?(width: number, height: number): void
  setMaximumSize?(width: number, height: number): void
  on(event: 'move' | 'resize' | 'restore' | 'closed', callback: () => void): unknown
  removeListener(event: 'move' | 'resize' | 'restore' | 'closed', callback: () => void): unknown
}
export interface DisplaySource {
  getAllDisplays(): WindowDisplay[]
  getPrimaryDisplay(): WindowDisplay
  on(event: 'display-added' | 'display-removed' | 'display-metrics-changed', callback: () => void): unknown
  removeListener(event: 'display-added' | 'display-removed' | 'display-metrics-changed', callback: () => void): unknown
}

function rectangle(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as WindowBounds
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(number => Number.isFinite(number) && Math.abs(number) <= 10_000_000) && bounds.width > 0 && bounds.height > 0
}
function savedState(value: unknown): value is SavedWindowState {
  if (!value || typeof value !== 'object') return false
  const state = value as SavedWindowState
  return state.version === 1 && typeof state.displayId === 'string' && rectangle(state.bounds) && rectangle(state.workArea)
}
function overlap(a: WindowBounds, b: WindowBounds): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}
function distance(a: WindowBounds, b: WindowBounds): number {
  return (a.x + a.width / 2 - b.x - b.width / 2) ** 2 + (a.y + a.height / 2 - b.y - b.height / 2) ** 2
}
function displaysOrFallback(displays: WindowDisplay[], fallback: WindowDisplay): WindowDisplay[] {
  const valid = displays.filter(display => rectangle(display.workArea))
  if (valid.length) return valid
  if (rectangle(fallback.workArea)) return [fallback]
  throw new Error('No usable desktop work area is available.')
}
export function displayForBounds(bounds: WindowBounds, displays: WindowDisplay[], primary: WindowDisplay): WindowDisplay {
  const available = displaysOrFallback(displays, primary)
  return available.reduce((chosen, display) => {
    const nextOverlap = overlap(bounds, display.workArea), chosenOverlap = overlap(bounds, chosen.workArea)
    return nextOverlap > chosenOverlap || (nextOverlap === chosenOverlap && distance(bounds, display.workArea) < distance(bounds, chosen.workArea)) ? display : chosen
  }, available.find(display => String(display.id) === String(primary.id)) ?? available[0])
}
export function reachableWindowBounds(bounds: WindowBounds, area: WindowBounds, minWidth = 1, minHeight = 1): WindowBounds {
  if (!rectangle(bounds) || !rectangle(area)) throw new Error('Window geometry must be finite and have positive dimensions.')
  if (![minWidth, minHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Window minimum dimensions must be positive.')
  const width = Math.min(area.width, Math.max(minWidth, bounds.width))
  const height = Math.min(area.height, Math.max(minHeight, bounds.height))
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
    width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height))
  }
}
export function restoreWindowBounds(saved: unknown, displays: WindowDisplay[], primary: WindowDisplay, layout: WindowLayout): WindowBounds {
  const available = displaysOrFallback(displays, primary)
  if (!savedState(saved)) {
    const display = available.find(display => String(display.id) === String(primary.id)) ?? available[0]
    return layout.boundsPolicy?.(layout.defaultBounds, display.workArea) ?? reachableWindowBounds(layout.defaultBounds, display.workArea, layout.minWidth, layout.minHeight)
  }
  const sameDisplay = available.find(display => String(display.id) === saved.displayId)
  const display = sameDisplay ?? displayForBounds(saved.bounds, available, primary)
  // Coordinate changes can move the entire display; retain the window's local offset.
  const bounds = sameDisplay ? { ...saved.bounds, x: display.workArea.x + saved.bounds.x - saved.workArea.x, y: display.workArea.y + saved.bounds.y - saved.workArea.y } : saved.bounds
  return layout.boundsPolicy?.(bounds, display.workArea) ?? reachableWindowBounds(bounds, display.workArea, layout.minWidth, layout.minHeight)
}
export function snapshotWindowState(bounds: WindowBounds, displays: WindowDisplay[], primary: WindowDisplay): SavedWindowState {
  if (!rectangle(bounds)) throw new Error('Cannot save invalid window geometry.')
  const display = displayForBounds(bounds, displays, primary)
  return { version: 1, bounds: { ...bounds }, displayId: String(display.id), workArea: { ...display.workArea } }
}

/** Saves only geometry, outside transcript/settings storage. A malformed file falls back to defaults. */
export function jsonWindowStateStore(path: string): WindowStateStore {
  let values: Record<string, unknown> = {}
  try {
    const input: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (input && typeof input === 'object' && !Array.isArray(input)) values = { ...input }
  } catch { /* Corrupt or absent geometry must not prevent the app from starting. */ }
  return {
    read: key => values[key],
    write: (key, value) => {
      const next = { ...values, [key]: value }, temporary = `${path}.${process.pid}.tmp`
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
        renameSync(temporary, path)
        values = next
      } catch (error) {
        try { unlinkSync(temporary) } catch {}
        throw error
      }
    }
  }
}

export class WindowStateManager {
  private entries = new Map<string, { window: ManagedWindow; layout: WindowLayout; pending?: SavedWindowState; timer?: ReturnType<typeof setTimeout>; changed: () => void; restored: () => void; closed: () => void }>()
  private topologyChanged = () => { for (const key of this.entries.keys()) this.reflow(key) }
  constructor(private displays: DisplaySource, private store: WindowStateStore, private onError: (error: unknown) => void = () => {}, private debounceMs = 200) {
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) displays.on(event, this.topologyChanged)
  }
  restore(key: string, layout: WindowLayout): WindowBounds {
    return restoreWindowBounds(this.store.read(key), this.displays.getAllDisplays(), this.displays.getPrimaryDisplay(), layout)
  }
  attach(key: string, window: ManagedWindow, layout: WindowLayout): () => void {
    this.detach(key)
    const changed = () => {
      const entry = this.entries.get(key)
      if (!entry) return
      this.remember(key)
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => { entry.timer = undefined; this.save(key) }, this.debounceMs)
      entry.timer.unref?.()
    }
    const restored = () => this.reflow(key), closed = () => this.detach(key, window)
    this.entries.set(key, { window, layout, changed, restored, closed })
    this.remember(key)
    window.on('move', changed); window.on('resize', changed); window.on('restore', restored); window.on('closed', closed)
    return () => this.detach(key, window)
  }
  private remember(key: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.window.isDestroyed() || entry.window.isMaximized() || entry.window.isMinimized() || entry.window.isFullScreen?.()) return
    try { entry.pending = snapshotWindowState(entry.window.getBounds(), this.displays.getAllDisplays(), this.displays.getPrimaryDisplay()) } catch (error) { this.onError(error) }
  }
  save(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.remember(key)
    if (entry.pending) try { this.store.write(key, entry.pending) } catch (error) { this.onError(error) }
  }
  reflow(key: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.window.isDestroyed() || entry.window.isMaximized() || entry.window.isMinimized() || entry.window.isFullScreen?.()) return
    try {
      const bounds = entry.window.getBounds()
      const displays = this.displays.getAllDisplays(), primary = this.displays.getPrimaryDisplay()
      const next = restoreWindowBounds(entry.pending, displays, primary, { ...entry.layout, defaultBounds: bounds })
      const area = displayForBounds(next, displays, primary).workArea
      // Electron enforces the previous minimum even when setBounds requests a smaller reachable size.
      const limits = entry.layout.sizeLimits?.(area)
      if (limits) {
        // Lower the previous minimum before changing a collapsed window's maximum, and vice versa.
        entry.window.setMinimumSize?.(1, 1)
        entry.window.setMaximumSize?.(Math.floor(limits.maxWidth), Math.floor(limits.maxHeight))
      }
      entry.window.setMinimumSize?.(Math.max(1, Math.floor(limits?.minWidth ?? Math.min(entry.layout.minWidth, area.width))), Math.max(1, Math.floor(limits?.minHeight ?? Math.min(entry.layout.minHeight, area.height))))
      if (Object.keys(next).some(key => next[key as keyof WindowBounds] !== bounds[key as keyof WindowBounds])) entry.window.setBounds(next)
      this.save(key)
    } catch (error) { this.onError(error) }
  }
  private detach(key: string, expectedWindow?: ManagedWindow): void {
    const entry = this.entries.get(key)
    if (!entry || (expectedWindow && entry.window !== expectedWindow)) return
    if (entry.timer) clearTimeout(entry.timer)
    this.save(key)
    entry.window.removeListener('move', entry.changed); entry.window.removeListener('resize', entry.changed); entry.window.removeListener('restore', entry.restored); entry.window.removeListener('closed', entry.closed)
    this.entries.delete(key)
  }
  dispose(): void {
    for (const key of [...this.entries.keys()]) this.detach(key)
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) this.displays.removeListener(event, this.topologyChanged)
  }
}
