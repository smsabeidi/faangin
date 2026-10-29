import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, BookOpen, Check, ChevronDown, ChevronUp, CircleHelp, Code2, Copy, Crop, Download, FileText, FolderOpen, ImagePlus, Layers3, LoaderCircle, Maximize2, MessageSquare, Mic, Monitor, MoreHorizontal, PanelLeftClose, PanelRightClose, PanelRightOpen, Pause, Play, Plus, RotateCcw, Search, Send, Settings2, ShieldCheck, Sparkles, Square, Terminal, Trash2, Volume2, WandSparkles, X, Zap } from 'lucide-react'
import type { Action, Answer, AppEvent, AppState, Attachment, GenerateInput, Session, SessionSummary, WorkspaceMode } from '../../shared/types'
import { Brand, IconButton, MarkdownText, Modal, shortDate, shortTime, Spinner, Toggle } from './components'
import { SYSTEM_AUDIO_CONSENT_MESSAGE } from '../../main/system-audio-consent'
import Settings, { type SettingsSection } from './Settings'
import InterviewEditor from './InterviewEditor'
import { clearPartials, revisePartial, type PartialTurn } from './live-transcript'
import SessionContext from './SessionContext'
import { sessionDateFilter } from './session-dates'
import AnswerCard from './AnswerCard'
import AnswerLatestButton from './AnswerLatestButton'
import HandsFreeButton from './HandsFreeButton'
import AutomaticHelpStatus from './AutomaticHelpStatus'
import OverlayInteractionButton from './OverlayInteractionButton'
import OverlayHeader, { overlayCaptureShortcut } from './OverlayHeader'
import OverlayResize, { OverlaySizeControls } from './OverlayResize'
import { overlayInteractionRecovery } from './overlay-interaction'
import { actions } from './workspace-actions'
import { answerQuestionUpdated, latestAnswerIsInterrupted, latestQuestionRequest, shouldFollowAnswerUpdates } from './answer-status'
import RegionCapture from './RegionCapture'
import { AnswerStreamBatcher } from './answer-stream'
import { composerShortcutRequest } from './composer-request'
import { hasRegisteredActionShortcut } from './registered-shortcut'
import { handleSettingsShortcut } from './settings-shortcut'
import { attachmentSelectionSummary, attachmentTrayVisible } from './composer-attachments'
import { manualGenerationBlocked } from './generation-ownership'
import { PendingDesktopOperations, settledRequestDraft, type RequestOwner } from './pending-operations'
import { audioInputGuidance, HANDS_FREE_CONSENT, hasReplyContext, interviewFollowupRequest, questionSourceHealth, questionSourcePatch, startHandsFreeInterview } from './interview-workflow'
import Onboarding from './Onboarding'
import { completeOnboarding, readOnboarding, shouldShowOnboarding } from './onboarding-state'
import AccessSetup from './AccessSetup'

type View = 'workspace' | 'library' | 'settings'
type Run = <T>(label: string, task: () => Promise<T>, refresh?: boolean) => Promise<T | undefined>


