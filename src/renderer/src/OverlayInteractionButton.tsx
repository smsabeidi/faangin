import { Monitor } from 'lucide-react'
import { overlayInteractionDescription } from './overlay-interaction'

export default function OverlayInteractionButton({ enabled, busy, recovery, onChange }: { enabled: boolean; busy: boolean; recovery: string; onChange: (enabled: boolean) => Promise<unknown> }) {
  return <button className="overlay-interaction-toggle" aria-pressed={enabled} disabled={busy} title={overlayInteractionDescription(enabled, recovery)} onClick={() => { void onChange(!enabled) }}><Monitor size={11}/>{enabled ? 'Click-through on' : 'Enable click-through'}</button>
}
