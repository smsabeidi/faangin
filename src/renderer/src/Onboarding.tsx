import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleCheck, Code2, Focus, Grip, Keyboard, Layers3, LoaderCircle, LockKeyhole, MessageSquare, Mic, Monitor, MoreHorizontal, Move, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { AppState, WorkspaceMode } from '../../shared/types'
import { shortcutLabel } from '../../main/shortcut-manager'
import { Brand } from './components'
import { completeOnboarding, readOnboarding, saveOnboarding } from './onboarding-state'

const steps = ['Welcome', 'Your focus', 'Access', 'Ready']

export interface OnboardingProps {
  state: AppState
  onComplete: (mode: WorkspaceMode) => void
  onConnect: () => void
  onRefresh: () => Promise<unknown>
  replay?: boolean
}

export default function Onboarding({ state, onComplete, onConnect, onRefresh, replay = false }: OnboardingProps) {
  const [progress, setProgress] = useState(() => { const saved = readOnboarding(); return { step: replay || saved.completed ? 0 : saved.step, mode: saved.mode } })
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [permissionHelp, setPermissionHelp] = useState<'microphone' | 'screen' | null>(null)
  const dialog = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const { step, mode } = progress
  const isMac = state.permissions.platform === 'darwin'
  const completedCount = [state.permissions.microphone, state.permissions.screen].filter(value => value === 'granted').length

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => previous?.focus()
  }, [])
  useEffect(() => { heading.current?.focus(); dialog.current?.querySelector('.onboarding-main')?.scrollTo({ top: 0 }) }, [step])
  useEffect(() => {
    const refresh = () => { if (step === 2) void onRefresh().catch(() => {}) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [step, onRefresh])

  function navigate(nextStep: number, selectedMode = mode) {
    const next = { step: Math.max(0, Math.min(3, nextStep)), mode: selectedMode }
    setProgress(next); setError(''); if (!replay) saveOnboarding({ ...next, completed: false })
  }
  function finish(connect = false) {
    completeOnboarding(mode)
    onComplete(mode)
    if (connect) onConnect()
  }
  async function refreshPermissions() {
    setPending('refresh'); setError('')
    try { await onRefresh() } catch { setError('Couldn’t refresh permissions. Try again, or continue and check them in Settings.') } finally { setPending('') }
  }
  async function openPermission(kind: 'microphone' | 'screen') {
    setPermissionHelp(kind); setPending(kind); setError('')
    try {
      await window.faangin.requestPermission(kind)
      await onRefresh()
    } catch { setError('Couldn’t finish the permission request. Open your system’s privacy settings, enable Faangin, then return here and refresh.') } finally { setPending('') }
  }
  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); finish(); return }
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []).filter(control => control.getClientRects().length > 0)
    const first = controls[0], last = controls[controls.length - 1]
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }

  const titles = ['A little setup.\nA clearer head.', 'Make it feel like you.', 'Your access, explained.', 'Make yourself at home.']
  const descriptions = [
    'Your space to prepare, think clearly, and keep the important things close. Let’s get you comfortable.',
    'Pick where you’d like to start. You can switch modes whenever you need.',
    'Screen and audio access are checked before your workspace opens. Recording starts when you choose Listen.',
    'Your workspace is ready to explore. Here are the few things that make everything easier.'
  ]

  return <div className="onboarding-backdrop">
    <section ref={dialog} className="onboarding onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description" data-onboarding-step={step} onKeyDown={trapFocus}>
      <header className="onboarding-topbar"><Brand/><span className="onboarding-setup-label">YOUR FIRST FEW MINUTES</span><button type="button" data-onboarding-skip className="onboarding-close" aria-label="Finish setup later" title="Finish setup later" onClick={() => finish()}><X size={17}/></button></header>
      <div className="onboarding-progress" aria-label="Setup progress">{steps.map((label, index) => <span key={label} className={`onboarding-step ${index === step ? 'current' : index < step ? 'done' : ''}`} aria-current={index === step ? 'step' : undefined}><span className="onboarding-step-number">{index < step ? <Check size={11}/> : String(index + 1).padStart(2, '0')}</span><span>{label}</span>{index < 3 && <span className="onboarding-step-line" aria-hidden="true"/>}</span>)}</div>
      <div className="onboarding-main">
        <div className="onboarding-intro"><span className="onboarding-eyebrow">{['LESS FRICTION. MORE FOCUS.', 'BUILT AROUND YOUR DAY.', 'ONLY WHAT YOU CHOOSE.', 'A FEW THINGS TO KNOW.'][step]}</span><h1 id="onboarding-title" ref={heading} tabIndex={-1}>{titles[step]}</h1><p id="onboarding-description">{descriptions[step]}</p></div>
        {step === 0 && <div className="onboarding-welcome-content"><OverlayPreview/><div className="onboarding-benefits"><Feature icon={Focus} title="Room to think" text="A quiet overlay keeps your tools within reach."/><Feature icon={Layers3} title="Context that stays together" text="Screenshots, notes, and answers in one place."/><Feature icon={ShieldCheck} title="Your call, every time" text="Choose when to capture and when to listen."/></div></div>}
        {step === 1 && <div className="onboarding-focus-content"><div className="onboarding-focus-options" role="radiogroup" aria-label="Choose your starting workspace">{([
          { value: 'interview', icon: Code2, eyebrow: 'PREPARE WITH CONFIDENCE', title: 'Interviews & practice', description: 'Work through coding problems, sharpen your approach, and practice your answers.', tags: 'Coding · System design · Behavioral' },
          { value: 'meeting', icon: MessageSquare, eyebrow: 'STAY WITH THE CONVERSATION', title: 'Meetings & notes', description: 'Keep context close, capture key points, and turn conversations into next steps.', tags: 'Conversations · Recaps · Action items' }
        ] as const).map(({ value, icon: Icon, eyebrow, title, description, tags }) => <button key={value} type="button" role="radio" tabIndex={mode === value ? 0 : -1} aria-checked={mode === value} className={`onboarding-focus-card ${mode === value ? 'selected' : ''}`} onClick={() => { const next = { step, mode: value }; setProgress(next); if (!replay) saveOnboarding({ ...next, completed: false }) }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const selectedMode = mode === 'interview' ? 'meeting' : 'interview'; setProgress({ step, mode: selectedMode }); if (!replay) saveOnboarding({ step, mode: selectedMode, completed: false }); const target = event.currentTarget.parentElement?.querySelector<HTMLElement>(`[aria-checked="false"]`); target?.focus() } }}><span className="onboarding-focus-card-top"><span className="onboarding-focus-icon"><Icon size={23} strokeWidth={1.6}/></span><span className="onboarding-radio-mark">{mode === value && <Check size={12}/>}</span></span><span className="onboarding-focus-eyebrow">{eyebrow}</span><strong>{title}</strong><span className="onboarding-focus-description">{description}</span><span className="onboarding-focus-tags">{tags}</span></button>)}</div><p className="onboarding-quiet-note"><Check size={13}/>Same workspace. A starting point that suits you.</p></div>}
        {step === 2 && <div className="onboarding-access-content"><div className="onboarding-access-heading"><span>SYSTEM ACCESS</span><button type="button" className="onboarding-refresh" disabled={!!pending} onClick={() => void refreshPermissions()}>{pending === 'refresh' ? <LoaderCircle size={13} className="spin"/> : <RefreshCw size={13}/>}Refresh permissions</button></div><div className="onboarding-permissions">{(['microphone', 'screen'] as const).map(kind => {
          const granted = state.permissions[kind] === 'granted'; const Icon = kind === 'microphone' ? Mic : Monitor
          return <div key={kind} className="onboarding-permission"><span className="onboarding-permission-icon"><Icon size={22} strokeWidth={1.6}/></span><div className="onboarding-permission-copy"><strong>{kind === 'microphone' ? 'Microphone' : 'Screen capture'}<span className={`onboarding-permission-status ${granted ? 'granted' : ''}`}>{granted ? <><Check size={10}/>Allowed</> : 'Not enabled'}</span></strong><p>{kind === 'microphone' ? 'Transcribe your voice when you start listening.' : 'Add a screenshot when you choose Capture.'}</p></div><button type="button" className="onboarding-permission-button" disabled={!!pending || granted} onClick={() => void openPermission(kind)}>{pending === kind ? <LoaderCircle size={13} className="spin"/> : granted ? <CircleCheck size={15}/> : <>{isMac ? (['not-determined', 'unknown', ''].includes(state.permissions[kind]) ? 'Allow access' : 'Open settings') : 'Manage access'}<ArrowUpRight size={12}/></>}{granted && 'Ready'}</button></div>
        })}</div><div className="onboarding-permission-help"><LockKeyhole size={16}/><p>{permissionHelp ? isMac ? <>In <strong>System Settings → Privacy & Security → {permissionHelp === 'microphone' ? 'Microphone' : 'Screen & System Audio Recording'}</strong>, enable Faangin. Return here and refresh. macOS may ask you to restart the app.</> : <>Enable Faangin in your system’s privacy settings, then return here and refresh permissions.</> : <>These controls open your system’s privacy settings. Computer audio is checked separately during access setup.</>}</p></div><p className="onboarding-quiet-note"><ShieldCheck size={13}/>You choose when to send context to your connected AI provider.</p></div>}
        {step === 3 && <div className="onboarding-ready-content"><div className="onboarding-ready-guide"><div className="onboarding-guide-item"><span className="onboarding-guide-icon"><Monitor size={18}/></span><div><strong>Capture what matters</strong><p>Use Capture to send your selected screen for an answer.</p></div><Shortcut state={state} action="capture-solve"/></div><div className="onboarding-guide-item"><span className="onboarding-guide-icon"><Move size={18}/></span><div><strong>Put it in your comfort zone</strong><p>Drag the overlay header to move it. Collapse it to make room.</p></div><ChevronDown size={17}/></div><div className="onboarding-guide-item"><span className="onboarding-guide-icon"><Keyboard size={18}/></span><div><strong>Make it your own</strong><p>Adjust appearance, shortcuts, and audio in Settings.</p></div><kbd>{isMac ? '⌘' : 'Ctrl'} ,</kbd></div></div><div className={`onboarding-connection ${state.chatConfigured ? 'connected' : ''}`}><span className="onboarding-connection-icon">{state.chatConfigured ? <CircleCheck size={21}/> : <Sparkles size={21}/>}</span><div><strong>{state.chatConfigured ? 'Your AI connection is configured.' : 'One more thing. Connect your AI.'}</strong><p>{state.chatConfigured ? 'Try a first question when you’re ready.' : 'Add your provider in Settings to get answers. You can explore first.'}</p></div>{!state.chatConfigured && <button type="button" onClick={() => finish(true)}>Connect AI<ArrowRight size={14}/></button>}</div><div className="onboarding-ready-footnote"><span><Check size={12}/>{mode === 'interview' ? 'Interview workspace' : 'Meeting workspace'}</span><span><Check size={12}/>{completedCount === 2 ? 'Permissions enabled' : 'Access checked before capture'}</span><span><Check size={12}/>Setup guide in Settings</span></div></div>}
        {error && <p className="onboarding-error" role="alert">{error}</p>}
      </div>
      <footer className="onboarding-footer"><div>{step === 0 ? <span className="onboarding-time"><span/>ABOUT TWO MINUTES</span> : <button type="button" className="onboarding-back" onClick={() => navigate(step - 1)}><ArrowLeft size={14}/>Back</button>}</div><div className="onboarding-footer-actions">{step === 0 && <button type="button" data-onboarding-skip className="onboarding-skip" onClick={() => finish()}>Explore first</button>}<button type="button" className="onboarding-primary" onClick={() => step === 3 ? finish() : navigate(step + 1)}>{step === 0 ? 'Get started' : step === 3 ? 'Open workspace' : 'Continue'}<ArrowRight size={15}/></button></div></footer>
    </section>
  </div>
}