export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>('workspace')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connection')
  const [initialError, setInitialError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [partials, setPartials] = useState<Record<string, PartialTurn>>({})
  const [levels, setLevels] = useState({ microphone: 0, system: 0 })
  const [transcriptOpen, setTranscriptOpen] = useState(true)
  const [defaultMode, setDefaultMode] = useState<WorkspaceMode>('interview')
  const [onboardingOpen, setOnboardingOpen] = useState<boolean | null>(null)
  const [replayingOnboarding, setReplayingOnboarding] = useState(false)
  const accessWasRequired = useRef(false)
  const passThrough = state?.overlayClickThrough ?? false
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([])
  const [draftPrompt, setDraftPrompt] = useState('')
  const [regionRequest, setRegionRequest] = useState<{ sessionId: string; contextEpoch: number; sourceId?: string } | null>(null)
  const [requestedReset, setRequestedReset] = useState(false)
  const [systemAudioNotice, setSystemAudioNotice] = useState<{ sessionId: string; resume: boolean; epoch: number | null } | null>(null)
  const answerStreams = useRef<AnswerStreamBatcher | null>(null)
  const stateRevision = useRef(0)
  const currentId = useRef<string | null>(null)
  const currentEpoch = useRef<number | null>(null)
  const alive = useRef(true)
  const pendingOperations = useRef(new PendingDesktopOperations())
  const activeSessionOwner = useRef<RequestOwner | null>(null)
  const handsFreeStarting = useRef(false)
  const handsFreeStartAbort = useRef<AbortController | null>(null)

  const applyState = useCallback((incoming: AppState) => {
    stateRevision.current++
    activeSessionOwner.current = incoming.currentSession ? { sessionId: incoming.currentSession.id, contextEpoch: incoming.currentSession.contextEpoch } : null
    if (answerStreams.current) incoming = { ...incoming, currentSession: answerStreams.current.reconcile(incoming.currentSession) }
    if (incoming.systemAudioConsented) setError(current => current.includes(SYSTEM_AUDIO_CONSENT_MESSAGE) ? '' : current)
    setState(incoming)
  }, [])

  const refresh = useCallback(async () => {
    const streams = answerStreams.current
    const revision = stateRevision.current
    const fresh = await window.faangin.getState()
    if (alive.current && answerStreams.current === streams && stateRevision.current === revision) { applyState(fresh); setInitialError('') }
  }, [applyState])

  useEffect(() => {
    alive.current = true
    if (!window.faangin) { setInitialError('The desktop connection is unavailable. Open Faangin in the desktop app to connect to your local workspace.'); return }
    const streams = new AnswerStreamBatcher({
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: handle => window.cancelAnimationFrame(handle),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: handle => window.clearTimeout(handle),
    }, (updates, generation) => {
      setState(previous => {
        if (!alive.current || answerStreams.current !== streams || !streams.isCurrent(generation) || !previous?.currentSession) return previous
        const session = previous.currentSession
        const pending = new Map(updates.filter(update => update.sessionId === session.id && update.contextEpoch === session.contextEpoch).map(update => [update.requestId, update]))
        if (!pending.size) return previous
        let changed = false
        const answers = session.answers.map(answer => {
          const update = pending.get(answer.requestId)
          if (!update || update.answerId !== answer.id || answer.status !== 'streaming' || update.text.length < answer.text.length || (answer.text === update.text && answer.firstTokenMs === update.firstTokenMs)) return answer
          changed = true
          return { ...answer, text: update.text, firstTokenMs: update.firstTokenMs }
        })
        return changed ? { ...previous, currentSession: { ...session, answers } } : previous
      })
    })
    answerStreams.current = streams
    const unsubscribe = window.faangin.onEvent((event: AppEvent) => {
      if (!alive.current) return
      if (event.type === 'state') applyState(event.state)
      else if (event.type === 'navigate') setView(event.view)
      else if (event.type === 'shortcut') window.dispatchEvent(new CustomEvent('faangin-shortcut', { detail: event.action }))
      else if (event.type === 'error') { if (!consentNoticeShownHere(event.message)) setError(event.message) }
      else if (event.type === 'system-audio-consent') { setView('workspace'); setSystemAudioNotice({ sessionId: event.sessionId, resume: event.resume, epoch: currentId.current === event.sessionId ? currentEpoch.current : null }) }
      else if (event.type === 'audio-level') setLevels(previous => ({ ...previous, [event.channel]: Math.max(0, Math.min(1, event.level)) }))
      else if (event.type === 'capture-status') setState(previous => previous ? { ...previous, capture: { active: event.active, sessionId: event.sessionId, microphone: event.microphone, system: event.system } } : previous)
      else if (event.type === 'live-suggestions') setState(previous => previous ? { ...previous, liveSuggestions: event.state } : previous)
      else if (event.type === 'transcript-partial') {
        setPartials(previous => revisePartial(previous, event))
      } else if (event.type === 'transcript-clear') {
        setPartials(previous => clearPartials(previous, event.sessionId, event.channel))
      } else if (event.type === 'transcript-final') {
        setPartials(previous => Object.fromEntries(Object.entries(previous).filter(([, item]) => !(item.sessionId === event.turn.sessionId && item.channel === event.turn.channel && (item.itemId === event.turn.id || event.turn.id.endsWith(`:${item.channel}:${item.itemId}`))))))
        setState(previous => {
          if (!previous?.currentSession || previous.currentSession.id !== event.turn.sessionId) return previous
          const turns = previous.currentSession.transcript
          const next = turns.some(turn => turn.id === event.turn.id) ? turns.map(turn => turn.id === event.turn.id ? event.turn : turn) : [...turns, event.turn]
          return { ...previous, currentSession: { ...previous.currentSession, transcript: next.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)) } }
        })
      } else if (event.type === 'answer-started') {
        const answer = streams.start(event.answer)
        if (!answer) return
        if (answer.origin === 'automatic') window.dispatchEvent(new CustomEvent('faangin-automatic-answer', { detail: answer.sessionId }))
        setState(previous => {
          if (answerStreams.current !== streams || !previous?.currentSession || previous.currentSession.id !== answer.sessionId) return previous
          const session = previous.currentSession
          const answers = session.answers.some(item => item.id === answer.id) ? session.answers.map(item => item.id === answer.id ? answer : item) : [...session.answers, answer]
          return { ...previous, currentSession: { ...session, answers } }
        })
      } else if (event.type === 'answer-delta') {
        streams.delta(event)
      } else if (event.type === 'answer-complete') {
        const answer = streams.complete(event.answer)
        if (!answer) return
        setState(previous => {
          if (answerStreams.current !== streams || !previous?.currentSession || previous.currentSession.id !== answer.sessionId) return previous
          const answers = previous.currentSession.answers
          if (!answers.some(item => item.id === answer.id)) return previous
          return { ...previous, currentSession: { ...previous.currentSession, answers: answers.map(item => item.id === answer.id ? answer : item) } }
        })
      }
    })
    void refresh().catch(e => setInitialError(errorMessage(e)))
    return () => { alive.current = false; unsubscribe(); streams.dispose(); if (answerStreams.current === streams) answerStreams.current = null }
  }, [applyState, refresh])

  useEffect(() => {
    const nextId = state?.currentSession?.id || null
    const nextEpoch = state?.currentSession?.contextEpoch ?? null
    if (currentId.current !== nextId || currentEpoch.current !== nextEpoch) { currentId.current = nextId; currentEpoch.current = nextEpoch; setPartials({}); setLevels({ microphone: 0, system: 0 }); setDraftPrompt('') }
  }, [state?.currentSession?.id, state?.currentSession?.contextEpoch])
  useEffect(() => {
    setRegionRequest(current => current && (current.sessionId !== state?.currentSession?.id || current.contextEpoch !== state?.currentSession?.contextEpoch) ? null : current)
  }, [state?.currentSession?.id, state?.currentSession?.contextEpoch])
  const selectionIds = state?.currentSession?.selectedAttachmentIds?.join(',') || ''
  useEffect(() => {
    setSelectedAttachmentIds(state?.currentSession?.selectedAttachmentIds || [])
  }, [state?.currentSession?.id, selectionIds])
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(''), 4500); return () => window.clearTimeout(timer) } }, [notice])
  useEffect(() => { document.documentElement.classList.toggle('overlay-window', state?.windowKind === 'overlay' || window.location.hash === '#overlay' || new URLSearchParams(window.location.search).get('window') === 'overlay') }, [state?.windowKind])
  useEffect(() => {
    if (!state || state.windowKind === 'overlay') return
    if (state.accessSetup?.required) { accessWasRequired.current = true; return }
    if (accessWasRequired.current) {
      accessWasRequired.current = false
      completeOnboarding(state.currentSession?.mode || readOnboarding().mode)
      setOnboardingOpen(false)
      setReplayingOnboarding(false)
      setSettingsSection('connection')
      setView(state.chatConfigured ? 'workspace' : 'settings')
      return
    }
    if (onboardingOpen !== null) return
    setDefaultMode(readOnboarding().mode)
    setOnboardingOpen(shouldShowOnboarding(state))
  }, [state, onboardingOpen])

  const run: Run = useCallback(async (label, task, shouldRefresh = true) => {
    const operationId = pendingOperations.current.begin(label)
    setBusy(label)
    setError('')
    try { const result = await task(); if (shouldRefresh) await refresh(); return result }
    catch (e) { const message = errorMessage(e); if (!consentNoticeShownHere(message)) setError(message); return undefined }
    finally { setBusy(pendingOperations.current.finish(operationId)) }
  }, [refresh])

  const ensureSession = async () => state?.currentSession || await window.faangin.createSession(defaultMode)
  const createSession = (mode = defaultMode) => { setDefaultMode(mode); setView('workspace'); return run('Creating session', async () => { if (state?.capture.sessionId) await window.faangin.stopCapture(); return window.faangin.createSession(mode) }) }
  const changeMode = (mode: WorkspaceMode) => { if (state?.currentSession?.mode === mode) return; setDefaultMode(mode); if (state?.currentSession) void createSession(mode) }
  const generate = async (action: Action, prompt = '', attachmentIds?: string[], replaceActive = false) => {
    if (!state?.chatConfigured) { if (state?.windowKind === 'overlay') await run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false); else { setSettingsSection('connection'); setView('settings') }; return false }
    let requestOwner: RequestOwner | null = null
    const result = await run('Sending request', async () => {
      const session = await ensureSession()
      requestOwner = { sessionId: session.id, contextEpoch: session.contextEpoch }
      const request = action === 'reply' ? interviewFollowupRequest(prompt) : { action, prompt, attachmentIds: attachmentIds ?? selectedAttachmentIds.filter(id => session.attachments.some(image => image.id === id)) }
      return window.faangin.generate({ sessionId: session.id, ...request, smart: state.settings.smartMode, ...(replaceActive ? { replaceActive: true } : {}) })
    }, false)
    if (prompt) setDraftPrompt(current => settledRequestDraft(current, prompt, !!result, requestOwner, activeSessionOwner.current))
    return !!result
  }
  const answerLatest = () => { const request = latestQuestionRequest(state?.currentSession?.mode || defaultMode, draftPrompt); return generate(request.action, request.prompt, request.attachmentIds, request.replaceActive) }
  const capture = () => run('Capturing screen', async () => { const session = await ensureSession(); return window.faangin.captureScreen(session.id, state?.settings.screenshotSourceId || undefined) })
  const captureAndSolve = async () => {
    if (!state?.chatConfigured) { if (state?.windowKind === 'overlay') await run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false); else { setSettingsSection('connection'); setView('settings') }; return }
    if (state.settings.chatProvider === 'compatible' && !state.settings.compatibleChatVision) { setError('Your chat provider has image inputs turned off. Enable image support in Connection & models, or type the problem to solve it.'); return }
    await run('Capturing and solving', async () => { const session = await ensureSession(); return window.faangin.captureAndSolve(session.id) }, false)
  }
  const captureRegion = () => run('Preparing region selection', async () => { const current = await ensureSession(); setRegionRequest({ sessionId: current.id, contextEpoch: current.contextEpoch, sourceId: state?.settings.screenshotSourceId || undefined }) })
  const importImage = () => run('Importing image', async () => { const session = await ensureSession(); await window.faangin.importImage(session.id) })
  const start = () => {
    if (!state?.keyConfigured) { if (state?.windowKind === 'overlay') return run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false); setSettingsSection('connection'); setView('settings'); return Promise.resolve(undefined) }
    return run('Starting capture', async () => { const session = await ensureSession(); if (session.mode === 'interview') await window.faangin.updateSettings({ liveSuggestions: false, ...(!state.capture.sessionId && !(state.settings.liveSuggestionSource === 'system' ? state.settings.systemAudio : state.settings.microphone) ? questionSourcePatch(state.settings.liveSuggestionSource) : {}) }); if (state.capture.sessionId === session.id && session.status === 'paused') await window.faangin.resumeCapture(session.id); else await window.faangin.startCapture(session.id) })
  }
  const startHandsFree = async () => {
    if (handsFreeStarting.current) return
    if (!state?.keyConfigured || !state.chatConfigured) { if (state?.windowKind === 'overlay') await run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false); else { setSettingsSection('connection'); setView('settings') }; return }
    handsFreeStarting.current = true
    const controller = new AbortController()
    handsFreeStartAbort.current = controller
    try {
      await run('Starting hands-free', async () => {
        const session = await ensureSession()
        try { await startHandsFreeInterview(window.faangin, session, controller.signal) }
        catch (error) { if (!controller.signal.aborted) throw error }
      })
    } finally { handsFreeStarting.current = false; if (handsFreeStartAbort.current === controller) handsFreeStartAbort.current = null }
  }
  const stop = () => { handsFreeStartAbort.current?.abort(); return run('Stopping capture', () => window.faangin.stopCapture()) }
  const copy = async (text: string, message = 'Copied to clipboard') => {
    try { await navigator.clipboard.writeText(text); setNotice(message) } catch (e) { setError(errorMessage(e)) }
  }
  const openSession = (id: string) => { setView('workspace'); return run('Opening session', () => window.faangin.selectSession(id)) }
  const openOverlay = () => run('Opening overlay', () => window.faangin.openWindow('overlay'), false)
  const makeOverlayInteractive = () => run('Enabling overlay interaction', async () => { await window.faangin.openWindow('overlay'); await window.faangin.setClickThrough(false) }, false)
  const selectAttachments = (ids: string[]) => {
    if (!state?.currentSession) return
    setSelectedAttachmentIds(ids)
    void window.faangin.selectAttachments(state.currentSession.id, ids).catch(e => { setError(errorMessage(e)); void refresh() })
  }
  const smart = (enabled: boolean) => run('Updating model policy', () => window.faangin.updateSettings({ smartMode: enabled }))
  const cancel = (requestId: string) => {
    const cancelled = answerStreams.current?.cancel(requestId)
    if (cancelled) setState(previous => previous?.currentSession ? { ...previous, currentSession: { ...previous.currentSession, answers: previous.currentSession.answers.map(answer => answer.id === cancelled.id ? cancelled : answer) } } : previous)
    return run('Cancelling request', () => window.faangin.cancelGeneration(requestId))
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (onboardingOpen || state?.accessSetup?.required) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        const action = event.shiftKey ? 'solve' : 'assist'
        if (!hasRegisteredActionShortcut(state?.shortcuts ?? [], action)) {
          event.preventDefault()
          if (!manualGenerationBlocked(state?.currentSession?.answers ?? [], !!busy)) void generate(action, draftPrompt.trim())
        }
      }
      handleSettingsShortcut(event, state?.windowKind, () => run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false), () => setView('settings'))
    }
    const shortcut = (event: Event) => {
      if (onboardingOpen || state?.accessSetup?.required) return
      const action = (event as CustomEvent<'assist' | 'solve' | 'reply' | 'reset' | 'scroll-up' | 'scroll-down'>).detail
      if (action === 'reset') { setView('workspace'); setRequestedReset(true); return }
      if (action === 'scroll-up' || action === 'scroll-down') { document.querySelector('.overlay-answer, .answer-feed')?.scrollBy({ top: action === 'scroll-up' ? -240 : 240, behavior: state?.accessibility.reduceMotion ? 'instant' : 'smooth' }); return }
      if (action === 'reply' && state?.currentSession?.mode === 'interview') { if (!busy) void answerLatest(); return }
      if (manualGenerationBlocked(state?.currentSession?.answers ?? [], !!busy)) return
      const editingComposer = document.activeElement instanceof HTMLTextAreaElement && !!document.activeElement.closest('.composer')
      if (action === 'assist' && document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest('.manual-context')) { window.dispatchEvent(new Event('faangin-add-context')); return }
      if (editingComposer && draftPrompt.trim()) void generate(action === 'assist' ? 'ask' : action, draftPrompt.trim())
      else void generate(action, draftPrompt.trim())
    }
    window.addEventListener('keydown', listener)
    window.addEventListener('faangin-shortcut', shortcut)
    return () => { window.removeEventListener('keydown', listener); window.removeEventListener('faangin-shortcut', shortcut) }
  })

  if (!state) return <div className="startup"><Brand/><div className="startup-content">{initialError ? <><h1>Let’s reconnect your workspace.</h1><p>{initialError}</p><button className="button primary" onClick={() => { if (window.faangin) void refresh().catch(e => setInitialError(errorMessage(e))); else window.location.reload() }}><RotateCcw size={16}/> Try again</button></> : <><Spinner label="Opening your workspace"/><p>Your sessions stay on this device.</p></>}</div></div>

  const session = state.currentSession
  const mode = session?.mode || defaultMode
  const activeAnswer = session?.answers.find(answer => answer.status === 'streaming')
  const questionHealth = questionSourceHealth(state.settings, state.capture)
  const working = manualGenerationBlocked(session?.answers ?? [], busy === 'Sending request')
  const overlay = state.windowKind === 'overlay' || window.location.hash === '#overlay'
  const appearanceClasses = [`theme-${state.settings.theme}`, `platform-${state.permissions.platform}`, !overlay && state.permissions.platform === 'darwin' && !state.accessibility.reduceTransparency && 'native-material', state.accessibility.reduceTransparency && 'reduce-transparency', state.accessibility.reduceMotion && 'reduce-motion', state.accessibility.increaseContrast && 'increase-contrast'].filter(Boolean).join(' ')
  const interactionRecovery = overlayInteractionRecovery(state.shortcuts, state.permissions.platform)
  const style = { '--user-font-size': `${state.settings.fontSize}px`, '--overlay-opacity': state.settings.opacity } as CSSProperties
  const common = { state, session, mode, busy, working, activeAnswer, generate, answerLatest, capture, captureAndSolve, captureRegion, importImage, start, startHandsFree, stop, run, copy, changeMode, smart, cancel, selectedAttachmentIds, setSelectedAttachmentIds: selectAttachments, draftPrompt, setDraftPrompt, notify: setNotice }
  const regionDialog = regionRequest && <RegionCapture key={`${regionRequest.sessionId}:${regionRequest.contextEpoch}`} sessionId={regionRequest.sessionId} sourceId={regionRequest.sourceId} onClose={() => setRegionRequest(null)} onAdded={() => { setRegionRequest(null); void refresh().catch(value => setError(errorMessage(value))) }}/>
  const listenAfterNotice = (request: { sessionId: string; epoch: number | null }) => run('Starting capture', async () => {
    await window.faangin.acknowledgeSystemAudioConsent()
    const latest = await window.faangin.getState()
    if (latest.capture.sessionId === request.sessionId) { await window.faangin.resumeCapture(request.sessionId); return }
    // A start never moves to a session that was switched or reset while the notice was open.
    const current = latest.currentSession
    if (!current || current.id !== request.sessionId || (request.epoch !== null && current.contextEpoch !== request.epoch)) return
    await window.faangin.startCapture(request.sessionId)
  })
  const systemAudioNoticeDialog = systemAudioNotice && <Modal title="Before Faangin listens to computer audio" description="Computer audio is everything your computer plays, including other people on a call. While you listen, Faangin sends it to OpenAI to transcribe." onClose={() => setSystemAudioNotice(null)}><div className="system-audio-notice"><p>Transcripts stay on this device when session history is on, and go to your chat provider when you ask for help or turn on automatic help.</p><p>Tell the other people on the call that you are transcribing, and get their consent where the law requires it. In some places everyone on a call has to agree.</p><p>Follow the rules of the interview, meeting, class or platform you are using.</p><p className="settings-footnote">You will see this notice once. To use only your microphone, turn off Computer audio in Settings.</p></div><div className="modal-actions"><button className="button subtle" onClick={() => setSystemAudioNotice(null)}>Not now</button><button className="button primary" disabled={!!busy} onClick={() => { const request = systemAudioNotice; setSystemAudioNotice(null); void listenAfterNotice(request) }}>I understand, start listening</button></div></Modal>

  if (state.accessSetup?.required) {
    if (overlay) return <div className={`app overlay-app access-required-overlay ${appearanceClasses}`} style={style}><div className="access-required-content"><ShieldCheck size={28}/><h1>Finish setting up access.</h1><p>Faangin needs permission to capture your screen and use audio.</p><button type="button" className="button primary" onClick={() => { void window.faangin.openWindow('workspace').catch(value => setError(errorMessage(value))) }}>Open setup<ArrowUpRight size={16}/></button>{error && <p role="alert">{error}</p>}</div></div>
    return <div className={`app access-setup-app ${appearanceClasses}`} style={style}><AccessSetup state={state} onRefresh={refresh} onComplete={() => {
      completeOnboarding(session?.mode || defaultMode)
      setOnboardingOpen(false)
      setReplayingOnboarding(false)
      setSettingsSection('connection')
      setView(state.chatConfigured ? 'workspace' : 'settings')
    }}/></div>
  }

  if (overlay) {
    const captureShortcut = overlayCaptureShortcut(state.shortcuts, state.permissions.platform)
    const capturing = busy === 'Capturing and solving' || state.captureSolve?.phase === 'capturing'
    const captureOwned = state.capture.sessionId !== null
    const paused = [state.capture.microphone, state.capture.system].includes('Paused')
    const overlayStatus = questionHealth.unavailable ? 'Audio needs attention' : paused && captureOwned ? 'Listening paused' : state.settings.liveSuggestions && state.liveSuggestions?.phase === 'paused' && captureOwned ? 'Automatic help paused' : questionHealth.waiting ? 'Waiting for audio' : questionHealth.listening ? 'Listening' : captureOwned ? 'Connecting audio' : 'Ready'
    const replyReady = hasReplyContext(session, state.capture, Object.values(partials)) || !!draftPrompt.trim()
    return <div className={`app overlay-app ${state.settings.overlayCollapsed ? 'overlay-collapsed' : ''} ${appearanceClasses}`} style={style} data-overlay-interaction={passThrough ? 'click-through' : 'interactive'}>
      <OverlayHeader status={overlayStatus} listening={questionHealth.listening} passive={passThrough} recovery={interactionRecovery} recoveryLabel={state.permissions.platform === 'darwin' ? 'Menu bar' : 'Tray'} shortcut={captureShortcut} collapsed={state.settings.overlayCollapsed} busy={!!busy} capturing={capturing} working={working || !!state.captureSolve} captureOwned={captureOwned} captureAndSolve={captureAndSolve} cancelAnswer={activeAnswer ? () => cancel(activeAnswer.requestId) : undefined} collapse={() => run('Updating overlay', () => window.faangin.updateSettings({ overlayCollapsed: !state.settings.overlayCollapsed }))} stop={stop}>
        <OverlaySizeControls opacity={state.settings.opacity} onError={setError}/>
        <section className="overlay-menu-section"><h2>Conversation</h2><p className="hands-free-consent">{mode === 'interview' ? HANDS_FREE_CONSENT : 'Audio is sent to your transcription provider while listening. Start only when you are ready.'}</p><div className="overlay-listening-control">{mode === 'interview' ? <HandsFreeButton state={state} busy={busy} start={startHandsFree} stop={stop}/> : <button className="button subtle small" disabled={!!busy} onClick={() => { void (captureOwned ? stop() : start()) }}>{captureOwned ? <Square size={12}/> : <Mic size={14}/>} {captureOwned ? 'Stop listening' : 'Start listening'}</button>}{captureOwned && <button className="button subtle small" disabled={!!busy} onClick={() => { void run(paused ? 'Resuming capture' : 'Pausing capture', () => paused ? window.faangin.resumeCapture(state.capture.sessionId!) : window.faangin.pauseCapture()) }}>{paused ? <Play size={12}/> : <Pause size={12}/>} {paused ? 'Resume listening' : 'Pause listening'}</button>}</div>{mode === 'interview' && <LiveSuggestionStatus state={state} busy={busy} run={run}/>}</section>
        <section className="overlay-menu-section"><h2>Assistance</h2><AnswerLatestButton mode={mode} hasQuestion={replyReady} working={working} busy={!!busy} updatingQuestion={!!activeAnswer || latestAnswerIsInterrupted(session?.answers ?? []) || answerQuestionUpdated(session?.answers.at(-1), session?.transcript ?? [], state.settings.liveSuggestionSource)} onClick={() => { void answerLatest() }}/><button className="overlay-menu-row" aria-pressed={state.settings.smartMode} title={displayModel(state)} onClick={() => { void smart(!state.settings.smartMode) }}><Zap size={14}/><span>Smart answers</span><span>{state.settings.smartMode ? 'On' : 'Off'}</span></button></section>
        <section className="overlay-menu-section"><h2>Screen & context</h2><button className="overlay-menu-row" disabled={working || !!busy} onClick={() => { void captureRegion() }}><Crop size={14}/><span>Capture a region</span></button><button className="overlay-menu-row" disabled={working || !!busy} onClick={() => { void importImage() }}><ImagePlus size={14}/><span>Import screenshot</span></button>{selectedAttachmentIds.length > 0 && <button className="overlay-menu-row" disabled={working || !!busy} onClick={() => { void generate('solve', draftPrompt.trim()) }}><Code2 size={14}/><span>Solve selected screenshots</span><span>{selectedAttachmentIds.length}</span></button>}</section>
        <section className="overlay-menu-section"><h2>Overlay</h2><OverlayInteractionButton enabled={passThrough} busy={!!busy} recovery={interactionRecovery.hint} onChange={enabled => run('Updating interaction', () => window.faangin.setClickThrough(enabled), false)}/><p className="overlay-menu-hint">{interactionRecovery.hint}</p><button className="overlay-menu-row" onClick={() => { void run('Opening workspace', () => window.faangin.openWindow('workspace'), false) }}><Maximize2 size={14}/><span>Open workspace</span></button><button className="overlay-menu-row" onClick={() => { void run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false) }}><Settings2 size={14}/><span>Audio, shortcuts & settings</span></button><button className="overlay-menu-row" onClick={() => { void run('Hiding overlay', () => window.faangin.hideOverlay(), false) }}><PanelLeftClose size={14}/><span>Hide overlay</span></button></section>
      </OverlayHeader>
      {error && <Banner kind="error" message={error} dismiss={() => setError('')}/>}
      {!state.chatConfigured && <button className="overlay-onboarding" onClick={() => { void run('Opening settings', () => window.faangin.openWindow('workspace', 'settings'), false) }}><ShieldCheck size={16}/><span>Connect your chat provider to get started</span><ArrowUpRight size={14}/></button>}
      {captureOwned && (questionHealth.unavailable || questionHealth.waiting) && <button className="overlay-context-status" onClick={() => { void run('Opening audio settings', () => window.faangin.openWindow('workspace', 'settings'), false) }}><Volume2 size={13}/><span>{questionHealth.headline}</span><ArrowUpRight size={12}/></button>}
      {captureOwned && state.settings.liveSuggestions && state.liveSuggestions?.phase === 'paused' && !questionHealth.unavailable && <div className="overlay-automatic-notice"><AutomaticHelpStatus state={state} busy={!!busy} resume={() => run('Resuming automatic help', () => window.faangin.updateSettings({ liveSuggestions: true }))}/></div>}
      <div className="overlay-answer">{session?.answers.length ? <AnswerCard answer={session.answers[session.answers.length - 1]} copy={copy} cancel={() => cancel(session.answers[session.answers.length - 1].requestId)} retry={answer => generate(answer.action, answer.prompt)} current={!session.answers[session.answers.length - 1].interruption} questionUpdated={answerQuestionUpdated(session.answers.at(-1), session.transcript, state.settings.liveSuggestionSource)} compact/> : <div className="overlay-empty"><span className="overlay-empty-glyph"><Monitor size={21}/></span><p>One shortcut. A clear answer.</p><span>Capture the problem and solve it in one step.</span>{captureShortcut ? <kbd>{captureShortcut}<span>Capture & solve</span></kbd> : <span className="overlay-shortcut-unavailable">Set your shortcut in Settings → Capture & shortcuts.</span>}<small>For conversation help, start hands-free in More.</small></div>}</div>
      <Composer {...common} compact/>
      {!state.settings.overlayCollapsed && <OverlayResize onError={setError}/>}
      {regionDialog}
      {notice && <div className="overlay-feedback" role="status">{notice}</div>}
    </div>
  }

  if (onboardingOpen !== false) return <div className={`app onboarding-app ${appearanceClasses}`} style={style}>
    {onboardingOpen && <Onboarding state={state} replay={replayingOnboarding} onRefresh={refresh} onComplete={selectedMode => { setDefaultMode(selectedMode); setOnboardingOpen(false); setReplayingOnboarding(false); setView('workspace') }} onConnect={() => { setSettingsSection('connection'); setView('settings') }}/>}
    {systemAudioNoticeDialog}
  </div>

  return <div className={`app ${appearanceClasses}`} style={style}>
    <aside className="sidebar"><div className="sidebar-brand"><Brand/></div><div className="sidebar-label">YOUR SPACE</div><nav aria-label="Main navigation"><NavButton icon={Layers3} label="Workspace" selected={view === 'workspace'} onClick={() => setView('workspace')}/><NavButton icon={BookOpen} label="Library" count={state.sessions.filter(s => !s.deletedAt).length} selected={view === 'library'} onClick={() => setView('library')}/><NavButton icon={Settings2} label="Settings" selected={view === 'settings'} onClick={() => setView('settings')}/></nav>
      <div className="sidebar-recent"><div className="sidebar-label">RECENT SESSIONS<button aria-label="Create new session" onClick={() => { void createSession() }}><Plus size={14}/></button></div>{state.sessions.filter(s => !s.deletedAt).slice(0, 5).map(item => <button key={item.id} className={`recent-session ${session?.id === item.id ? 'selected' : ''}`} onClick={() => { void openSession(item.id) }}><span className="recent-icon">{item.mode === 'meeting' ? <AudioLines size={15}/> : <Code2 size={15}/>}</span><span><strong>{item.title}</strong><small>{shortDate(item.updatedAt)}</small></span></button>)}{!state.sessions.length && <p className="sidebar-empty">Your sessions will appear here.</p>}</div>
      <div className="sidebar-bottom"><button className="overlay-launch" onClick={() => { void openOverlay() }}><span className="overlay-mini"><span/><span/></span><span>Open floating overlay<small>Keep your focus in the room</small></span><ArrowUpRight size={15}/></button><div className="local-label"><ShieldCheck size={13}/><span>Local workspace</span><span className="version">v{state.version}</span></div></div>
    </aside>
    <div className="app-body"><header className="topbar"><div><span className="breadcrumb">Your space <span>/</span></span><strong>{view === 'workspace' ? 'Workspace' : view === 'library' ? 'Session library' : 'Settings'}</strong></div><div className="topbar-right"><span className={`provider-status ${state.chatConfigured ? 'connected' : ''}`}><span className="status-dot"/>{state.chatConfigured ? (state.settings.chatProvider === 'compatible' ? 'Compatible chat configured' : 'OpenAI configured') : 'Chat provider needs setup'}</span><button className="button subtle small" onClick={() => { void createSession() }} disabled={!!busy}><Plus size={15}/>New session</button></div></header>
      {!!state.storageWarnings?.length && <div className="notification-area"><p role="alert" className="context-notice">Some local records need recovery. Their files were preserved. Review Settings and export diagnostic metadata before repairing the workspace.</p></div>}
      {session?.persistent === false && <div className="notification-area"><p role="status" className="context-notice">Temporary session · new data is kept in memory until Faangin closes. Turning history on does not save it; export to keep a copy.</p></div>}
      {(error || notice) && <div className="notification-area">{error && <Banner kind="error" message={error} dismiss={() => setError('')}/>}{notice && <Banner kind="success" message={notice} dismiss={() => setNotice('')}/>}</div>}
      {view === 'workspace' && <Workspace {...common} partials={Object.values(partials).filter(item => item.sessionId === session?.id)} levels={levels} transcriptOpen={transcriptOpen} setTranscriptOpen={setTranscriptOpen} openSettings={(section = 'connection') => { setSettingsSection(section); setView('settings') }} openOverlay={state.overlayClickThrough ? makeOverlayInteractive : openOverlay}/>}
      {view === 'library' && <Library state={state} run={run} openSession={openSession} createSession={() => createSession()} notify={setNotice}/>}
      {view === 'settings' && <Settings initialSection={settingsSection} state={state} run={run} notify={setNotice} onReplayOnboarding={() => { setReplayingOnboarding(true); setOnboardingOpen(true) }}/>}
    </div>
    {regionDialog}
    {requestedReset && <Modal title="Reset this session’s context?" description="This clears its transcript, screenshots, interview brief, selected prior context, notes, and answers." onClose={() => setRequestedReset(false)}><div className="modal-actions"><button className="button subtle" onClick={() => setRequestedReset(false)}>Keep context</button><button className="button danger" disabled={!session || !!busy} onClick={() => { if (session) void run('Resetting context', () => window.faangin.resetContext(session.id)); setRequestedReset(false) }}>Reset context</button></div></Modal>}
    {systemAudioNoticeDialog}
  </div>
}

