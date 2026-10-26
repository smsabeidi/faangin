import type { ScreenshotDisplay } from './screenshot-capture'

export interface ScreenshotRegion { x: number; y: number; width: number; height: number }
interface ImageSize { width: number; height: number }
interface Point { x: number; y: number }

export function validateScreenshotRegion(value: unknown, image: ImageSize): ScreenshotRegion {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Choose a rectangle inside the screenshot.')
  const region = value as Record<string, unknown>, keys = ['x', 'y', 'width', 'height']
  if (Object.keys(region).length !== 4 || Object.keys(region).some(key => !keys.includes(key)) || keys.some(key => !Number.isSafeInteger(region[key]))) throw new Error('Region coordinates must be whole screenshot pixels.')
  const result = region as unknown as ScreenshotRegion
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0 || result.x < 0 || result.y < 0 || result.width <= 0 || result.height <= 0 || result.x + result.width > image.width || result.y + result.height > image.height) throw new Error('Choose a nonempty rectangle inside the screenshot.')
  return { x: result.x, y: result.y, width: result.width, height: result.height }
}

/** Convert CSS pointer positions on the actual rendered image to its pixel grid. */
export function screenshotRegionFromDrag(start: Point, end: Point, rendered: ScreenshotRegion, image: ImageSize, currentRendered: ScreenshotRegion = rendered): ScreenshotRegion | null {
  if (['x', 'y', 'width', 'height'].some(key => rendered[key as keyof ScreenshotRegion] !== currentRendered[key as keyof ScreenshotRegion])) return null
  if (![start.x, start.y, end.x, end.y, rendered.x, rendered.y, rendered.width, rendered.height, image.width, image.height].every(Number.isFinite) || rendered.width <= 0 || rendered.height <= 0 || image.width <= 0 || image.height <= 0) return null
  const pixel = (point: Point) => ({ x: Math.min(image.width, Math.max(0, (point.x - rendered.x) * image.width / rendered.width)), y: Math.min(image.height, Math.max(0, (point.y - rendered.y) * image.height / rendered.height)) })
  const a = pixel(start), b = pixel(end)
  if (a.x === b.x || a.y === b.y) return null
  const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y))
  return validateScreenshotRegion({ x, y, width: Math.ceil(Math.max(a.x, b.x)) - x, height: Math.ceil(Math.max(a.y, b.y)) - y }, image)
}

export interface RegionFrame<Image> extends ImageSize {
  image: Image
  sessionId: string
  ownerId: string
  epoch: number
  name: string
  display?: ScreenshotDisplay
}
interface Lease<Image> extends RegionFrame<Image> { id: string; expiresAt: number; cancelExpiry(): void }

/** Preview pixels are separate from attachments and never enter provider context. */
export class ScreenshotRegionStore<Image> {
  private readonly leases = new Map<string, Lease<Image>>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxPreviews: number
  private readonly schedule: (expire: () => void, milliseconds: number) => () => void

  constructor(options: { now?: () => number; ttlMs?: number; maxPreviews?: number; schedule?: (expire: () => void, milliseconds: number) => () => void } = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 120_000; this.maxPreviews = options.maxPreviews ?? 2
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || !Number.isSafeInteger(this.maxPreviews) || this.maxPreviews <= 0) throw new Error('Region previews need bounded lifetime and capacity.')
    this.schedule = options.schedule ?? ((expire, milliseconds) => { const timer = setTimeout(expire, milliseconds); timer.unref(); return () => clearTimeout(timer) })
  }

  canCreate(ownerId: string): void {
    this.sweep()
    if ([...this.leases.values()].filter(lease => lease.ownerId !== ownerId).length >= this.maxPreviews) throw new Error('Close another region preview before capturing a new one.')
  }

  create(id: string, frame: RegionFrame<Image>): { id: string; expiresAt: number } {
    this.canCreate(frame.ownerId)
    if (this.leases.has(id)) throw new Error('Region preview ID collision.')
    validateScreenshotRegion({ x: 0, y: 0, width: frame.width, height: frame.height }, frame)
    for (const previous of [...this.leases.values()]) if (previous.ownerId === frame.ownerId) this.remove(previous.id)
    const expiresAt = this.now() + this.ttlMs, lease: Lease<Image> = { ...frame, ...(frame.display ? { display: { ...frame.display } } : {}), id, expiresAt, cancelExpiry: () => {} }
    this.leases.set(id, lease)
    lease.cancelExpiry = this.schedule(() => { if (this.leases.get(id) === lease) this.remove(id) }, this.ttlMs)
    return { id, expiresAt }
  }

  commit<Result>(id: string, sessionId: string, ownerId: string, epoch: number, displays: readonly ScreenshotDisplay[], region: unknown, attach: (frame: RegionFrame<Image>, rectangle: ScreenshotRegion) => Result): Result {
    this.sweep()
    const lease = this.leases.get(id)
    if (!lease) throw new Error('This region preview expired or was discarded. Capture a new preview.')
    if (lease.sessionId !== sessionId || lease.ownerId !== ownerId) throw new Error('This region preview belongs to a different window or session.')
    if (lease.epoch !== epoch) { this.remove(id); throw new Error('This session changed. Capture a new region preview.') }
    if (lease.display) {
      const current = displays.find(display => display.id === lease.display!.id)
      if (!current || current.width !== lease.display.width || current.height !== lease.display.height || current.scaleFactor !== lease.display.scaleFactor) { this.remove(id); throw new Error('The display changed or disconnected. Capture a new region preview.') }
    }
    const rectangle = validateScreenshotRegion(region, lease)
    // An attachment capacity/encoding failure leaves the preview available for a
    // smaller selection. Only a successful, synchronous commit consumes it.
    const result = attach(lease, rectangle)
    this.remove(id)
    return result
  }

  discard(id: string, ownerId: string): void {
    const lease = this.leases.get(id)
    if (lease && lease.ownerId !== ownerId) throw new Error('This region preview belongs to a different window.')
    this.remove(id)
  }

  clearSession(sessionId: string): void { for (const lease of [...this.leases.values()]) if (lease.sessionId === sessionId) this.remove(lease.id) }
  clearOwner(ownerId: string): void { for (const lease of [...this.leases.values()]) if (lease.ownerId === ownerId) this.remove(lease.id) }
  clear(): void { for (const id of [...this.leases.keys()]) this.remove(id) }
  private sweep(): void { for (const lease of [...this.leases.values()]) if (lease.expiresAt <= this.now()) this.remove(lease.id) }
  private remove(id: string): void { const lease = this.leases.get(id); if (lease) { this.leases.delete(id); lease.cancelExpiry() } }
}
