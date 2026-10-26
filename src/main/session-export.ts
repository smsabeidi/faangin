import type { Action, Answer, Session } from '../shared/types'
import { answerReferences, linkedTranscriptMarkdown } from '../shared/transcript-references'

const actionLabels: Record<Action, string> = { ask: 'Question', assist: 'Assistance', reply: 'Suggested reply', followup: 'Follow-up questions', draft: 'Follow-up draft', recap: 'Recap', hint: 'Hint', solve: 'Coding solution', review: 'Attempt review', debug: 'Debugging', design: 'System design', behavioral: 'Behavioral answer', notes: 'Generated notes' }
const statusLabels: Record<Answer['status'], string> = { complete: 'Complete', streaming: 'In progress — incomplete', cancelled: 'Cancelled — incomplete', failed: 'Failed — incomplete' }

function timestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toISOString()
}

function inline(value: string): string { return value.replace(/[\r\n]+/g, ' ').trim() }

function fenced(value: string): string {
  const longestRun = (value.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`
}

/** Export saved context and evidence without image payloads or implied execution results. */
export function sessionMarkdown(session: Session): string {
  const sections = [`# ${inline(session.title)}`, `Created: ${timestamp(session.createdAt)}\nMode: ${session.mode === 'interview' ? 'Interview' : 'Meeting'}${session.endedAt !== undefined ? `\nEnded: ${timestamp(session.endedAt)}` : ''}`]
  if (session.mode === 'interview' && session.interview) {
    const brief = session.interview
    const rounds = { coding: 'Coding', 'system-design': 'System design', behavioral: 'Behavioral' }
    const stages = { clarify: 'Clarify requirements', approach: 'Discuss an approach', implement: 'Implement', verify: 'Verify and test', optimize: 'Optimize and discuss trade-offs' }
    sections.push('## Interview brief', `- Company: ${inline(brief.company) || 'Not set'}\n- Role: ${inline(brief.role) || 'Not set'}\n- Round: ${rounds[brief.round]}\n- Stage: ${stages[brief.stage]}`,
      '### Problem or question', brief.problem || 'Not provided.', '### Constraints and clarifications', brief.constraints || 'Not provided.',
      '### Candidate code or explanation', brief.candidateAttempt ? fenced(brief.candidateAttempt) : 'Not provided.')
  }
  sections.push('## Notes', session.notes || 'No notes saved.', '## Transcript')
  if (session.transcriptIncomplete) sections.push('> The transcript may be incomplete: capture ended before all speech was finalized.')
  const turns = session.transcript.filter(turn => turn.sessionId === session.id).slice().sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  for (const turn of turns) sections.push(`**${turn.channel}** · ${timestamp(turn.timestamp)}${turn.provisional ? ' · Provisional, not finalized' : ''}`, turn.text)
  if (!turns.length) sections.push('No transcript saved.')

  sections.push('## Answers')
  const answers = session.answers.filter(answer => answer.sessionId === session.id)
  for (const [index, answer] of answers.entries()) {
    const metadata = [`- Status: ${statusLabels[answer.status]}`, `- Model: ${inline(answer.model)}`, `- Requested: ${timestamp(answer.createdAt)}`]
    if (typeof answer.firstTokenMs === 'number' && Number.isFinite(answer.firstTokenMs) && answer.firstTokenMs >= 0) metadata.push(`- First text: ${answer.firstTokenMs} ms`)
    if (typeof answer.totalMs === 'number' && Number.isFinite(answer.totalMs) && answer.totalMs >= 0) metadata.push(`- Total time: ${answer.totalMs} ms`)
    if (answer.context) metadata.push(`- Included context: ${answer.context.transcriptIds.length} transcript turns, ${answer.context.attachmentIds.length} images, ${answer.context.priorAnswerIds.length} prior answers, ${answer.context.memorySourceIds.length} selected prior-session excerpts${answer.context.truncated ? ' (trimmed to the request budget)' : ''}`)
    sections.push(`### ${actionLabels[answer.action]}`, metadata.join('\n'))
    if (answer.status !== 'complete') sections.push('> This response is incomplete. Treat any partial answer as unfinished.')
    if (answer.usedPartialContext) sections.push('> This response used provisional speech that was still being finalized. Check uncertain details against the completed transcript.')
    if (answer.prompt) sections.push('#### Request', answer.prompt)
    sections.push('#### Response', linkedTranscriptMarkdown(answer.text || 'No response text available.', answerReferences(answer), `answer-${index + 1}-source`))
    if (answer.error) sections.push('#### Error', answer.error)
  }
  if (!answers.length) sections.push('No answers saved.')

  const attachments = session.attachments.filter(image => image.sessionId === session.id)
  if (attachments.length) sections.push('## Image metadata', ...attachments.map(image => `- ${inline(image.name)} (${image.width} × ${image.height} pixels)`))
  return sections.join('\n\n') + '\n'
}