function NavButton({ icon: Icon, label, selected, count, onClick }: { icon: typeof Layers3; label: string; selected: boolean; count?: number; onClick: () => void }) {
  return <button className={`nav-button ${selected ? 'selected' : ''}`} onClick={onClick} aria-current={selected ? 'page' : undefined}><Icon size={18}/><span>{label}</span>{count !== undefined && <small>{count}</small>}</button>
}

function Banner({ message, kind, dismiss }: { message: string; kind: 'error' | 'success'; dismiss: () => void }) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{kind === 'success' ? <Check size={16}/> : <CircleHelp size={16}/>}<span>{message}</span><IconButton label="Dismiss message" onClick={dismiss}><X size={14}/></IconButton></div>
}

interface CommonProps {
  state: AppState
  session: Session | null
  mode: WorkspaceMode
  busy: string
  working: boolean
  activeAnswer: Answer | undefined
  generate: (action: Action, prompt?: string, attachmentIds?: string[], replaceActive?: boolean) => Promise<boolean>
  answerLatest: () => Promise<boolean>
  capture: () => Promise<unknown>
  captureAndSolve: () => Promise<unknown>
  captureRegion: () => Promise<unknown>
  importImage: () => Promise<unknown>
  start: () => Promise<unknown>
  startHandsFree: () => Promise<unknown>
  stop: () => Promise<unknown>
  run: Run
  copy: (text: string, message?: string) => Promise<void>
  changeMode: (mode: WorkspaceMode) => void
  smart: (enabled: boolean) => Promise<unknown>
  cancel: (requestId: string) => Promise<unknown>
  selectedAttachmentIds: string[]
  setSelectedAttachmentIds: (value: string[]) => void
  draftPrompt: string
  setDraftPrompt: (value: string) => void
  notify: (message: string) => void
}