function Feature({ icon: Icon, title, text }: { icon: typeof Focus; title: string; text: string }) {
  return <div className="onboarding-feature"><Icon size={17} strokeWidth={1.7}/><div><strong>{title}</strong><p>{text}</p></div></div>
}

function Shortcut({ state, action }: { state: AppState; action: string }) {
  const binding = state.shortcuts.find(item => item.id === action && item.registered)
  if (!binding) return null
  try { return <kbd>{shortcutLabel(binding.accelerator, state.permissions.platform as Parameters<typeof shortcutLabel>[1])}</kbd> } catch { return null }
}

function OverlayPreview() {
  return <figure className="onboarding-preview"><div className="onboarding-preview-aura"/><div className="onboarding-preview-window" aria-hidden="true"><div className="onboarding-preview-toolbar"><span className="onboarding-preview-wordmark">faangin<span>.</span></span><span className="onboarding-preview-capture"><Monitor size={12}/>Capture</span><MoreHorizontal size={15}/><ChevronDown size={14}/></div><div className="onboarding-preview-content"><span className="onboarding-preview-label"><span/>SPACE TO THINK</span><strong>Find your next clear step.</strong><p>Understand the question.<br/>Build your approach.<br/>Make it your own.</p><div className="onboarding-preview-input"><span>Ask a question or add context</span><ArrowRight size={13}/></div></div></div><figcaption><Grip size={12}/>A preview of your compact overlay</figcaption></figure>
}
