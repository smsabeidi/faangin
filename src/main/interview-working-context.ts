import { createHash } from 'node:crypto'
import type { Action, Answer, Session } from '../shared/types'

const solutionActions = new Set<Action>(['solve', 'design', 'debug'])
const followupActions = new Set<Action>(['ask', 'assist', 'reply', 'hint', 'review', 'debug', 'followup', 'solve', 'design', 'behavioral'])
const relatedActions = new Set<Action>(['ask', 'assist', 'reply', 'hint', 'review', 'debug', 'followup', 'solve', 'design', 'behavioral'])
const conversationalActions = new Set<Action>(['reply', 'ask', 'assist', 'hint', 'behavioral'])

/** Send/Assist on a captured question is also an interview answer worth explaining later. */
export function isInterviewSolutionAnswer(answer: Answer): boolean {
  return solutionActions.has(answer.action) || ((answer.action === 'ask' || answer.action === 'assist') && !!answer.context?.attachmentIds.length) || (answer.action === 'behavioral' && answer.context?.interviewSnapshot?.round === 'behavioral')
}

export function interviewSnapshot(session: Session): NonNullable<Answer['context']>['interviewSnapshot'] {
  if (session.mode !== 'interview') return undefined
  return { round: session.interview?.round ?? 'coding', problem: session.interview?.problem.trim() ?? '', constraints: session.interview?.constraints.trim() ?? '' }
}

/** Constraint edits revise the same problem; replacing its statement/round is a boundary. */
export function matchesInterviewProblem(answer: Answer, session: Session, attachmentIds: readonly string[] = []): boolean {
  const snapshot = answer.context?.interviewSnapshot
  const current = interviewSnapshot(session)
  if (!current) return false
  const sameBrief = snapshot ? snapshot.round === current.round && snapshot.problem.trim() === current.problem
    : answer.context?.interviewContextKey ? answer.context.interviewContextKey === interviewContextKey(session)
      : !(current.problem || current.constraints || current.round !== 'coding')
  const currentImages = new Set([...session.selectedAttachmentIds ?? [], ...attachmentIds])
  return sameBrief && [...currentImages].every(id => answer.context?.attachmentIds.includes(id))
}

/** Identity of the problem, not its editable interview stage or the candidate's evolving attempt. */
export function interviewContextKey(session: Session): string | undefined {
  if (session.mode !== 'interview') return undefined
  const brief = session.interview
  return createHash('sha256').update(JSON.stringify([brief?.round ?? 'coding', brief?.problem.trim() ?? '', brief?.constraints.trim() ?? ''])).digest('hex')
}

/**
 * The current interview solution is working context for spoken follow-ups. General meeting
 * history remains opt-in. Keep the solution even after many replies, and only carry replies
 * whose recorded sources link them to that solution. Audio-only starts instead retain a
 * recent conversational window for the same problem. Raw screenshots are never added here.
 */
export function selectInterviewWorkingAnswers(session: Session, action: Action, attachmentIds: readonly string[] = []): Answer[] {
  if (session.mode !== 'interview' || !followupActions.has(action)) return []
  if (action === 'behavioral' && session.interview?.round !== 'behavioral') return []
  const answers = session.answers.filter(answer => answer.sessionId === session.id)
    .map((answer, index) => ({ answer, index }))
    .sort((a, b) => a.answer.createdAt - b.answer.createdAt || a.index - b.index)
    .map(item => item.answer)
  const currentImages = new Set([...session.selectedAttachmentIds ?? [], ...attachmentIds])
  const matchesBrief = (answer: Answer): boolean => matchesInterviewProblem(answer, { ...session, selectedAttachmentIds: [] })
  const matchesImages = (answer: Answer): boolean => [...currentImages].every(id => answer.context?.attachmentIds.includes(id))
  // A newer unfinished solution is a problem boundary, never an excuse to reuse an old one.
  let anchorIndex = -1
  for (let index = answers.length - 1; index >= 0; index--) {
    if (isInterviewSolutionAnswer(answers[index]) && !(answers[index].status === 'cancelled' && answers[index].interruption)) { anchorIndex = index; break }
  }
  // Audio-only interviews may start with Answer latest rather than Solve. Preserve a
  // small conversational window until a concrete solution establishes a stable anchor.
  if (anchorIndex < 0) {
    const recent: Answer[] = []
    const seen = new Set<string>()
    for (let index = answers.length - 1; index >= 0 && recent.length < 6; index--) {
      const answer = answers[index]
      if (!conversationalActions.has(answer.action)) continue
      if (answer.action === 'behavioral' && session.interview?.round !== 'behavioral') continue
      // Do not reach across a newer problem or a newly selected screenshot.
      if (!matchesBrief(answer) || !matchesImages(answer)) break
      if (answer.status !== 'complete' || !answer.text.trim() || seen.has(answer.id)) continue
      seen.add(answer.id)
      recent.unshift(answer)
    }
    return recent
  }
  let anchor = answers[anchorIndex]
  if (!anchor || anchor.status !== 'complete' || !anchor.text.trim()) return []
  if (!matchesBrief(anchor) || (anchor.context?.attachmentIds.length && !matchesImages(anchor))) return []
  // Corrections and screenshot follow-ups may contain only an explanation or a patch.
  // Retain the solution they reference while a genuinely new screenshot starts a new chain.
  while (anchor.action === 'debug' || anchor.action === 'ask' || anchor.action === 'assist') {
    let parentIndex = -1
    for (let index = anchorIndex - 1; index >= 0; index--) {
      const parent = answers[index]
      if (isInterviewSolutionAnswer(parent) && parent.status === 'complete' && parent.text.trim() &&
        anchor.context?.priorAnswerIds.includes(parent.id) && matchesBrief(parent) && matchesImages(parent)) { parentIndex = index; break }
    }
    if (parentIndex < 0) break
    anchorIndex = parentIndex
    anchor = answers[parentIndex]
  }
  if (!matchesImages(anchor)) return []
  const linkedIds = new Set([anchor.id])
  const related: Answer[] = []
  for (const answer of answers.slice(anchorIndex + 1)) {
    if (answer.status !== 'complete' || !answer.text.trim() || !relatedActions.has(answer.action) || linkedIds.has(answer.id)) continue
    if (!matchesBrief(answer)) continue
    if (!answer.context?.priorAnswerIds.some(id => linkedIds.has(id))) continue
    linkedIds.add(answer.id)
    related.push(answer)
  }
  return [anchor, ...related.slice(-5)]
}