function Workspace(props: CommonProps & { partials: PartialTurn[]; levels: { microphone: number; system: number }; transcriptOpen: boolean; setTranscriptOpen: (value: boolean) => void; openSettings: (section?: SettingsSection) => void; openOverlay: () => Promise<unknown> }) {
  const { state, session, mode, busy, working, activeAnswer, generate, run, copy, changeMode, start, stop, partials, levels, transcriptOpen, setTranscriptOpen, openSettings, draftPrompt } = props
  const [tab, setTab] = useState<'answers' | 'notes' | 'interview' | 'context'>('answers')
  const [reset, setReset] = useState(false)
  const [title, setTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [openManualCount, setOpenManualCount] = useState(0)
  const answerScroll = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const [answerUpdatesWaiting, setAnswerUpdatesWaiting] = useState(false)
  useEffect(() => { setTab('answers'); setEditingTitle(false); setAnswerUpdatesWaiting(false); followBottom.current = true }, [session?.id])
  useEffect(() => {
    const reveal = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== session?.id) return
      const focused = document.activeElement
      // Preserve the editor's focus and draft when a suggestion arrives during typing.
      if (focused instanceof HTMLElement && focused.matches('input, textarea, select, [contenteditable="true"]')) return
      setTab('answers')
    }
    window.addEventListener('faangin-automatic-answer', reveal)
    return () => window.removeEventListener('faangin-automatic-answer', reveal)
  }, [session?.id])
  useEffect(() => {
    const el = answerScroll.current
    if (!el) return
    const editing = document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable="true"]')
    if (shouldFollowAnswerUpdates(followBottom.current, editing)) { el.scrollTop = el.scrollHeight; setAnswerUpdatesWaiting(false) }
    else if (session?.answers.length) setAnswerUpdatesWaiting(true)
  }, [session?.answers])
  const showCurrentAnswer = () => {
    setTab('answers')
    const el = answerScroll.current
    const current = el?.querySelector<HTMLElement>('[data-current-answer="true"], .answer-card:last-child')
    if (el && current) el.scrollTop += current.getBoundingClientRect().top - el.getBoundingClientRect().top
    setAnswerUpdatesWaiting(false)
  }
  const questionHealth = questionSourceHealth(state.settings, state.capture)
  const saveTitle = () => { setEditingTitle(false); if (session && title.trim() && title.trim() !== session.title) void run('Renaming session', () => window.faangin.updateSession(session.id, { title: title.trim() })) }
  return <main className="workspace"><section className={`workspace-main ${mode === 'interview' ? 'interview-workspace' : ''}`}><div className="session-heading"><div className="session-identity"><span className="eyebrow">{questionHealth.unavailable && state.capture.sessionId === session?.id ? 'QUESTION AUDIO UNAVAILABLE' : questionHealth.waiting && state.capture.sessionId === session?.id ? 'WAITING FOR AUDIO' : questionHealth.listening && state.capture.sessionId === session?.id ? 'LIVE SESSION' : state.capture.sessionId === session?.id && state.capture.sessionId !== null ? (session?.status === 'paused' ? 'PAUSED SESSION' : 'CONNECTING SOURCES') : session?.endedAt ? 'SAVED SESSION' : 'READY WHEN YOU ARE'}</span><div className="session-title">{editingTitle ? <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }} aria-label="Session title"/> : <button onClick={() => { if (session) { setTitle(session.title); setEditingTitle(true) } else { void run('Creating session', () => window.faangin.createSession(mode)) } }} title={session ? 'Rename session' : 'Start a new session'}>{session?.title || 'A fresh perspective'}{session && <MoreHorizontal size={16}/>}</button>}</div></div><div className="session-controls"><div className="mode-switch" role="group" aria-label="Session mode"><button className={mode === 'meeting' ? 'active' : ''} onClick={() => changeMode('meeting')} disabled={!!state.capture.sessionId || !!busy}><AudioLines size={14}/>Meeting</button><button className={mode === 'interview' ? 'active' : ''} onClick={() => changeMode('interview')} disabled={!!state.capture.sessionId || !!busy}><Code2 size={14}/>Interview</button></div><IconButton label={transcriptOpen ? 'Hide transcript panel' : 'Show transcript panel'} onClick={() => setTranscriptOpen(!transcriptOpen)}>{transcriptOpen ? <PanelRightClose size={18}/> : <PanelRightOpen size={18}/>}</IconButton></div></div>
      <div className="session-toolbar"><div className="session-tabs" role="tablist" aria-label="Session content"><button role="tab" aria-selected={tab === 'answers'} className={tab === 'answers' ? 'active' : ''} onClick={() => setTab('answers')}><Sparkles size={14}/>Assistance{session?.answers.length ? <span>{session.answers.length}</span> : null}</button><button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}><FileText size={14}/>Notes</button>{mode === 'interview' && <button role="tab" aria-selected={tab === 'interview'} className={tab === 'interview' ? 'active' : ''} onClick={() => setTab('interview')}><Code2 size={14}/>Interview brief</button>}<button role="tab" aria-selected={tab === 'context'} className={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}><Layers3 size={14}/>Context & presets</button></div><div className="session-tools"><button className="text-button" onClick={() => { void props.openOverlay() }}><ArrowUpRight size={14}/>{state.overlayClickThrough ? 'Make overlay interactive' : 'Overlay'}</button><IconButton label="Reset session context" disabled={!session || working || !!state.capture.sessionId} onClick={() => setReset(true)}><RotateCcw size={15}/></IconButton></div></div>
      {mode === 'interview' && <InterviewFlow {...props} partials={partials} revealAnswers={() => { followBottom.current = true; setAnswerUpdatesWaiting(false); setTab('answers') }} revealConversation={() => setTranscriptOpen(true)}/>}
      {!state.chatConfigured && <div className="setup-banner"><span className="setup-icon"><ShieldCheck size={20}/></span><div><strong>Your workspace, connected on your terms.</strong><p>Choose your chat provider in Settings. Provider keys are encrypted on this device.</p></div><button className="button primary small" onClick={() => openSettings()}>Set up Faangin<ArrowUpRight size={14}/></button></div>}
      {tab === 'answers' ? <><div className="answer-feed" ref={answerScroll} onScroll={() => { const el = answerScroll.current; if (el) { followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (followBottom.current) setAnswerUpdatesWaiting(false) } }}>
        {session?.answers.length ? <div className="answer-list">{session.answers.map((answer, index) => <AnswerCard key={answer.id} answer={answer} current={index === session.answers.length - 1 && !answer.interruption} questionUpdated={mode === 'interview' && answerQuestionUpdated(answer, session.transcript, state.settings.liveSuggestionSource)} copy={copy} cancel={() => props.cancel(answer.requestId)} retry={answer => generate(answer.action, answer.prompt)}/> )}</div> : <div className="workspace-empty"><div className="ambient-orbit" aria-hidden="true"><div className="orbit-ring ring-one"/><div className="orbit-ring ring-two"/><div className="orbit-core"><Brand compact/></div><span className="orbit-point p1"/><span className="orbit-point p2"/><span className="orbit-point p3"/></div><span className="eyebrow">A LITTLE SUPPORT. A LOT OF CLARITY.</span><h1>{mode === 'meeting' ? <>Stay in the conversation.<br/><span>We’ll keep up with you.</span></> : <>Make room for your thinking.<br/><span>Work the problem, together.</span></>}</h1><p>{mode === 'meeting' ? 'Start listening, add a little context, or ask what’s on your mind.' : 'Start hands-free to follow both sides of the conversation and get help automatically. Capture a problem whenever you need a solution.'}</p><div className="empty-actions">{mode === 'interview' ? <button className="button subtle" onClick={() => { void props.captureAndSolve() }} disabled={!!busy || working}><Monitor size={16}/>Capture & solve</button> : <button className="button primary" onClick={() => { void start() }} disabled={!!busy}><Mic size={16}/>Start listening</button>}<button className="button subtle" onClick={() => { if (mode === 'interview') void props.importImage(); else { setTranscriptOpen(true); setOpenManualCount(value => value + 1) } }}>{mode === 'meeting' ? <MessageSquare size={16}/> : <ImagePlus size={16}/>} {mode === 'meeting' ? 'Add conversation context' : 'Import an image'}</button></div></div>}
        {answerUpdatesWaiting && <div className="answer-update-jump"><button className="button subtle small" onClick={showCurrentAnswer}><ArrowDownToLine size={13}/>View latest answer</button></div>}
      </div><div className="workspace-bottom"><div className="quick-actions" aria-label="Assistance actions">{actions.filter(item => (!item.mode || item.mode === mode) && (mode !== 'interview' || ['hint', 'review', 'debug', 'design', 'behavioral'].includes(item.action))).map(item => <button key={item.action} title={item.description} disabled={working || !!busy} onClick={() => { void generate(item.action, draftPrompt.trim()) }}><item.icon size={15}/><span>{item.label}</span>{item.action === 'assist' && <kbd>⌘ ↵</kbd>}</button>)}</div><Composer {...props}/><div className="composer-caption"><span><ShieldCheck size={11}/>{state.settings.liveSuggestions ? "Automatic help sends conversation context while listening." : "Conversation context is sent only when you ask."}</span><span>{activeAnswer || working ? <Spinner label="Thinking"/> : `${state.settings.smartMode ? 'Smart' : 'Fast'} · ${displayModel(state)}`}</span></div></div></> : tab === 'context' ? <SessionContext key={`${session?.id}:${session?.contextEpoch}`} state={state} session={session} busy={!!busy}/> : null}
      {mode === 'interview' && <div className="session-editor-panel" hidden={tab !== 'interview'}><InterviewEditor key={`${session?.id}:${session?.contextEpoch}`} session={session} busy={!!busy} save={async brief => { const result = await run('Saving interview brief', async () => { const current = session || await window.faangin.createSession('interview'); return window.faangin.updateSession(current.id, { interview: brief }) }); return !!result }}/></div>}
      <div className="session-editor-panel" hidden={tab !== 'notes'}><NotesEditor key={`${session?.id}:${session?.contextEpoch}`} session={session} busy={busy} run={run} generate={generate} copy={copy} working={working} cancel={props.cancel}/></div>
    </section>
    {transcriptOpen && <TranscriptPanel state={state} session={session} mode={mode} partials={partials} levels={levels} busy={busy} working={working} run={run} start={start} startHandsFree={props.startHandsFree} stop={stop} followupPrompt={draftPrompt} reply={() => { setTab('answers'); return props.answerLatest() }} copy={copy} openSettings={openSettings} openManualCount={openManualCount}/>}
    {reset && <Modal title="Reset this session’s context?" description="This clears the current transcript, screenshots, interview brief, notes, and answers. Your other saved sessions stay in the Library." onClose={() => setReset(false)}><div className="modal-actions"><button className="button subtle" onClick={() => setReset(false)}>Keep context</button><button className="button danger" onClick={() => { if (session) void run('Resetting context', () => window.faangin.resetContext(session.id)); setReset(false) }}><RotateCcw size={15}/>Reset context</button></div></Modal>}
  </main>
}

