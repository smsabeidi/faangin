import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, LoaderCircle, Mic, Monitor, MoreHorizontal, Square } from 'lucide-react'
import type { AppState } from '../../shared/types'
import { shortcutLabel } from '../../main/shortcut-manager'
import { Brand, IconButton } from './components'

/** The badge describes a working binding, including user changes and registration failures. */
export function overlayCaptureShortcut(shortcuts: AppState['shortcuts'], platform: string): string | null {
  const binding = shortcuts.find(value => value.id === 'capture-solve' && value.registered)
  if (!binding) return null
  try { return shortcutLabel(binding.accelerator, platform as Parameters<typeof shortcutLabel>[1]) } catch { return null }
}

export default function OverlayHeader({ status, listening, passive, recovery, recoveryLabel = 'Menu bar', shortcut, collapsed, busy, capturing, working, captureOwned, captureAndSolve, collapse, stop, cancelAnswer, children }: {
  status: string; listening: boolean; passive: boolean; recovery: { shortcut: string | null; hint: string }; recoveryLabel?: string; shortcut: string | null
  collapsed: boolean; busy: boolean; capturing: boolean; working: boolean; captureOwned: boolean
  captureAndSolve: () => Promise<unknown>; collapse: () => Promise<unknown>; stop: () => Promise<unknown>; cancelAnswer?: () => Promise<unknown>; children: ReactNode
}) {
  const menu = useRef<HTMLDetailsElement>(null)
  const panelId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const close = (restoreFocus = false) => {
    if (!menu.current?.open) return
    menu.current.open = false
    setMenuOpen(false)
    if (restoreFocus) menu.current.querySelector<HTMLElement>('summary')?.focus()
  }
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); close(true) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [])
  useEffect(() => { if (passive || collapsed) close() }, [passive, collapsed])
  const openAudio = () => {
    if (!menu.current) return
    menu.current.open = true
    setMenuOpen(true)
    menu.current.querySelector<HTMLElement>('.overlay-listening-control button')?.focus()
  }
  const keyboardNavigation = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('button, summary, a[href]')) return
    const summary = menu.current?.querySelector('summary')
    if (event.target === summary && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      if (!menu.current) return
      menu.current.open = true
      setMenuOpen(true)
      const controls = [...menu.current.querySelectorAll<HTMLElement>('.overlay-more-panel button:not(:disabled), .overlay-more-panel a[href], .overlay-more-panel summary')].filter(control => control.getClientRects().length)
      ;(event.key === 'ArrowUp' ? controls.at(-1) : controls[0])?.focus()
      return
    }
    if (!menu.current?.open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const controls = [...menu.current.querySelectorAll<HTMLElement>('.overlay-more-panel button:not(:disabled), .overlay-more-panel a[href], .overlay-more-panel summary')].filter(control => control.getClientRects().length)
    if (!controls.length) return
    event.preventDefault()
    const current = controls.indexOf(event.target)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
    controls[next]?.focus()
  }
  return <header className="overlay-topbar">
    <div className="overlay-drag overlay-identity" title="Drag to move · Resize from the lower-right corner"><div className="overlay-brand-line"><Brand compact/><span className={`status-dot ${listening ? 'live' : ''}`} aria-hidden="true"/></div><span className="overlay-status" role="status" title={passive ? recovery.hint : status}>{passive ? `${recovery.shortcut || recoveryLabel} to interact` : status}</span></div>
    {cancelAnswer ? <button type="button" className="overlay-capture-button overlay-stop-answer" aria-label="Stop answer" title="Stop the current answer" onClick={() => { close(); void cancelAnswer() }}><Square size={14}/><span>Stop answer</span></button> : <button type="button" className="overlay-capture-button" aria-label="Capture & solve" disabled={busy || working} title={shortcut ? `Capture the selected screen and solve · ${shortcut}` : 'Capture the selected screen and solve. Set a shortcut in Settings → Capture & shortcuts.'} onClick={() => { close(); void captureAndSolve() }}>{capturing ? <LoaderCircle size={16} className="spin"/> : <Monitor size={16}/>}<span className="overlay-capture-label">{capturing ? 'Capturing…' : 'Capture'}<span className="overlay-capture-long">{capturing ? '' : ' & solve'}</span></span>{shortcut && <kbd>{shortcut}</kbd>}</button>}
    <button type="button" className={`icon-button overlay-listen-button${captureOwned ? ' overlay-listen-on' : ''}`} title={captureOwned ? 'Stop listening' : 'Set up hands-free listening'} aria-label={captureOwned ? 'Stop listening' : 'Set up hands-free listening'} aria-controls={!captureOwned ? panelId : undefined} aria-expanded={!captureOwned ? menuOpen : undefined} disabled={busy && !captureOwned} onClick={() => { if (captureOwned) void stop(); else openAudio() }}>{captureOwned ? <Square size={14}/> : <Mic size={16}/>}</button>
    <details className="overlay-more" ref={menu} onToggle={event => setMenuOpen(event.currentTarget.open)} onKeyDown={keyboardNavigation} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close() }}>
      <summary title="More controls · Size & position" aria-label="More overlay controls" aria-controls={panelId} aria-expanded={menuOpen}><MoreHorizontal size={18}/></summary>
      <div id={panelId} className="overlay-more-panel" role="group" aria-label="Overlay controls">{children}</div>
    </details>
    <IconButton label={collapsed ? 'Expand overlay' : 'Collapse overlay'} onClick={() => { close(); void collapse() }}>{collapsed ? <ChevronDown size={16}/> : <ChevronUp size={16}/>}</IconButton>
  </header>
}
