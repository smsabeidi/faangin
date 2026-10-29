import type { AppState, AudioChannel, FaanginAPI, GenerateInput, Session, Settings } from '../../shared/types'
import type { PartialTurn } from './live-transcript'


export function questionSourcePatch(source: AudioChannel): Partial<Settings> {
  return source === 'system' ? { liveSuggestionSource: 'system', systemAudio: true, microphone: false } : { liveSuggestionSource: 'microphone', microphone: true, systemAudio: false }
}

export const HANDS_FREE_CONSENT = 'Transcribes microphone + computer audio with OpenAI. Automatically sends conversation context to your chat provider; uses credits. Screenshots stay manual.'

export function handsFreeSettingsPatch(): Partial<Settings> {
  return { microphone: true, systemAudio: true, liveSuggestions: true, liveSuggestionSource: 'system' }
}

type InterviewStartState = Pick<AppState, 'settings' | 'capture' | 'currentSession'>

export function handsFreeControl(state: InterviewStartState): { label: string; action: 'start' | 'stop'; reason: string } {
  const { capture, settings, currentSession } = state
  if (!capture.sessionId) return { label: 'Start hands-free', action: 'start', reason: '' }
  if (capture.sessionId !== currentSession?.id) return { label: 'Start hands-free', action: 'start', reason: 'Stop listening in the other session before starting hands-free here.' }
  if (!settings.microphone || !settings.systemAudio) return { label: 'Start hands-free', action: 'start', reason: 'Stop listening first to enable microphone + computer audio together.' }
  if ([capture.microphone, capture.system].includes('Paused')) return { label: 'Resume hands-free', action: 'start', reason: '' }
  if (!settings.liveSuggestions || settings.liveSuggestionSource !== 'system') return { label: 'Enable hands-free', action: 'start', reason: '' }
  return { label: 'Stop listening', action: 'stop', reason: '' }
}

/** One intentional opt-in; never redirects an in-flight start to a newly selected or reset session. */
export async function startHandsFreeInterview(api: Pick<FaanginAPI, 'getState' | 'updateSettings' | 'startCapture' | 'resumeCapture'>, expected: Pick<Session, 'id' | 'contextEpoch'>, signal?: AbortSignal): Promise<void> {
  const checkCancelled = () => { if (signal?.aborted) throw new Error('Hands-free start cancelled.') }
  const verify = (state: InterviewStartState) => {
    checkCancelled()
    if (state.currentSession?.id !== expected.id || state.currentSession.contextEpoch !== expected.contextEpoch || state.currentSession.mode !== 'interview') throw new Error('The interview changed before listening started. Choose Start hands-free in the current interview.')
    const control = handsFreeControl(state)
    if (control.reason) throw new Error(control.reason)
  }
  checkCancelled()
  verify(await api.getState())
  await api.updateSettings(handsFreeSettingsPatch())
  checkCancelled()
  const latest = await api.getState()
  verify(latest)
  if (!latest.settings.microphone || !latest.settings.systemAudio || !latest.settings.liveSuggestions || latest.settings.liveSuggestionSource !== 'system') throw new Error('Audio settings changed before listening started. Choose Start hands-free again.')
  if (!latest.capture.sessionId) await api.startCapture(expected.id)
  else if ([latest.capture.microphone, latest.capture.system].includes('Paused') || latest.currentSession?.status === 'paused') await api.resumeCapture(expected.id)
}

/** Enabled and idle means ready, even when an older desktop status still reports off. */
export function automaticReplyStatus(state: Pick<AppState, 'settings' | 'capture' | 'liveSuggestions'>): { label: string; detail: string } {
  if (!state.settings.liveSuggestions) return { label: 'Off', detail: 'Choose Answer follow-up to request an answer manually.' }
  if (!state.capture.sessionId) return { label: 'Ready', detail: 'Automatic help is enabled. Audio stays off until you start listening.' }
  if ([state.capture.microphone, state.capture.system].includes('Paused')) return { label: 'Paused', detail: 'Resume listening when you are ready.' }
  const health = questionSourceHealth(state.settings, state.capture)
  if (health.unavailable) return { label: 'Needs audio', detail: health.headline }
  if (health.waiting) return { label: 'Waiting for audio', detail: health.headline }
  const status = state.liveSuggestions
  const labels: Record<NonNullable<AppState['liveSuggestions']>['phase'], string> = { off: 'Getting ready', ready: 'Getting ready', listening: 'Listening', waiting: 'Question received', understanding: 'Understanding the question', generating: 'Answering', paused: 'Paused' }
  const secondary = state.settings.microphone && state.settings.systemAudio ? questionSourceHealth({ ...state.settings, liveSuggestionSource: state.settings.liveSuggestionSource === 'system' ? 'microphone' : 'system' }, state.capture) : null
  const detail = status?.reason || 'Help appears automatically when the question is ready. Keep speaking naturally.'
  return { label: status ? labels[status.phase] : health.listening ? 'Listening' : 'Connecting audio', detail: secondary?.unavailable || secondary?.waiting ? `${secondary.headline}. ${detail}` : detail }
}