function InterviewFlow(props: CommonProps & { partials: PartialTurn[]; revealAnswers?: () => void; revealConversation?: () => void; compact?: boolean }) {
  const { state, session, busy, working, partials, compact } = props
  const listening = state.capture.sessionId !== null
  const replyReady = hasReplyContext(session, state.capture, partials)
  const selectedImages = props.selectedAttachmentIds.length
  const reply = () => { props.revealAnswers?.(); void props.answerLatest() }
  const questionUpdated = answerQuestionUpdated(session?.answers.at(-1), session?.transcript ?? [], state.settings.liveSuggestionSource)
  const updatingQuestion = !!props.activeAnswer || latestAnswerIsInterrupted(session?.answers ?? []) || questionUpdated
  return <section className={`interview-flow ${compact ? 'compact' : ''}`} aria-label="Interview workflow">
    {!compact && <div className="interview-flow-intro"><strong>Listen → understand → help</strong><span>{questionUpdated ? state.settings.liveSuggestions && listening ? 'The question changed. Automatic help follows the new context.' : 'Updated question received. Choose Answer latest.' : session?.answers.some(answer => answer.status === 'complete') ? 'Follow-ups keep your current solution in context.' : 'Start once. Both sides stay in context and help appears when needed.'}</span></div>}
    <div className="interview-flow-actions">
      <HandsFreeButton state={state} busy={busy} start={async () => { props.revealConversation?.(); await props.startHandsFree() }} stop={props.stop}/>
      <button className="button subtle small" disabled={working || !!busy} onClick={() => { props.revealAnswers?.(); void props.captureAndSolve() }}><Monitor size={14}/>{busy === 'Capturing and solving' ? 'Capturing…' : 'Capture & solve'}</button>
      {selectedImages > 0 && <button className="button subtle small" disabled={working || !!busy} onClick={() => { props.revealAnswers?.(); void props.generate('solve', props.draftPrompt.trim()) }}><Code2 size={14}/>Solve selected</button>}
      <AnswerLatestButton mode={props.mode} hasQuestion={replyReady || !!props.draftPrompt.trim()} working={working} busy={!!busy} updatingQuestion={updatingQuestion} onClick={reply}/>
    </div>
    <p className="hands-free-consent">{HANDS_FREE_CONSENT}</p>
    <LiveSuggestionStatus state={state} busy={busy} run={props.run}/>
  </section>
}

