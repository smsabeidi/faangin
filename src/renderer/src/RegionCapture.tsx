import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Crop, LoaderCircle } from 'lucide-react'
import type { Attachment, ScreenshotRegion, ScreenshotRegionPreview } from '../../shared/types'
import { screenshotRegionFromDrag, validateScreenshotRegion } from '../../main/screenshot-region'
import { Modal, Spinner } from './components'
import './RegionCapture.css'

export default function RegionCapture({ sessionId, sourceId, onClose, onAdded }: { sessionId: string; sourceId?: string; onClose: () => void; onAdded: (attachment: Attachment) => void }) {
  const [preview, setPreview] = useState<ScreenshotRegionPreview | null>(null)
  const [region, setRegion] = useState<ScreenshotRegion | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [imageReady, setImageReady] = useState(false)
  const [expired, setExpired] = useState(false), [attempt, setAttempt] = useState(0), mounted = useRef(true)
  const currentPreview = useRef<string | null>(null), image = useRef<HTMLImageElement>(null)
  const drag = useRef<{ pointerId: number; start: { x: number; y: number }; rendered: ScreenshotRegion } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let alive = true
    setLoading(true); setError(''); setPreview(null); setRegion(null); setImageReady(false); setExpired(false)
    void window.faangin.previewScreenshotRegion(sessionId, sourceId).then(value => {
      if (!alive) { void window.faangin.discardScreenshotRegion(value.id).catch(() => {}); return }
      currentPreview.current = value.id; setPreview(value)
    }).catch(value => { if (alive) setError(value instanceof Error ? value.message : 'The region preview failed.') }).finally(() => { if (alive) setLoading(false) })
    return () => {
      alive = false
      if (currentPreview.current) { void window.faangin.discardScreenshotRegion(currentPreview.current).catch(() => {}); currentPreview.current = null }
    }
  }, [sessionId, sourceId, attempt])
  useEffect(() => {
    if (!preview) return
    const timer = window.setTimeout(() => {
      if (!mounted.current) return
      setPreview(null); setRegion(null); setImageReady(false); setExpired(true); drag.current = null
      setError('This preview expired and its image was discarded. Capture again or close this dialog.')
      if (currentPreview.current === preview.id) currentPreview.current = null
      void window.faangin.discardScreenshotRegion(preview.id).catch(() => {})
    }, Math.max(0, preview.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [preview])

  const rect = () => { const value = image.current?.getBoundingClientRect(); return value ? { x: value.left, y: value.top, width: value.width, height: value.height } : null }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current, rendered = rect()
    if (!current || current.pointerId !== event.pointerId || !rendered || !preview) return
    setRegion(screenshotRegionFromDrag(current.start, { x: event.clientX, y: event.clientY }, current.rendered, preview, rendered))
  }
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    const rendered = rect()
    if (!preview || !imageReady || saving || event.button !== 0 || !rendered) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, rendered }; setRegion(null); setError('')
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    move(event); drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  let valid: ScreenshotRegion | null = null, regionError = ''
  if (preview && region) { try { valid = validateScreenshotRegion(region, preview) } catch (value) { regionError = value instanceof Error ? value.message : 'Choose a valid region.' } }
  const add = async () => {
    if (!preview || !valid || saving || !imageReady) return
    setSaving(true); setError('')
    try {
      const attachment = await window.faangin.commitScreenshotRegion(sessionId, preview.id, valid)
      currentPreview.current = null
      if (mounted.current) onAdded(attachment)
    } catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : 'The region could not be added.') }
    finally { if (mounted.current) setSaving(false) }
  }
  return <Modal title="Capture a region" description="Drag over the preview or enter pixel bounds. Only the region you confirm is added to your selected images." onClose={() => { if (!saving) onClose() }}>
    <div className="region-capture">
      {loading ? <Spinner label="Capturing the selected source"/> : preview ? <>
        <div className="region-source"><span>{preview.name}</span><span>{preview.width} × {preview.height} pixels</span></div>
        <div className="region-preview" onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { drag.current = null; setRegion(null) }} role="group" aria-label="Screenshot preview. Drag to choose a region, or use the pixel fields below.">
          <img ref={image} src={preview.dataUrl} alt={`Region preview from ${preview.name}`} draggable={false} onLoad={() => setImageReady(true)} onError={() => { setImageReady(false); setError('The screenshot preview could not be displayed. Close this dialog and capture again.') }}/>
          {region && region.width > 0 && region.height > 0 && <div className="region-selection" aria-hidden="true" style={{ left: `${region.x / preview.width * 100}%`, top: `${region.y / preview.height * 100}%`, width: `${region.width / preview.width * 100}%`, height: `${region.height / preview.height * 100}%` }}/>}
        </div>
        <div className="region-fields">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}><span>{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'width' ? 'Width' : 'Height'}</span><input type="number" step="1" min={key === 'width' || key === 'height' ? 1 : 0} max={key === 'x' || key === 'width' ? preview.width : preview.height} value={region?.[key] ?? ''} disabled={saving} onChange={event => { setRegion(previous => ({ ...(previous ?? { x: 0, y: 0, width: 0, height: 0 }), [key]: Number(event.target.value) })); setError('') }}/></label>)}</div>
        <button className="text-button" disabled={saving} onClick={() => setRegion({ x: 0, y: 0, width: preview.width, height: preview.height })}>Select the whole preview</button>
        <p className="region-hint">{regionError || (valid ? `${valid.width} × ${valid.height} pixels selected.` : 'Drag a rectangle or enter its bounds above.')} The preview is discarded after two minutes.</p>
      </> : null}
      {error && <p className="region-error" role="alert">{error}</p>}
      {expired && <button className="button subtle" disabled={saving} onClick={() => setAttempt(value => value + 1)}>Capture again</button>}
      <div className="modal-actions"><button className="button subtle" disabled={saving} onClick={onClose}>Cancel</button><button className="button primary" disabled={!valid || !imageReady || saving || loading} onClick={() => { void add() }}>{saving ? <LoaderCircle size={15} className="spin"/> : <Crop size={15}/>} {saving ? 'Adding region' : 'Add region'}</button></div>
    </div>
  </Modal>
}
