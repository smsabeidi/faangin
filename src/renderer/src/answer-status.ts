import type { Answer, AudioChannel, GenerateInput, TranscriptTurn, WorkspaceMode } from '../../shared/types'

export function interruptedAnswerLabel(answer: Pick<Answer, 'interruption'>): string | null {
  if (!answer.interruption) return null
  return answer.interruption.reason === 'manual-takeover' ? 'Interrupted — updated question' : 'Interrupted — question changed'
}

export function canRetryAnswer(answer: Pick<Answer, 'status' | 'interruption'>, questionUpdated = false): boolean {
  return !questionUpdated && !answer.interruption && (answer.status === 'failed' || answer.status === 'cancelled')
}

export function latestAnswerIsInterrupted(answers: readonly Pick<Answer, 'interruption'>[]): boolean {
  return !!answers.at(-1)?.interruption
}

export function answerLatestBlocked(mode: WorkspaceMode, hasQuestion: boolean, working: boolean, pendingDesktopOperation: boolean): boolean {
  return !hasQuestion || pendingDesktopOperation || (mode !== 'interview' && working)
}

export function latestQuestionRequest(mode: WorkspaceMode, prompt: string): Pick<GenerateInput, 'action' | 'prompt' | 'attachmentIds' | 'replaceActive'> {
  const text = prompt.trim()
  return { action: text ? 'ask' : 'reply', prompt: text, attachmentIds: [], ...(mode === 'interview' ? { replaceActive: true } : {}) }
}

/** Streaming can follow the viewport only while the user is reading at its end. */
export function shouldFollowAnswerUpdates(followingBottom: boolean, editing: boolean): boolean {
  return followingBottom && !editing
}


/** A finalized question after a terminal response is evidence of new context, without guessing its topic. */
export function answerQuestionUpdated(answer: Answer | undefined, transcript: readonly TranscriptTurn[], source: AudioChannel): boolean {
  if (!answer || answer.status === 'streaming' || answer.interruption || !answer.context || !Number.isFinite(answer.createdAt)) return false
  let latest: TranscriptTurn | undefined
  for (const turn of transcript) {
    if (turn.sessionId !== answer.sessionId || turn.provisional || !turn.text.trim() || !Number.isFinite(turn.timestamp) || (turn.channel !== source && turn.channel !== 'manual')) continue
    if (!latest || turn.timestamp >= latest.timestamp) latest = turn
  }
  return !!latest && latest.timestamp >= answer.createdAt && !answer.context.transcriptIds.includes(latest.id)
}