function QuestionSourceControls({ state, busy, run, compact = false, enableOnStart = true }: { state: AppState; busy: string; run: Run; compact?: boolean; enableOnStart?: boolean }) {
  const source = state.settings.liveSuggestionSource
  const owned = state.capture.sessionId !== null
  const enabled = source === 'system' ? state.settings.systemAudio : state.settings.microphone
  return <div className={`question-source-controls ${compact ? 'compact' : ''}`}>
    <label className="question-source-field"><span>Question audio</span><select aria-label="Question audio source" value={source} disabled={owned || !!busy} onChange={event => { void run('Updating question audio', () => window.faangin.updateSettings(questionSourcePatch(event.target.value as 'microphone' | 'system'))) }}><option value="system">Remote call · interviewer audio</option><option value="microphone">In person · room microphone</option></select></label>
    {!compact && <label className="capture-extra-source"><input type="checkbox" checked={enabled && (source === 'system' ? state.settings.microphone : state.settings.systemAudio)} disabled={owned || !!busy} onChange={event => { const patch = source === 'system' ? { microphone: event.target.checked } : { systemAudio: event.target.checked }; void run('Updating audio sources', () => window.faangin.updateSettings({ ...questionSourcePatch(source), ...patch })) }}/>{source === 'system' ? 'Also capture my microphone' : 'Also capture computer audio'}</label>}
    {owned ? <p>Stop listening to change audio inputs.</p> : !enabled ? enableOnStart ? <p>Listen only enables this question source. Start hands-free enables both inputs.</p> : <button className="text-button" disabled={!!busy} onClick={() => { void run('Updating question audio', () => window.faangin.updateSettings(questionSourcePatch(source))) }}>Enable question audio</button> : null}
    {compact && <Toggle label="Automatic replies" description="Sends conversation context to your chat provider while listening; uses provider credits. Screenshots stay manual." checked={state.settings.liveSuggestions} disabled={!!busy} onChange={value => { void run('Updating live suggestions', () => window.faangin.updateSettings({ liveSuggestions: value })) }}/>}
  </div>
}


