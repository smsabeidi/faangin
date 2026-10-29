import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, ArrowUpRight, AudioLines, Check, CircleCheck, FolderDown, Info, LoaderCircle, LockKeyhole, Mic, Monitor, ShieldCheck } from 'lucide-react'
import type { AccessSetupState, AppState } from '../../shared/types'
import { Brand } from './components'
import { ACCESS_PERMISSION_ORDER, accessSetupReady, nextAccessPermission, permissionBlocked, permissionNeedsSettings, permissionReady, permissionStatusLabel, type AccessPermission } from './access-setup-state'

export interface AccessSetupProps {
  state: AppState
  onRefresh: () => Promise<unknown>
  onComplete: () => void
}

const permissionRows = [
  { kind: 'screen', label: 'Screen capture', icon: Monitor, description: 'Read your screen only when you choose Capture.' },
  { kind: 'microphone', label: 'Microphone', icon: Mic, description: 'Use your microphone when you start listening.' },
  { kind: 'system-audio', label: 'Computer audio', icon: AudioLines, description: 'Hear call audio from your computer when you start listening.' }
] as const

export default function AccessSetup({ state, onRefresh, onComplete }: AccessSetupProps) {
  const [report, setReport] = useState(state.accessSetup)
  const [pending, setPending] = useState<AccessPermission | 'complete' | 'start' | 'export' | ''>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [help, setHelp] = useState<AccessPermission | null>(null)
  const dialog = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(true)
  const actionLocked = useRef(false)
  const sequence = useRef(false)
  const attempted = useRef(new Set<AccessPermission>())
  const refreshInFlight = useRef<Promise<AccessSetupState> | null>(null)
  const parentRefresh = useRef(onRefresh)
  const complete = useRef(onComplete)
  const advance = useRef<(value: AccessSetupState, explicit?: boolean) => void>(() => {})
  parentRefresh.current = onRefresh
  complete.current = onComplete
  const ready = accessSetupReady(report)
  const grantedCount = ACCESS_PERMISSION_ORDER.filter(kind => permissionReady(report, kind)).length
  const isMac = state.permissions.platform === 'darwin'
  const session = state.currentSession
  const unsavedSession = session?.persistent === false && !!(session.transcript.length || session.answers.length || session.notes.trim() || session.attachments.length)

  const refresh = useCallback((): Promise<AccessSetupState> => {
    if (refreshInFlight.current) return refreshInFlight.current
    const job = (async () => {
      const result = await window.faangin.refreshAccessSetup()
      if (alive.current) setReport(result)
      await parentRefresh.current()
      return result
    })()
    refreshInFlight.current = job
    void job.finally(() => { if (refreshInFlight.current === job) refreshInFlight.current = null }).catch(() => {})
    return job
  }, [])

  async function request(kind: AccessPermission) {
    if (actionLocked.current) return
    actionLocked.current = true
    attempted.current.add(kind)
    setPending(kind); setError(''); setHelp(kind)
    let updated: AccessSetupState | undefined
    try {
      if (refreshInFlight.current) await refreshInFlight.current
      await window.faangin.requestPermission(kind)
      updated = await refresh()
      if (updated.issue && alive.current) setError(updated.issue)
    } catch (value) {
      sequence.current = false
      if (alive.current) setError(value instanceof Error ? value.message : 'The permission request could not finish. Enable access in system settings, then return here.')
      try { updated = await refresh() } catch { /* The error above stays visible and the next focus retries the status check. */ }
    } finally {
      actionLocked.current = false
      if (alive.current) {
        setPending('')
        if (updated) advance.current(updated)
      }
    }
  }

  advance.current = (value, explicit = false) => {
    if (!sequence.current || actionLocked.current || !alive.current) return
    if (!explicit && !document.hasFocus()) return
    const next = nextAccessPermission(value)
    if (!next) { sequence.current = false; return }
    // A returned OS Settings screen can remain open for minutes. Recheck it without reopening its prompt.
    if (attempted.current.has(next)) return
    void request(next)
  }

  useEffect(() => {
    if (!state.accessSetup) return
    setReport(state.accessSetup)
    advance.current(state.accessSetup)
  }, [state.accessSetup])
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement as HTMLElement | null
    heading.current?.focus()
    const check = () => {
      if (document.visibilityState !== 'visible' || actionLocked.current) return
      void refresh().then(value => { if (alive.current) advance.current(value) }).catch(() => {
        if (alive.current) setError('Permission status could not be checked. Keep this window open; we’ll try again automatically.')
      })
    }
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    const timer = window.setInterval(check, 1500)
    return () => {
      alive.current = false; sequence.current = false
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
      previous?.focus()
    }
  }, [refresh])

  async function begin() {
    if (actionLocked.current) return
    actionLocked.current = true
    setPending('start'); setError(''); attempted.current.clear(); sequence.current = true
    try {
      const value = await refresh()
      actionLocked.current = false
      if (alive.current) { setPending(''); advance.current(value, true) }
    } catch {
      actionLocked.current = false; sequence.current = false
      if (alive.current) { setPending(''); setError('Setup could not check access. Try Set up access again.') }
    }
  }
  async function finish() {
    if (actionLocked.current || !accessSetupReady(report)) return
    actionLocked.current = true; setPending('complete'); setError('')
    try {
      await window.faangin.completeAccessSetup()
      await parentRefresh.current()
      complete.current()
    } catch (value) {
      if (alive.current) setError(value instanceof Error ? value.message : 'Access changed before setup finished. We’ll check again automatically.')
      try { await refresh() } catch { /* Retain the concrete completion error. */ }
    } finally { actionLocked.current = false; if (alive.current) setPending('') }
  }
  async function exportUnsaved() {
    if (actionLocked.current || !session) return
    actionLocked.current = true; setPending('export'); setError('')
    try {
      const result = await window.faangin.exportSession(session.id, 'json')
      if (result && alive.current) setNotice('Your current session was exported.')
    } catch (value) { if (alive.current) setError(value instanceof Error ? value.message : 'The session could not be exported. Your current session is still open.') }
    finally { actionLocked.current = false; if (alive.current) setPending('') }
  }
  async function openSettings(kind: AccessPermission) {
    if (actionLocked.current) return
    actionLocked.current = true; setPending(kind); setError(''); setHelp(kind)
    try { await window.faangin.openPermissionSettings(kind) }
    catch (value) { if (alive.current) setError(value instanceof Error ? value.message : 'System settings could not be opened. Open your system’s privacy settings manually.') }
    finally { actionLocked.current = false; if (alive.current) setPending('') }
  }
  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return }
    if (event.key !== 'Tab') return
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') || [])].filter(control => control.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }
  const helpKind = help && (permissionNeedsSettings(report, help) || help === 'screen' && !pending && !permissionReady(report, 'screen')) ? help : ACCESS_PERMISSION_ORDER.find(kind => permissionNeedsSettings(report, kind))
  const systemSettingsSection = helpKind === 'microphone' ? 'Microphone' : 'Screen & System Audio Recording'

  return <div className="access-setup-backdrop"><section ref={dialog} className="access-setup" role="dialog" aria-modal="true" aria-labelledby="access-setup-title" aria-describedby="access-setup-description" data-access-ready={ready} onKeyDown={trapFocus}>
    <header className="access-setup-header"><Brand/><span><LockKeyhole size={13}/>ONE-TIME SETUP</span></header>
    <div className="access-setup-main">
      <div className="access-setup-intro"><h1 id="access-setup-title" ref={heading} tabIndex={-1}>Let’s get you set up.</h1><p id="access-setup-description">Allow screen and audio access once. We’ll guide you through each step.</p></div>
      <div className="access-setup-rows">{permissionRows.map(({ kind, label, icon: Icon, description }) => {
        const allowed = permissionReady(report, kind)
        const blocked = permissionBlocked(report, kind)
        const needsSettings = permissionNeedsSettings(report, kind)
        const checking = pending === kind || !report || report.checking && !allowed
        return <div className="access-setup-row" key={kind} data-permission={kind}><span className="access-setup-row-icon"><Icon size={21} strokeWidth={1.6}/></span><div className="access-setup-row-copy"><div><strong>{label}</strong><span className={`access-setup-status ${checking ? 'checking' : allowed ? 'granted' : blocked ? 'blocked' : ''}`} role="status">{checking ? <LoaderCircle size={10} className="spin"/> : allowed ? <Check size={10}/> : null}{permissionStatusLabel(report, kind, checking)}</span></div><p>{description}</p></div><button type="button" className={`access-setup-allow ${allowed ? 'ready' : ''}`} aria-label={allowed ? `${label} access ready` : `${needsSettings ? 'Open settings for' : blocked ? 'Retry access to' : 'Allow access to'} ${label.toLowerCase()}`} disabled={!!pending || allowed} onClick={() => void (needsSettings ? openSettings(kind) : request(kind))}>{checking && pending === kind ? <><LoaderCircle size={13} className="spin"/>Checking…</> : allowed ? <><CircleCheck size={16}/>Ready</> : <>{needsSettings ? 'Open settings' : blocked ? 'Try again' : 'Allow access'}<ArrowUpRight size={12}/></>}</button></div>
      })}</div>
      {helpKind && <div className="access-setup-help"><Info size={16}/><div><p>{isMac ? <>Open <strong>System Settings → Privacy &amp; Security → {systemSettingsSection}</strong> and enable Faangin. Return here when you’re done; we’ll check automatically. {unsavedSession ? 'Save your current session below before restarting.' : ''} If macOS asks to quit and reopen Faangin, choose <strong>Quit &amp; Reopen</strong>. Your setup will resume.</> : <>Open your system’s privacy settings and allow {helpKind === 'microphone' ? 'microphone' : 'screen and computer audio'} access for Faangin. Return here; we’ll check automatically.</>} {helpKind === 'system-audio' && 'Then choose Retry audio check below to verify computer audio.'}</p><button type="button" disabled={!!pending} onClick={() => void openSettings(helpKind)}>Open {isMac ? 'System Settings' : 'privacy settings'}<ArrowUpRight size={12}/></button>{helpKind === 'system-audio' && <button type="button" disabled={!!pending} onClick={() => void request('system-audio')}>Retry audio check<ArrowRight size={12}/></button>}</div></div>}
      <p className="access-setup-note"><ShieldCheck size={12}/>{ready ? 'We’ll configure your audio inputs when you continue. Listening stays off.' : 'Setup does not transcribe or save audio. Listening starts only when you choose.'} After setup, access is checked once when Faangin opens.</p>
      {error && <p className="access-setup-error" role="alert">{error}</p>}
      {notice && <p className="access-setup-note" role="status">{notice}</p>}
    </div>
    <footer className="access-setup-footer"><div className="access-setup-footer-status" role="status">{ready ? <CircleCheck size={18}/> : <ShieldCheck size={17}/>}<span>{ready ? 'All required access is ready.' : `${grantedCount} of 3 ready · Checks automatically`}<small className="access-setup-recording">{state.capture.active ? 'Your current session is listening.' : 'Listening is off.'}</small>{unsavedSession && <button type="button" className="access-setup-export" disabled={!!pending} onClick={() => void exportUnsaved()}><FolderDown size={13}/>Save current session</button>}</span></div><button type="button" className="access-setup-primary" disabled={!!pending} onClick={() => void (ready ? finish() : begin())}>{pending ? <><LoaderCircle size={15} className="spin"/>{pending === 'complete' ? 'Finishing setup…' : pending === 'export' ? 'Saving session…' : 'Checking access…'}</> : <>{ready ? 'Continue' : 'Set up access'}<ArrowRight size={15}/></>}</button></footer>
  </section></div>
}
