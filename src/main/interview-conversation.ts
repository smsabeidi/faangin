import type { Answer, AudioChannel, Session, TranscriptTurn } from '../shared/types'

export interface AutomaticInterviewContext { source: AudioChannel; channels: AudioChannel[] }
export const INTERVIEW_CONVERSATION_LIMITS = { turns: 10, afterTargetTurns: 4, characters: 4_000, targetCharacters: 1_000, priorSuggestions: 3 } as const

function excerpt(text: string, limit: number) {
  if (text.length <= limit) return { excerpts: [{ start: 0, end: text.length, text }], truncated: false }
  let end = Math.floor(limit * 0.6), start = text.length - (limit - end)
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++
  return { excerpts: [{ start: 0, end, text: text.slice(0, end) }, { start, end: text.length, text: text.slice(start) }], truncated: true }
}
function order(a: TranscriptTurn, b: TranscriptTurn): number { return a.timestamp - b.timestamp || a.id.localeCompare(b.id) }
const quote = (turn: TranscriptTurn, limit: number) => ({ turnId: turn.id, channel: turn.channel, timestamp: turn.timestamp, ...excerpt(turn.text, limit) })

/** Preserve observations and source hints; semantic speaker/intent decisions belong to the model. */
export function buildInterviewConversation(session: Session, targetId: string, automatic: AutomaticInterviewContext, answers: readonly Answer[]) {
  const turns = session.transcript.filter(turn => turn.sessionId === session.id && !turn.provisional && turn.text.trim()).slice().sort(order)
  const target = turns.find(turn => turn.id === targetId)
  if (!target || target.channel !== automatic.source) throw new Error('The automatic interview target no longer matches the selected question audio.')
  const before = turns.filter(turn => order(turn, target) <= 0)
  const after = turns.filter(turn => turn.channel !== automatic.source && order(turn, target) > 0)
  const recentAfter = after.slice(-INTERVIEW_CONVERSATION_LIMITS.afterTargetTurns)
  const observations = [...before.slice(-(INTERVIEW_CONVERSATION_LIMITS.turns - recentAfter.length)), ...recentAfter].sort(order)
  const allowance = Math.floor(INTERVIEW_CONVERSATION_LIMITS.characters / Math.max(1, observations.length))
  const recent = observations.map(turn => ({ ...quote(turn, allowance), relativeToTarget: turn.id === target.id ? 'trigger' : order(turn, target) > 0 ? 'observed_after_trigger' : 'preceding_context' }))
  const priorSuggestions = answers.filter(answer => answer.sessionId === session.id && answer.status === 'complete' && answer.action === 'reply').slice(-INTERVIEW_CONVERSATION_LIMITS.priorSuggestions).map(answer => {
    const recorded = answer.context?.replyTargetId ? turns.find(turn => turn.id === answer.context!.replyTargetId) : undefined
    const inferred = recorded ?? turns.filter(turn => answer.context?.transcriptIds.includes(turn.id)).at(-1)
    return { answerId: answer.id, source: 'generated_suggestion_not_spoken_evidence', ...(inferred ? { addressedUtterance: quote(inferred, 400), targetAttribution: recorded ? 'recorded_target' : 'inferred_from_legacy_context' } : {}), response: excerpt(answer.text, 500) }
  })
  const trigger = quote(target, INTERVIEW_CONVERSATION_LIMITS.targetCharacters)
  return {
    data: {
      source: 'bounded_interview_conversation_observations', trust: 'untrusted_reference_data',
      trigger, preferredQuestionSource: automatic.source, capturedAudioChannels: [...new Set(automatic.channels)],
      sourceHints: automatic.source === 'system' && automatic.channels.includes('microphone')
        ? 'Computer audio is selected for questions and a separate microphone is available. Microphone speech may be candidate reasoning; computer audio may still contain several people. These are source hints, not verified speaker identities.'
        : 'The selected input may contain interviewer and candidate speech. In-person microphone capture has unknown speakers; never equate microphone with candidate or interviewer.',
      recentObservations: recent, omittedBeforeTargetTurns: before.length - (observations.length - recentAfter.length), omittedAfterTargetTurns: after.length - recentAfter.length,
      priorSuggestions, interpretation: 'Decide whether the trigger requests help using quoted speech, neighboring candidate reasoning and any response already given. A generated suggestion is not proof it was spoken. Distinguish direct questions/instructions, requirements/corrections, candidate thinking, quotations, acknowledgments and incomplete speech. No intent or verified speaker label has been inferred here.',
      truncated: recent.some(turn => turn.truncated) || trigger.truncated || priorSuggestions.some(suggestion => suggestion.response.truncated || suggestion.addressedUtterance?.truncated) || observations.length < before.length + after.length,
    },
    transcriptIds: [...new Set([target.id, ...observations.map(turn => turn.id), ...priorSuggestions.flatMap(suggestion => suggestion.addressedUtterance ? [suggestion.addressedUtterance.turnId] : [])])],
  }
}