function Composer(props: CommonProps & { compact?: boolean }) {
  const { state, session, working, busy, generate, capture, captureRegion, importImage, run, compact, selectedAttachmentIds, setSelectedAttachmentIds, draftPrompt: prompt, setDraftPrompt: setPrompt } = props
  const [preview, setPreview] = useState<Attachment | null>(null)
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false)
  const showAttachments = attachmentTrayVisible(!!compact, selectedAttachmentIds.length, attachmentsExpanded)
  const attachmentSummary = attachmentSelectionSummary(selectedAttachmentIds.length, session?.attachments.length ?? 0)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setPreview(null); setAttachmentsExpanded(false) }, [session?.id])
  useEffect(() => { if (!selectedAttachmentIds.length) setAttachmentsExpanded(false) }, [selectedAttachmentIds.length])
  const submit = async () => { if (working || busy || (!prompt.trim() && !selectedAttachmentIds.length)) return; await generate(prompt.trim() ? 'ask' : props.mode === 'interview' ? 'solve' : 'assist', prompt.trim(), selectedAttachmentIds) }
  const resize = () => { const el = textarea.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, compact ? 110 : 150)}px` } }
  return <><div className={`composer ${compact ? 'compact' : ''}`}>
    {!!session?.attachments.length && !showAttachments && <button className="attachment-collapsed-summary" aria-expanded={false} aria-label={`${attachmentSummary}. Show screenshots`} title="Review which screenshots are included in requests" onClick={() => setAttachmentsExpanded(true)}><ImagePlus size={13}/><span>{attachmentSummary}</span><ChevronDown size={13}/></button>}
    {!!session?.attachments.length && showAttachments && <div className="attachment-tray"><div className="attachment-list">{session.attachments.map((attachment, index) => <div className={`attachment ${selectedAttachmentIds.includes(attachment.id) ? 'selected' : ''}`} key={attachment.id}>
      <button className="attachment-preview" onClick={() => setPreview(attachment)} title={`Preview ${attachment.name}`}><img src={attachment.dataUrl} alt={attachment.name}/><span>{index + 1}</span></button>
      <IconButton label={`Remove ${attachment.name}`} disabled={!!busy} onClick={() => { void run('Removing image', () => window.faangin.removeAttachment(session.id, attachment.id)) }}><X size={11}/></IconButton>
      <div className="attachment-order"><IconButton label={`Move ${attachment.name} earlier`} disabled={!!busy || index === 0} onClick={() => { const ids = session.attachments.map(image => image.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void run('Reordering images', () => window.faangin.reorderAttachments(session.id, ids)) }}><ArrowLeft size={11}/></IconButton><IconButton label={`Move ${attachment.name} later`} disabled={!!busy || index === session.attachments.length - 1} onClick={() => { const ids = session.attachments.map(image => image.id); [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]; void run('Reordering images', () => window.faangin.reorderAttachments(session.id, ids)) }}><ArrowRight size={11}/></IconButton></div>
      <label className="attachment-select" title={selectedAttachmentIds.includes(attachment.id) ? 'Included in requests' : 'Include this image'}><input type="checkbox" aria-label={`Include ${attachment.name} in requests`} checked={selectedAttachmentIds.includes(attachment.id)} disabled={!!busy || (!selectedAttachmentIds.includes(attachment.id) && selectedAttachmentIds.length >= 4)} onChange={e => setSelectedAttachmentIds(e.target.checked ? [...selectedAttachmentIds, attachment.id] : selectedAttachmentIds.filter(id => id !== attachment.id))}/></label>
    </div>)}</div><div className="attachment-summary"><span>{selectedAttachmentIds.length}/4 selected · ordered left to right</span>{(compact || !selectedAttachmentIds.length) && <button aria-expanded={true} onClick={() => setAttachmentsExpanded(false)}>Collapse screenshots<ChevronUp size={11}/></button>}<button onClick={() => { void run('Clearing images', async () => { for (const image of session.attachments) await window.faangin.removeAttachment(session.id, image.id) }) }} disabled={!!busy}>Clear images</button></div></div>}
    <textarea ref={textarea} value={prompt} rows={compact || props.mode === 'interview' ? 1 : 2} aria-label="Ask Faangin" placeholder={state.chatConfigured ? compact ? 'Ask a follow-up…' : props.mode === 'interview' ? 'Type a question or follow-up, e.g. Why BFS instead of DFS?' : 'Ask anything about this moment…' : 'Configure your chat provider in Settings…'} onChange={e => { setPrompt(e.target.value); resize() }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const action = e.shiftKey ? 'solve' : 'assist'; const request = composerShortcutRequest({ prompt, solve: e.shiftKey, working, busy: !!busy, registeredShortcut: hasRegisteredActionShortcut(state.shortcuts, action) }); if (request) void generate(request.action, request.prompt, selectedAttachmentIds) } }}/>
    <div className="composer-toolbar"><div className="composer-tools" hidden={compact}><button onClick={() => { void capture() }} disabled={!!busy || working} title="Take a screenshot of the selected screen"><Monitor size={15}/>{!compact && <span>Capture screen</span>}</button><IconButton label="Capture a region" disabled={!!busy || working} onClick={() => { void captureRegion() }}><Crop size={16}/></IconButton><IconButton label="Import screenshot" disabled={!!busy || working} onClick={() => { void importImage() }}><ImagePlus size={16}/></IconButton><span className="context-chip"><AudioLines size={12}/>{session?.transcript.length ? `${session.transcript.length} context turns` : 'Session context'}</span></div><div className="composer-send"><button hidden={compact} className={`smart-toggle ${state.settings.smartMode ? 'active' : ''}`} onClick={() => { void props.smart(!state.settings.smartMode) }} title={`Use ${displayModel(state, !state.settings.smartMode)}`}><Zap size={13}/>{state.settings.smartMode ? 'Smart' : 'Fast'}<ChevronDown size={11}/></button><button className="send-button" aria-label={prompt.trim() ? 'Send question' : 'Solve selected screenshots'} title={prompt.trim() ? 'Send · Command+Enter' : 'Solve selected screenshots'} onClick={() => { void submit() }} disabled={(!prompt.trim() && !selectedAttachmentIds.length) || working || !!busy}>{working ? <LoaderCircle size={15} className="spin"/> : <Send size={15}/>}</button></div></div>
  </div>{preview && <Modal title={preview.name} description={`${preview.width} × ${preview.height} pixels · included only when you request assistance`} onClose={() => setPreview(null)}><img className="image-preview" src={preview.dataUrl} alt={preview.name}/></Modal>}</>
}

function TranscriptPanel({ state, session, mode, partials, levels, busy, working, run, start, startHandsFree, stop, reply, copy, openSettings, openManualCount, followupPrompt }: { state: AppState; session: Session | null; mode: WorkspaceMode; partials: PartialTurn[]; levels: { microphone: number; system: number }; busy: string; working: boolean; run: Run; start: () => Promise<unknown>; startHandsFree: () => Promise<unknown>; stop: () => Promise<unknown>; reply: () => Promise<boolean>; copy: (text: string) => Promise<void>; openSettings: (section?: SettingsSection) => void; openManualCount: number; followupPrompt: string }) {
  const [manual, setManual] = useState('')
  const [adding, setAdding] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { setManual(''); setAdding(false) }, [session?.id])
  useEffect(() => { if (openManualCount) setAdding(true) }, [openManualCount])
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [session?.transcript, partials])
  const add = async () => { if (!manual.trim()) return; const text = manual.trim(); const result = await run('Adding context', async () => { const current = session || await window.faangin.createSession(mode); return window.faangin.appendTranscript(current.id, text) }); if (result) { setManual(''); setAdding(false) } }
  useEffect(() => { const listener = () => { void add() }; window.addEventListener('faangin-add-context', listener); return () => window.removeEventListener('faangin-add-context', listener) })
  const captureBusy = busy === 'Starting hands-free' || busy === 'Starting capture' || busy === 'Stopping capture' || busy === 'Pausing capture' || busy === 'Resuming capture' || session?.status === 'starting' || session?.status === 'stopping'
  const paused = state.capture.sessionId !== null && [state.capture.microphone, state.capture.system].includes('Paused')
  const captureOwned = state.capture.sessionId !== null
  const questionHealth = questionSourceHealth(state.settings, state.capture)
  const replyContext = hasReplyContext(session, state.capture, partials) || !!followupPrompt.trim()
  const updatingQuestion = !!session?.answers.some(answer => answer.status === 'streaming') || latestAnswerIsInterrupted(session?.answers ?? []) || answerQuestionUpdated(session?.answers.at(-1), session?.transcript ?? [], state.settings.liveSuggestionSource)
  return <aside className="transcript-panel"><div className="transcript-heading"><div><span className="eyebrow">LIVE CONTEXT</span><h2>Conversation</h2></div><IconButton label="Copy transcript" disabled={!session?.transcript.length} onClick={() => { void copy(session!.transcript.map(turn => `[${shortTime(turn.timestamp)} · ${turn.channel}] ${turn.text}`).join('\n\n')) }}><Copy size={15}/></IconButton></div>
    <div className="capture-card">
      <div className="capture-label" role="status"><span className={`status-dot ${questionHealth.listening ? 'live' : ''}`}/><strong>{questionHealth.unavailable ? questionHealth.headline : captureBusy ? busy || 'Updating capture' : captureOwned && state.capture.sessionId !== session?.id ? 'Listening in another session' : questionHealth.headline}</strong></div>
      <AudioMeter label="Microphone" icon={Mic} level={levels.microphone} enabled={state.settings.microphone} status={state.capture.microphone}/>
      <AudioMeter label="Computer audio" icon={Volume2} level={levels.system} enabled={state.settings.systemAudio} status={state.capture.system}/>
      {captureOwned && (['microphone', 'system'] as const).map(source => {
        const enabled = source === 'system' ? state.settings.systemAudio : state.settings.microphone
        if (!enabled) return null
        const guidance = audioInputGuidance(source, true, source === 'system' ? state.capture.system : state.capture.microphone, source === 'system' ? state.permissions.screen : state.permissions.microphone)
        return guidance ? <p className="audio-guidance" key={source} role="status">{source === 'system' ? 'Computer audio' : 'Microphone'}: {guidance}</p> : null
      })}
      <div className="capture-actions">{mode === 'interview' ? <HandsFreeButton state={state} busy={busy} start={startHandsFree} stop={stop} className="button primary capture-button"/> : <button className={`button ${captureOwned ? 'record-stop' : 'primary'} capture-button`} onClick={() => { void (captureOwned ? stop() : start()) }} disabled={!!busy && !(captureOwned && busy === 'Starting capture')}>{captureBusy ? <LoaderCircle size={14} className="spin"/> : captureOwned ? <Square size={12}/> : <Play size={14}/>} {captureOwned ? 'Stop listening' : 'Start listening'}</button>}{captureOwned && <button className="button subtle small" disabled={!!busy} onClick={() => { void run(paused ? 'Resuming capture' : 'Pausing capture', () => paused ? window.faangin.resumeCapture(state.capture.sessionId!) : window.faangin.pauseCapture()) }}>{paused ? <Play size={14}/> : <Pause size={14}/>} {paused ? 'Resume' : 'Pause'}</button>}</div>
      {mode === 'interview' && <p className="hands-free-consent">{HANDS_FREE_CONSENT}</p>}
      <details className="interview-audio-options" open={mode === 'meeting' || undefined}><summary>Audio inputs & manual controls</summary><QuestionSourceControls state={state} busy={busy} run={run} enableOnStart={mode === 'interview'}/>{mode === 'interview' && !captureOwned && <button className="button subtle small" disabled={!!busy} onClick={() => { void start() }}><Mic size={13}/>Listen only · use selected inputs</button>}
      <div className="live-suggestions-control"><Toggle label="Automatic replies" description="Automatically sends conversation context to your chat provider while listening and uses provider credits." checked={state.settings.liveSuggestions} disabled={!!busy} onChange={enabled => { void run('Updating live suggestions', () => window.faangin.updateSettings({ liveSuggestions: enabled })) }}/><p>{state.settings.liveSuggestions ? 'Help appears when the conversation needs it. You can still ask manually.' : 'Choose Answer follow-up to request help manually.'}</p><details><summary>What gets sent automatically</summary><p>Conversation text, current solution, saved background, brief, and selected history go to your chat provider while listening and incur usage. Screenshots are sent only when you request them. The audio source does not identify a speaker.</p></details></div></details>
      <LiveSuggestionStatus state={state} busy={busy} run={run}/>
      <AnswerLatestButton mode={mode} hasQuestion={replyContext} working={working} busy={!!busy} updatingQuestion={updatingQuestion} onClick={() => { void reply() }} className="button subtle full-width"/>
      <button className="capture-settings" onClick={() => openSettings('capture')}>Audio devices & permissions<ArrowUpRight size={11}/></button>
    </div>
    <div className="transcript-scroll" ref={scroll}>{session?.transcriptIncomplete && <p className="context-notice" role="status">This transcript may be incomplete. Some unfinished or disconnected speech was not saved.</p>}{session?.transcript.length || partials.length ? <>{session?.transcript.map(turn => <div className={`transcript-turn ${turn.channel}`} key={turn.id}><div><span>{turn.channel === 'microphone' ? 'Microphone' : turn.channel === 'system' ? 'System audio' : 'Added context'}</span><time>{shortTime(turn.timestamp)}</time></div><p>{turn.text}</p></div>)}{partials.map(turn => <div className="transcript-turn partial" key={`${turn.channel}:${turn.itemId}`}><div><span>{turn.channel === 'microphone' ? 'Microphone' : 'System audio'}</span><span className="partial-label">{state.capture.active && state.capture.sessionId === turn.sessionId ? 'Live' : 'Uncommitted'}</span></div><p>{turn.text}{state.capture.active && state.capture.sessionId === turn.sessionId && <span className="partial-cursor"/>}</p>{(!state.capture.active || state.capture.sessionId !== turn.sessionId) && <small className="partial-unsaved">Not saved or included in requests.</small>}</div>)}</> : <div className="transcript-empty"><AudioLines size={26}/><strong>The conversation starts here.</strong><p>Live transcription appears as people speak. You can also add written context.</p></div>}</div>
    <div className="transcript-bottom">{adding ? <div className="manual-context"><textarea autoFocus rows={4} aria-label="Manual conversation context" placeholder="Add a question, meeting context, or what was said…" value={manual} onChange={e => setManual(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!hasRegisteredActionShortcut(state.shortcuts, 'assist')) void add() }; if (e.key === 'Escape') setAdding(false) }}/><div><button className="text-button" onClick={() => setAdding(false)}>Cancel</button><button className="button primary small" onClick={() => { void add() }} disabled={!manual.trim() || !!busy}><Plus size={13}/>Add context</button></div></div> : <button className="button subtle full-width" onClick={() => setAdding(true)}><Plus size={15}/>Add context manually</button>}<span className="transcript-privacy"><ShieldCheck size={11}/>Raw audio is not saved.</span></div>
  </aside>
}

function LiveSuggestionStatus({ state, busy, run }: { state: AppState; busy: string; run: Run }) {
  return <AutomaticHelpStatus state={state} busy={!!busy} resume={() => run('Resuming automatic help', () => window.faangin.updateSettings({ liveSuggestions: true }))}/>
}

function AudioMeter({ label, icon: Icon, level, enabled, status }: { label: string; icon: typeof Mic; level: number; enabled: boolean; status: string }) {
  const lowerStatus = status.toLowerCase()
  const active = enabled && (['active', 'recording', 'connected', 'listening'].includes(lowerStatus) || lowerStatus.startsWith('silent') || lowerStatus.startsWith('low audio'))
  const degraded = enabled && ['muted', 'error', 'denied', 'blocked', 'unavailable', 'disconnected', 'no audio', 'low audio', 'failed', 'silent', 'could not', 'interrupted'].some(value => lowerStatus.includes(value))
  return <div className="audio-meter"><div><Icon size={13}/><span>{label}</span><small className={degraded ? 'degraded' : active ? 'active-text' : ''} title={status}>{!enabled ? 'Off' : active && !degraded ? 'Live' : status === 'idle' || !status ? 'Ready' : status}</small></div><div className="meter-bars" aria-label={`${label} input level ${Math.round(level * 100)} percent`}>{Array.from({ length: 26 }, (_, index) => <span key={index} className={active && level > index / 26 ? 'lit' : ''}/>)}</div></div>
}

function NotesEditor({ session, busy, run, generate, copy, working, cancel }: { session: Session | null; busy: string; run: Run; generate: (action: Action, prompt?: string) => Promise<unknown>; copy: (text: string) => Promise<void>; working: boolean; cancel: (requestId: string) => Promise<unknown> }) {
  const [notes, setNotes] = useState(session?.notes || '')
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  const revision = useRef(0)
  useEffect(() => { setNotes(session?.notes || ''); setDirty(false) }, [session?.id])
  useEffect(() => { if (!dirty) setNotes(session?.notes || '') }, [session?.notes, dirty])
  const save = async () => { if (session) { const submitted = revision.current; const result = await run('Saving notes', () => window.faangin.updateSession(session.id, { notes })); if (result && revision.current === submitted) setDirty(false) } }
  const draft = session?.answers.filter(answer => answer.action === 'draft').at(-1)
  return <div className="notes-editor"><div className="notes-intro"><div><h2>A useful record of the moment.</h2><p>Turn your session into decisions, next steps, and ideas to keep.</p></div><div className="note-generation-actions"><button className="button subtle small" disabled={working || !!busy || !session?.transcript.length} onClick={() => { void generate('draft') }}><FileText size={14}/>Draft follow-up</button><button className="button primary small" disabled={dirty || working || !!busy || !session?.transcript.length} title={dirty ? "Save your edits before generating notes." : undefined} onClick={() => { void generate('notes') }}><WandSparkles size={14}/>Generate notes</button></div></div>{draft && <section className="followup-draft"><p className="muted">A draft for you to review and copy. Uses finalized conversation only; your notes stay separate.</p><AnswerCard answer={draft} copy={copy} cancel={() => cancel(draft.requestId)} retry={answer => generate(answer.action, answer.prompt)}/></section>}<div className="notes-toolbar"><div className="segmented"><button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Edit</button><button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div><span className="muted">{dirty ? 'Unsaved changes' : 'Saved locally'}</span><IconButton label="Copy notes" disabled={!notes} onClick={() => { void copy(notes) }}><Copy size={14}/></IconButton><button className="button subtle small" disabled={!session || !dirty || !!busy} onClick={() => { void save() }}><Check size={14}/>Save notes</button></div>{preview ? <div className="notes-preview">{notes ? <MarkdownText text={notes}/> : <p className="muted">Your notes will appear here.</p>}</div> : <textarea aria-label="Session notes" value={notes} maxLength={200000} onChange={e => { revision.current++; setNotes(e.target.value); setDirty(true) }} placeholder="Write what matters. Markdown is supported.\n\n## Key takeaways\n\n## Decisions\n\n## Next steps" disabled={!session}/>}{!session && <p className="notes-empty-hint">Create a session or start capture to keep notes with your conversation.</p>}</div>
}

function Library({ state, run, openSession, createSession, notify }: { state: AppState; run: Run; openSession: (id: string) => Promise<unknown>; createSession: () => Promise<unknown>; notify: (message: string) => void }) {
  const [query, setQuery] = useState('')
  const [trash, setTrash] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateThrough, setDateThrough] = useState('')
  const [mode, setMode] = useState<'all' | WorkspaceMode>('all')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [exporting, setExporting] = useState<string | null>(null)
  const [purging, setPurging] = useState<SessionSummary | null>(null)
  const request = useRef(0)
  const load = useCallback(async () => {
    const generation = ++request.current
    setLoading(true)
    try { const result = await window.faangin.listSessions(query.trim(), trash, { ...sessionDateFilter(dateFrom, dateThrough), ...(mode === 'all' ? {} : { mode }) }); if (generation === request.current) { setSessions(result); setLoadError('') } }
    catch (e) { if (generation === request.current) setLoadError(errorMessage(e)) }
    finally { if (generation === request.current) setLoading(false) }
  }, [query, trash, dateFrom, dateThrough, mode])
  useEffect(() => { const timer = window.setTimeout(() => { void load() }, query ? 180 : 0); return () => { window.clearTimeout(timer); request.current++ } }, [load, state.sessions])
  const exportSession = async (id: string, format: 'markdown' | 'json') => { setExporting(null); const result = await run('Exporting session', () => window.faangin.exportSession(id, format), false); if (result) notify(`Exported to ${result.path}`) }
  const visible = sessions.filter(session => mode === 'all' || session.mode === mode)
  return <main className="library"><div className="page-heading"><div><span className="eyebrow">YOUR MOMENTS, KEPT CLOSE</span><h1>{trash ? 'Recently deleted' : 'Session library'}</h1><p>{trash ? 'Deleted sessions are excluded from context. Restore them or delete them permanently.' : 'Return to the conversations and ideas that matter.'}</p></div><button className="button primary" onClick={() => { void createSession() }}><Plus size={16}/>New session</button></div><div className="library-toolbar"><div className="search-field"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search sessions, notes, transcripts, and answers" aria-label="Search session library"/>{query && <IconButton label="Clear search" onClick={() => setQuery('')}><X size={13}/></IconButton>}</div><div className="segmented"><button className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>All</button><button className={mode === 'meeting' ? 'active' : ''} onClick={() => setMode('meeting')}>Meetings</button><button className={mode === 'interview' ? 'active' : ''} onClick={() => setMode('interview')}>Interviews</button></div><button className={`button subtle small ${trash ? 'selected' : ''}`} onClick={() => setTrash(!trash)}><Trash2 size={14}/>{trash ? 'Back to library' : 'Trash'}</button></div>
    <div className="library-date-filter"><span>Updated</span><label>From <input type="date" aria-label="Sessions updated from" value={dateFrom} onChange={event => setDateFrom(event.target.value)}/></label><label>Through <input type="date" aria-label="Sessions updated through" value={dateThrough} onChange={event => setDateThrough(event.target.value)}/></label>{(dateFrom || dateThrough) && <button className="text-button" onClick={() => { setDateFrom(''); setDateThrough('') }}>Clear dates</button>}</div>
    {loadError && <div className="library-error"><p>{loadError}</p><button className="button subtle" onClick={() => { void load() }}><RotateCcw size={14}/>Try again</button></div>}
    {loading ? <div className="library-loading"><Spinner label="Finding your sessions"/></div> : visible.length ? <><div className="library-count">{visible.length} {visible.length === 1 ? 'session' : 'sessions'}<span>Most recently updated</span></div><div className="session-grid">{visible.map(item => <article className="library-card" key={item.id}><button className="library-card-open" onClick={() => { if (!trash) void openSession(item.id) }} disabled={trash}><div className="library-card-top"><span className={`library-mode-icon ${item.mode}`}>{item.mode === 'meeting' ? <AudioLines size={19}/> : <Code2 size={19}/>}</span><span>{shortDate(item.updatedAt)}</span></div><span className="library-card-mode">{item.mode === 'meeting' ? 'Meeting' : 'Interview'}</span><h2>{item.title}</h2><p>{item.preview || 'A fresh session, ready for your context.'}</p><div className="library-card-meta"><span><MessageSquare size={12}/>{item.transcriptCount} context turns</span><span><Sparkles size={12}/>{item.answerCount} answers</span></div></button><div className="library-card-footer">{trash ? <><button className="text-button" onClick={() => { void run('Restoring session', () => window.faangin.restoreSession(item.id)) }}><RotateCcw size={14}/>Restore session</button><IconButton label={`Delete ${item.title} permanently`} onClick={() => setPurging(item)}><Trash2 size={14}/></IconButton></> : <><button className="text-button" onClick={() => { void openSession(item.id) }}>Open session<ArrowUpRight size={12}/></button><div><IconButton label={`Export ${item.title}`} onClick={() => setExporting(item.id)}><ArrowDownToLine size={14}/></IconButton><IconButton label={`Move ${item.title} to trash`} onClick={() => { void run('Moving session to trash', () => window.faangin.deleteSession(item.id)) }}><Trash2 size={14}/></IconButton></div></>}</div></article>)}</div></> : <div className="library-empty"><div className="empty-library-icon">{trash ? <Trash2 size={30}/> : <BookOpen size={30}/>}</div><h2>{query ? 'No matching moments.' : trash ? 'Nothing in the trash.' : 'Good conversations deserve a place.'}</h2><p>{query ? 'Try a different word or clear your filters.' : trash ? 'Sessions you delete will be kept here for recovery.' : 'Create your first session. Notes, transcripts, and answers will stay together here.'}</p>{query ? <button className="button subtle" onClick={() => { setQuery(''); setMode('all'); setDateFrom(''); setDateThrough('') }}>Clear filters</button> : !trash && <button className="button primary" onClick={() => { void createSession() }}><Plus size={15}/>Create a session</button>}</div>}
    {purging && <Modal title="Delete this session permanently?" description={`“${purging.title}” and its transcript, answers, notes, and in-app context will be removed. This cannot be undone. Files you exported and copies in OS backups are outside app deletion.`} onClose={() => setPurging(null)}><div className="button-row"><button className="button subtle" onClick={() => setPurging(null)}>Keep in Trash</button><button className="button primary" disabled={!!state.capture.sessionId && state.capture.sessionId === purging.id} onClick={() => { const id = purging.id; setPurging(null); void run('Deleting session permanently', () => window.faangin.permanentlyDeleteSession(id)) }}>Delete permanently</button></div></Modal>}
    {exporting && <Modal title="Export your session" description="Choose an editable Markdown document or a complete JSON record, including the session’s saved context." onClose={() => setExporting(null)}><div className="export-options"><button onClick={() => { void exportSession(exporting, 'markdown') }}><FileText size={23}/><strong>Markdown</strong><span>Notes, transcript, and answers</span><Download size={16}/></button><button onClick={() => { void exportSession(exporting, 'json') }}><Code2 size={23}/><strong>JSON</strong><span>Structured session data</span><Download size={16}/></button></div></Modal>}
  </main>
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*/, '') : String(error) }
/** The workspace shows the computer audio notice itself; the overlay keeps the message as a pointer to it. */
function consentNoticeShownHere(message: string) { return message.includes(SYSTEM_AUDIO_CONSENT_MESSAGE) && window.location.hash !== '#overlay' && new URLSearchParams(window.location.search).get('window') !== 'overlay' }


function displayModel(state: AppState, smart = state.settings.smartMode): string { return state.settings.chatProvider === 'compatible' ? (smart ? state.settings.compatibleChatSmartModel : state.settings.compatibleChatModel) || 'Model needs setup' : smart ? state.settings.smartModel : state.settings.fastModel }