export function hasReplyContext(session: Session | null, capture: AppState['capture'], partials: readonly PartialTurn[]): boolean {
  return !!session && (session.transcript.some(turn => turn.sessionId === session.id && !turn.provisional && !!turn.text.trim()) || (capture.active && capture.sessionId === session.id && partials.some(turn => turn.sessionId === session.id && !!turn.text.trim())))
}

export function audioInputGuidance(source: AudioChannel, enabled: boolean, status: string, permission?: string): string {
  if (!enabled) return `Enable ${source === 'system' ? 'system audio to hear the remote interviewer' : 'the microphone to hear questions in the room'}.`
  const lower = status.toLowerCase()
  if (/denied|permission|not allowed|access was blocked/.test(lower)) {
    if (permission === 'granted') return 'Your system reports that access is already allowed. Choose Stop listening, fully quit and reopen Faangin, then choose Start listening.'
    return `Check ${source === 'system' ? 'screen and system audio' : 'microphone'} access in system settings. If access is already allowed, fully quit and reopen Faangin. Choose Stop listening, then Start listening to try again.`
  }
  if (/unavailable|not found|no device|not supported|unsupported/.test(lower)) return source === 'system' ? 'System audio is unavailable. Check audio permissions or choose Microphone for an in-person practice question.' : 'Reconnect your microphone or choose another input in Audio settings, then restart listening.'
  if (/disconnected|error|failed/.test(lower)) return 'This audio source disconnected. Stop listening, check the connection, and start again.'
  if (/muted/.test(lower)) return source === 'system' ? 'Computer audio is muted. Unmute the call or playback source to continue.' : 'The microphone is muted. Unmute it to continue.'
  if (/silent|low audio|no audio/.test(lower)) return source === 'system' ? 'No clear computer audio yet. Play the interviewer’s voice through your computer and check that the meter moves.' : 'No clear microphone audio yet. Speak near the microphone and check that the meter moves.'
  return ''
}

/** Typed questions stand alone; spoken follow-ups use the captured question. Neither resends screenshots. */
export function interviewFollowupRequest(prompt: string): Pick<GenerateInput, 'action' | 'prompt' | 'attachmentIds'> {
  const text = prompt.trim()
  return { action: text ? 'ask' : 'reply', prompt: text, attachmentIds: [] }
}


export interface QuestionSourceHealth { listening: boolean; unavailable: boolean; waiting?: boolean; headline: string }

/** A healthy secondary source does not establish that the chosen question source is working. */
export function questionSourceHealth(settings: Pick<Settings, 'liveSuggestionSource' | 'microphone' | 'systemAudio'>, capture: AppState['capture']): QuestionSourceHealth {
  const source = settings.liveSuggestionSource
  const enabled = source === 'system' ? settings.systemAudio : settings.microphone
  const status = (source === 'system' ? capture.system : capture.microphone).toLowerCase()
  const label = source === 'system' ? 'Computer audio' : 'Microphone'
  const live = (value: string) => /^(?:listening|recording|active|connected|capturing)(?:$|\s|[.(—-])/.test(value.toLowerCase()) || /^(?:silent|low audio)/.test(value.toLowerCase())
  if (!capture.sessionId) return { listening: false, unavailable: false, headline: 'Ready to listen' }
  if (status === 'paused') return { listening: false, unavailable: false, headline: 'Listening paused' }
  if (enabled && /muted/.test(status)) return { listening: false, unavailable: false, waiting: true, headline: `${label} muted · waiting for audio` }
  if (enabled && capture.active && live(status)) return { listening: true, unavailable: false, headline: 'Listening to question audio' }
  const failed = /denied|permission|blocked|unavailable|disconnected|failed|error|interrupted|could not|no audio frames|no system audio track/.test(status)
  if (!enabled || failed) {
    const secondaryLive = capture.active && (source === 'system' ? settings.microphone && live(capture.microphone) : settings.systemAudio && live(capture.system))
    return { listening: false, unavailable: true, headline: `${label} ${enabled ? 'unavailable' : 'is off'}${secondaryLive ? source === 'system' ? ' · microphone only' : ' · computer audio only' : ''}` }
  }
  return { listening: false, unavailable: false, headline: `Connecting ${label.toLowerCase()}…` }
}
