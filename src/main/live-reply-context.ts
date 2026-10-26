import type { AudioChannel, Session, TranscriptTurn } from '../shared/types'

export interface LiveReplyIdentity { turn: TranscriptTurn; generation: number; epoch: number }
export interface LiveReplyAdmission {
  enabled: boolean; source: AudioChannel; currentSessionId: string | null
  active: boolean; captureSessionId: string | null; phase: string
  generation: number; stopped: boolean; listening: ReadonlySet<AudioChannel>
  revoked: ReadonlySet<AudioChannel>; epochCurrent: boolean; quitting: boolean
}

/** A committed turn may still be saved after Stop; it must not start a reply. */
export function admitsLiveReply(candidate: LiveReplyIdentity, gate: LiveReplyAdmission): boolean {
  return gate.enabled && !gate.quitting && gate.active && gate.phase === 'running' && !gate.stopped &&
    gate.currentSessionId === candidate.turn.sessionId && gate.captureSessionId === candidate.turn.sessionId &&
    gate.generation === candidate.generation && gate.epochCurrent && candidate.turn.channel === gate.source &&
    !candidate.turn.provisional && gate.listening.has(gate.source) && !gate.revoked.has(gate.source)
}

/** Freeze the selected question plus available other-channel context at dispatch.
 * Later selected-source questions remain outside this snapshot; candidate speech
 * that has already finalized may explain that the question was answered aloud.
 */
export function liveReplyTranscript(session: Session, candidate: LiveReplyIdentity): TranscriptTurn[] {
  const target = session.transcript.find(turn => turn.id === candidate.turn.id)
  if (session.id !== candidate.turn.sessionId || session.contextEpoch !== candidate.epoch || !target ||
    target.sessionId !== session.id || target.provisional || target.channel !== candidate.turn.channel || target.text !== candidate.turn.text ||
    target.timestamp !== candidate.turn.timestamp) throw new Error('The spoken reply context changed. Wait for a new finalized turn or choose Reply.')
  const finalized = session.transcript.filter(turn => turn.sessionId === session.id && !turn.provisional)
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  const targetIndex = finalized.findIndex(turn => turn.id === target.id)
  return finalized.filter((turn, index) => index <= targetIndex ||
    (turn.channel !== target.channel && (turn.channel === 'microphone' || turn.channel === 'system'))).map(turn => ({ ...turn }))
}
