import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Contrast, Expand, RotateCcw, Square } from 'lucide-react'

type Size = { width: number; height: number }
type Drag = Size & { pointerId: number; screenX: number; screenY: number }
const resizeError = (value: unknown) => value instanceof Error ? value.message : 'The overlay could not be resized. Try Reset size & position from More.'

/** A visible native-window affordance: it never resizes only the renderer's CSS box. */
export default function OverlayResize({ onError }: { onError: (message: string) => void }) {
  const drag = useRef<Drag | null>(null)
  const pending = useRef<Size | null>(null)
  const sending = useRef(false)
  const inFlightSize = useRef<Size | null>(null)
  const scheduled = useRef<number | null>(null)
  const lastSent = useRef(0)
  const mounted = useRef(true)
  const reportError = useRef(onError)
  const flush = useRef<() => void>(() => {})
  const [resizing, setResizing] = useState(false)
  reportError.current = onError

  const schedule = useCallback((immediate = false) => {
    if (!mounted.current || sending.current || !pending.current) return
    if (scheduled.current !== null) {
      if (!immediate) return
      window.clearTimeout(scheduled.current)
      scheduled.current = null
    }
    if (immediate) flush.current()
    else scheduled.current = window.setTimeout(() => { scheduled.current = null; flush.current() }, Math.max(0, 40 - (performance.now() - lastSent.current)))
  }, [])
  flush.current = () => {
    if (!mounted.current || sending.current || !pending.current) return
    const size = pending.current
    pending.current = null
    sending.current = true
    inFlightSize.current = size
    lastSent.current = performance.now()
    void window.faangin.resizeOverlay(size).catch(error => {
      if (mounted.current) reportError.current(resizeError(error))
    }).finally(() => { sending.current = false; inFlightSize.current = null; schedule(!drag.current) })
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (scheduled.current !== null) window.clearTimeout(scheduled.current)
      pending.current = null
      document.documentElement.classList.remove('overlay-resizing')
    }
  }, [])

  const queue = (size: Size, immediate = false) => {
    pending.current = { width: Math.max(360, Math.min(720, Math.round(size.width))), height: Math.max(400, Math.min(840, Math.round(size.height))) }
    schedule(immediate)
  }
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    event.preventDefault()
    queue({ width: start.width + event.screenX - start.screenX, height: start.height + event.screenY - start.screenY })
  }
  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = drag.current
    if (!start || start.pointerId !== event.pointerId) return
    if (event.type === 'pointerup') queue({ width: start.width + event.screenX - start.screenX, height: start.height + event.screenY - start.screenY })
    drag.current = null
    setResizing(false)
    document.documentElement.classList.remove('overlay-resizing')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    schedule(true)
  }
  return <button type="button" className="overlay-resize-handle" aria-label="Resize overlay" title="Drag to resize · Arrow keys adjust size · Shift adjusts faster" aria-describedby="overlay-resize-help" data-resizing={resizing || undefined} onPointerDown={event => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { return }
    drag.current = { width: window.innerWidth, height: window.innerHeight, pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY }
    setResizing(true)
    document.documentElement.classList.add('overlay-resizing')
  }} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 64 : 16
    const current = pending.current ?? inFlightSize.current ?? { width: window.innerWidth, height: window.innerHeight }
    queue({ width: current.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), height: current.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }, true)
  }}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 13 13 5M9 13l4-4M12 13l1-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg><span id="overlay-resize-help" className="overlay-resize-help">Drag the lower-right corner to resize. Arrow keys adjust width or height. Hold Shift for larger changes. Size presets and Reset size & position are in More.</span></button>
}

export function OverlaySizeControls({ opacity, onError }: { opacity: number; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const command = async (task: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await task() } catch (error) { onError(resizeError(error)) }
    finally { setBusy(false) }
  }
  return <section className="overlay-menu-section overlay-sizing-controls"><h2>Size & appearance</h2><div className="overlay-size-presets"><button type="button" aria-label="Use compact overlay size" disabled={busy} onClick={() => { void command(() => window.faangin.resizeOverlay({ width: 480, height: 560 })) }}><Square size={15}/><span>Compact<small>480 × 560</small></span></button><button type="button" aria-label="Use comfortable overlay size" disabled={busy} onClick={() => { void command(() => window.faangin.resizeOverlay({ width: 600, height: 720 })) }}><Expand size={15}/><span>Comfortable<small>600 × 720</small></span></button></div><button type="button" className="overlay-menu-row" disabled={busy} onClick={() => { void command(() => window.faangin.resetOverlayLayout()) }}><RotateCcw size={15}/><span>Reset size & position</span></button><p className="overlay-menu-hint">Drag the lower-right corner to resize. Drag the logo to move.</p><button type="button" className="overlay-menu-row" aria-label="Use readable background at 94% opacity" disabled={busy} title="Use recommended appearance: set background opacity to 94%" onClick={() => { void command(async () => { await window.faangin.updateSettings({ opacity: .94 }) }) }}><Contrast size={15}/><span>Readable background</span>{Math.abs(opacity - .94) < .005 ? <Check size={14} aria-label="Selected"/> : <span>94%</span>}</button></section>
}
