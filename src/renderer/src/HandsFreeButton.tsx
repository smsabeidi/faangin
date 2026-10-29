import { LoaderCircle, Mic, Square } from 'lucide-react'
import type { AppState } from '../../shared/types'
import { handsFreeControl } from './interview-workflow'

export default function HandsFreeButton({ state, busy, start, stop, className = 'button primary small' }: { state: Pick<AppState, 'settings' | 'capture' | 'currentSession'>; busy: string; start: () => Promise<unknown>; stop: () => Promise<unknown>; className?: string }) {
  const control = handsFreeControl(state)
  const stopping = control.action === 'stop'
  const starting = busy === 'Starting hands-free'
  return <>
    <button className={`${className} ${stopping ? 'record-stop' : ''}`} disabled={!!control.reason || (!!busy && !(stopping && starting))} title={control.reason || undefined} onClick={() => { void (stopping ? stop() : start()) }}>{starting && !stopping ? <LoaderCircle size={14} className="spin"/> : stopping ? <Square size={12}/> : <Mic size={14}/>} {starting && !stopping ? 'Starting hands-free…' : control.label}</button>
    {state.capture.sessionId && !stopping && <button className="button subtle small" disabled={!!busy && !starting} onClick={() => { void stop() }}><Square size={12}/>Stop listening</button>}
    {control.reason && <span className="hands-free-reason" role="status">{control.reason}</span>}
  </>
}
