import type { AppState } from '../../shared/types'
import { automaticReplyStatus, questionSourceHealth } from './interview-workflow'

export default function AutomaticHelpStatus({ state, busy, resume }: { state: Pick<AppState, 'settings' | 'capture' | 'liveSuggestions' | 'currentSession'>; busy: boolean; resume: () => Promise<unknown> }) {
  const status = automaticReplyStatus(state)
  const canResume = state.settings.liveSuggestions && state.liveSuggestions?.phase === 'paused' && state.capture.active && state.capture.sessionId === state.currentSession?.id && questionSourceHealth(state.settings, state.capture).listening
  return <div className="live-suggestions-status" role="status"><strong>Automatic help · {status.label}</strong><span>{status.detail}</span>{canResume && <button className="text-button" disabled={busy} onClick={() => { void resume() }}>Resume automatic help</button>}</div>
}
