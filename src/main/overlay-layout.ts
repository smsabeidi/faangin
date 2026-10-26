import { reachableWindowBounds, type WindowBounds } from './window-state'

export const OVERLAY_LAYOUT = { width: 480, height: 560, collapsedHeight: 54, minWidth: 360, minHeight: 400, maxWidth: 720, maxHeight: 840, inset: 16 } as const

export function overlayExpandedHeight(value: number): number {
  return Number.isFinite(value) && value >= OVERLAY_LAYOUT.minHeight && value <= OVERLAY_LAYOUT.maxHeight ? Math.round(value) : OVERLAY_LAYOUT.height
}

export function overlaySizeLimits(area: WindowBounds, collapsed: boolean) {
  const width = Math.max(1, area.width - Math.min(OVERLAY_LAYOUT.inset * 2, Math.max(0, area.width - 1)))
  const height = Math.max(1, area.height - Math.min(OVERLAY_LAYOUT.inset * 2, Math.max(0, area.height - 1)))
  return {
    minWidth: Math.min(OVERLAY_LAYOUT.minWidth, width), minHeight: Math.min(collapsed ? OVERLAY_LAYOUT.collapsedHeight : OVERLAY_LAYOUT.minHeight, height),
    maxWidth: Math.min(OVERLAY_LAYOUT.maxWidth, width), maxHeight: Math.min(collapsed ? OVERLAY_LAYOUT.collapsedHeight : OVERLAY_LAYOUT.maxHeight, height)
  }
}

export function defaultOverlayBounds(area: WindowBounds, collapsed = false, expandedHeight: number = OVERLAY_LAYOUT.height): WindowBounds {
  return constrainOverlayBounds({ x: area.x + area.width - OVERLAY_LAYOUT.width - 20, y: area.y + 60, width: OVERLAY_LAYOUT.width, height: collapsed ? OVERLAY_LAYOUT.collapsedHeight : overlayExpandedHeight(expandedHeight) }, area, collapsed, expandedHeight, false)
}

/** Recover stale fullscreen geometry, while retaining intentional compact resizes and display-local positions. */
export function constrainOverlayBounds(bounds: WindowBounds, area: WindowBounds, collapsed: boolean, preferredHeight: number = OVERLAY_LAYOUT.height, recoverOversized = true): WindowBounds {
  const fullscreen = bounds.width >= area.width - 2 && bounds.height >= area.height - 2
  const oversized = bounds.width > OVERLAY_LAYOUT.maxWidth || (!collapsed && bounds.height > OVERLAY_LAYOUT.maxHeight) || fullscreen
  if (recoverOversized && oversized) return defaultOverlayBounds(area, collapsed)
  const limits = overlaySizeLimits(area, collapsed)
  const horizontalInset = Math.min(OVERLAY_LAYOUT.inset, Math.max(0, (area.width - limits.maxWidth) / 2))
  const verticalInset = Math.min(OVERLAY_LAYOUT.inset, Math.max(0, (area.height - limits.maxHeight) / 2))
  const usable = { x: area.x + horizontalInset, y: area.y + verticalInset, width: area.width - horizontalInset * 2, height: area.height - verticalInset * 2 }
  const height = collapsed ? OVERLAY_LAYOUT.collapsedHeight : bounds.height <= OVERLAY_LAYOUT.collapsedHeight ? overlayExpandedHeight(preferredHeight) : bounds.height
  return reachableWindowBounds({ ...bounds, width: Math.min(limits.maxWidth, bounds.width), height: Math.min(limits.maxHeight, height) }, usable, limits.minWidth, limits.minHeight)
}
