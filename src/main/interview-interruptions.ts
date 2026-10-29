import type { Action, Answer, AudioChannel, GenerateInput, Session, TranscriptTurn } from '../shared/types'

const conversationActions = new Set<Action>(['ask', 'assist', 'reply', 'followup', 'hint', 'solve', 'review', 'debug', 'design', 'behavioral'])
const normalizedSpeech = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

export interface InterviewInterruption {
  type: 'interview-interruption'
  reason: 'new-speech' | 'new-question' | 'manual-takeover'
  transcriptId?: string
}

/** The unfocused global shortcut follows the same interview takeover contract as Answer latest. */
export function shortcutGenerationInput(session: Pick<Session, 'id' | 'mode'>, action: Action, attachmentIds: readonly string[]): GenerateInput {
  const takeover = session.mode === 'interview' && action === 'reply'
  return { sessionId: session.id, action, prompt: '', attachmentIds: takeover ? [] : [...attachmentIds], ...(takeover ? { replaceActive: true } : {}) }
}

/** A stalled transport must not leave Answer latest pending indefinitely. */
export function waitForInterruptedRequests(requests: readonly Promise<void>[], timeoutMs = 2_000): Promise<void> {
  if (!requests.length) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The previous response is still stopping. Try Answer latest again.')), timeoutMs)
    Promise.all(requests).then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
  })
}

export function interruptionReason(value: unknown): InterviewInterruption | undefined {
  if (!value || typeof value !== 'object') return undefined
  const reason = value as Partial<InterviewInterruption>
  if (reason.type !== 'interview-interruption' || !['new-speech', 'new-question', 'manual-takeover'].includes(reason.reason ?? '')) return undefined
  return { type: 'interview-interruption', reason: reason.reason!, ...(typeof reason.transcriptId === 'string' && reason.transcriptId.length <= 200 ? { transcriptId: reason.transcriptId } : {}) }
}

/** A finalized question can invalidate output, but never authorizes a new request. */
export function shouldInterruptInterviewAnswer(answer: Answer, turn: TranscriptTurn, source: AudioChannel, transcript: readonly TranscriptTurn[]): boolean {
  if (answer.status !== 'streaming' || !conversationActions.has(answer.action) || answer.sessionId !== turn.sessionId || turn.channel !== source || turn.provisional || !/[\p{L}\p{N}]/u.test(turn.text)) return false
  if (answer.context?.transcriptIds.includes(turn.id)) return false
  const represented = new Set(answer.context?.transcriptIds ?? [])
  const previous = transcript.filter(item => represented.has(item.id) && item.channel === source && item.sessionId === answer.sessionId)
  const references = answer.transcriptReferences?.filter(item => represented.has(item.turnId) && item.channel === source) ?? []
  // A provider retry can assign another item ID to exactly the same spoken words.
  // Compare only represented source text; similar questions with new constraints still interrupt.
  const nextText = normalizedSpeech(turn.text)
  if (previous.some(item => normalizedSpeech(item.text) === nextText) || references.some(item => normalizedSpeech(item.text) === nextText)) return false
  const representedTimes = [...previous, ...references].map(item => item.timestamp).filter(timestamp => Number.isSafeInteger(timestamp) && timestamp >= 0)
  const watermark = representedTimes.length ? Math.max(...representedTimes) : answer.createdAt
  return Number.isSafeInteger(turn.timestamp) && turn.timestamp >= watermark
}
