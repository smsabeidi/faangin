import type { Action, Answer, Session, TranscriptTurn } from '../shared/types'
import { interviewSnapshot, isInterviewSolutionAnswer, matchesInterviewProblem } from './interview-working-context'

export const INTERVIEW_SITUATION_LIMITS = { evidenceTurns: 12, evidenceCharacters: 6_000, turnCharacters: 1_200, focusCharacters: 2_000, interruptedCharacters: 2_400 } as const

function excerpts(text: string, limit: number): { excerpts: Array<{ start: number; end: number; text: string }>; truncated: boolean } {
  if (text.length <= limit) return { excerpts: [{ start: 0, end: text.length, text }], truncated: false }
  const head = Math.floor(limit * 0.6)
  let end = head, start = text.length - (limit - head)
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++
  return { excerpts: [{ start: 0, end, text: text.slice(0, end) }, { start, end: text.length, text: text.slice(start) }], truncated: true }
}
function quote(turn: TranscriptTurn, limit: number) {
  return { turnId: turn.id, channel: turn.channel, timestamp: turn.timestamp, ...excerpts(turn.text, limit) }
}
function chronological(a: TranscriptTurn, b: TranscriptTurn): number { return a.timestamp - b.timestamp || a.id.localeCompare(b.id) }

/** Quoted evidence, not a guessed state machine: the model interprets what changed and why. */
export function buildInterviewSituation(input: { session: Session; action: Action; prompt: string; replyTarget?: string; answers: Answer[]; attachmentIds: string[] }) {
  const { session, prompt } = input
  if (session.mode !== 'interview' || ['draft', 'notes', 'recap'].includes(input.action)) return undefined
  const turns = session.transcript.filter(turn => turn.sessionId === session.id && !turn.provisional && turn.text.trim()).slice().sort(chronological)
  const target = input.replyTarget ? turns.find(turn => turn.id === input.replyTarget) : turns.at(-1)
  const targetIndex = target ? turns.indexOf(target) : -1
  const baseline = input.answers[0]
  const included = input.answers.slice().sort((a, b) => a.createdAt - b.createdAt)
  const latestComplete = included.filter(isInterviewSolutionAnswer).at(-1) ?? included.at(-1)
  const baselineIds = new Set(baseline?.context?.transcriptIds ?? [])
  const baselineTurn = turns.filter(turn => baselineIds.has(turn.id)).at(-1)
  const cutoff = baselineTurn?.timestamp ?? baseline?.createdAt
  const evidence = turns.filter(turn => !baselineIds.has(turn.id) && (cutoff === undefined || turn.timestamp >= cutoff) && (!target || chronological(turn, target) <= 0))
  // Retain the first revision after a baseline as well as the newest discussion. We do
  // not use language-dependent keyword heuristics to decide which utterance matters.
  const candidates = baseline && evidence.length > INTERVIEW_SITUATION_LIMITS.evidenceTurns
    ? [...evidence.slice(0, 2), ...evidence.slice(-(INTERVIEW_SITUATION_LIMITS.evidenceTurns - 2))]
    : evidence.slice(-INTERVIEW_SITUATION_LIMITS.evidenceTurns)
  let budget: number = INTERVIEW_SITUATION_LIMITS.evidenceCharacters
  const quoted = []
  let truncated = candidates.length < evidence.length
  for (let index = 0; index < candidates.length; index++) {
    const allowance = Math.min(INTERVIEW_SITUATION_LIMITS.turnCharacters, Math.floor(budget / (candidates.length - index)))
    const item = quote(candidates[index], allowance)
    budget -= item.excerpts.reduce((sum, part) => sum + part.text.length, 0)
    truncated ||= item.truncated
    quoted.push(item)
  }
  const focus = target ? quote(target, INTERVIEW_SITUATION_LIMITS.focusCharacters) : undefined
  truncated ||= focus?.truncated ?? false
  const preceding = targetIndex >= 0 ? turns.slice(Math.max(0, targetIndex - 2), targetIndex).map(turn => quote(turn, 600)) : []
  truncated ||= preceding.some(turn => turn.truncated)
  const answerIds = new Set(included.map(answer => answer.id))
  const currentImages = new Set([...session.selectedAttachmentIds ?? [], ...input.attachmentIds])
  const completedConsumers = session.answers.filter(answer => answer.sessionId === session.id && answer.status === 'complete' &&
    matchesInterviewProblem(answer, { ...session, selectedAttachmentIds: [] }) &&
    (!answer.context?.attachmentIds.length || [...currentImages].every(id => answer.context?.attachmentIds.includes(id))))
  const interrupted = session.answers.filter(answer => answer.sessionId === session.id && answer.status === 'cancelled' && answer.interruption && answer.text.trim() &&
    answer.createdAt >= (latestComplete?.createdAt ?? 0) && matchesInterviewProblem(answer, { ...session, selectedAttachmentIds: [] }) &&
    !completedConsumers.some(consumer => consumer.createdAt >= answer.createdAt && consumer.context?.interruptedAnswerIds?.includes(answer.id)) &&
    ([...currentImages].every(id => answer.context?.attachmentIds.includes(id)) || (!answer.context?.attachmentIds.length && answer.context?.priorAnswerIds.some(id => answerIds.has(id)))))
    .sort((a, b) => a.createdAt - b.createdAt).at(-1)
  const interruptedDrafts = interrupted ? [{ answerId: interrupted.id, action: interrupted.action, status: 'interrupted_draft', source: 'unfinished_generated_output', trust: 'untrusted_reference_data', createdAt: interrupted.createdAt, interruption: { ...interrupted.interruption }, request: excerpts(interrupted.prompt, 400), ...excerpts(interrupted.text, INTERVIEW_SITUATION_LIMITS.interruptedCharacters) }] : []
  truncated ||= interruptedDrafts.some(draft => draft.truncated || draft.request.truncated)
  const previousBrief = baseline?.context?.interviewSnapshot
  const currentBrief = interviewSnapshot(session)
  const briefRevision = previousBrief && currentBrief ? {
    source: 'saved_brief_comparison', baselineAnswerId: baseline.id,
    changedFields: (['round', 'problem', 'constraints'] as const).filter(field => previousBrief[field].trim() !== currentBrief[field].trim()),
    priorProblem: excerpts(previousBrief.problem, 1_000), priorConstraints: excerpts(previousBrief.constraints, 2_000),
    currentBriefSource: 'interview', interpretation: 'Evaluate whether quoted changes revise the existing scenario; do not treat earlier generated assumptions as requirements.'
  } : undefined
  const exchanges = included.map(answer => {
    const sourceTurns = turns.filter(turn => answer.context?.transcriptIds.includes(turn.id))
    const recordedQuestion = answer.context?.replyTargetId ? turns.find(turn => turn.id === answer.context!.replyTargetId) : undefined
    const requestText = answer.prompt.trim() || recordedQuestion?.text || sourceTurns.at(-1)?.text || ''
    return { answerId: answer.id, action: answer.action, createdAt: answer.createdAt, status: 'complete', source: 'generated_suggestion', sourceTurnIds: sourceTurns.slice(-3).map(turn => turn.id), request: excerpts(requestText, 400) }
  })
  truncated ||= exchanges.some(exchange => exchange.request.truncated) || !!briefRevision?.priorProblem.truncated || !!briefRevision?.priorConstraints.truncated
  return {
    data: {
      source: 'bounded_current_interview_context', trust: 'untrusted_reference_data',
      questionFocus: { ...(prompt ? { explicitRequest: excerpts(prompt, INTERVIEW_SITUATION_LIMITS.focusCharacters) } : {}), ...(focus ? { latestFinalizedUtterance: focus } : {}), precedingSegments: preceding, interpretation: 'Identify the question from these quotes. A channel is a capture source, not a speaker identity.' },
      ...(briefRevision ? { briefRevision } : {}),
      evidenceSinceBaseline: quoted, omittedEvidenceTurns: evidence.length - quoted.length,
      evidencePolicy: 'These are chronological source excerpts, not accepted requirements. Determine which are actual changes, hypothetical variations, clarifications or candidate proposals from their wording and surrounding evidence.',
      workingArtifacts: { ...(baseline ? { baselineAnswerId: baseline.id } : {}), ...(latestComplete ? { latestCompleteAnswerId: latestComplete.id } : {}), candidateAttemptSource: 'interview.candidateAttempt', status: 'Generated output is a proposal, not proof the candidate implemented, executed or adopted it.' },
      exchanges, interruptedDrafts, truncated,
    },
    transcriptIds: [...new Set([...quoted.map(turn => turn.turnId), ...preceding.map(turn => turn.turnId), ...(target ? [target.id] : [])])],
    interruptedAnswerIds: interrupted ? [interrupted.id] : [], truncated,
  }
}
