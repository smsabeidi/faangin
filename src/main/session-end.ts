import type { SessionStatus } from '../shared/types'

export interface InterruptedSessionStore {
  markTranscriptIncomplete(id: string): void
  setStatus(id: string, status: SessionStatus): void
}

/**
 * Windows ends a session (log-off, restart, shutdown) without `before-quit`, so the normal stop path never marks the live capture
 * ended. Left alone, the next launch ends it with that launch's time and speech still being transcribed disappears without the
 * incomplete notice. Both writes are synchronous, as the session-end handler allows no asynchronous work, and each is attempted
 * on its own: a failure here must not stop the shutdown, and the next launch still closes a stale row.
 */
export function endSessionAtShutdown(store: InterruptedSessionStore, sessionId: string | null, unfinalizedSpeech: boolean): void {
  if (!sessionId) return
  if (unfinalizedSpeech) { try { store.markTranscriptIncomplete(sessionId) } catch { /* Best effort. */ } }
  try { store.setStatus(sessionId, 'ended') } catch { /* Best effort. */ }
}
