import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionMarkdown } from '../src/main/session-export'
import { DEFAULT_INTERVIEW_CONTEXT, type Answer, type Session } from '../src/shared/types'

function session(patch: Partial<Session> = {}): Session {
  return { id: 'session', title: 'Two Sum practice', mode: 'interview', status: 'ended', createdAt: 1_000, updatedAt: 3_000, endedAt: 3_000, notes: 'Check distinct indices.', transcript: [], answers: [], attachments: [], contextEpoch: 0, ...patch }
}

function answer(patch: Partial<Answer> = {}): Answer {
  return { id: 'answer', requestId: 'request', sessionId: 'session', action: 'solve', prompt: 'Solve the pair-of-indices problem.', text: 'Use a hash map.\n\n```python\nreturn result\n```', model: 'gpt-4.1-mini', status: 'complete', createdAt: 2_000, ...patch }
}

test('export carries durable transcript incompleteness and bounded-context provenance without raw image data', () => {
  const markdown = sessionMarkdown(session({ transcriptIncomplete: true, answers: [answer({ context: { transcriptIds: ['turn'], attachmentIds: ['image'], priorAnswerIds: [], memorySourceIds: ['memory'], truncated: true } })] }))
  assert.match(markdown, /transcript may be incomplete/)
  assert.match(markdown, /1 transcript turns, 1 images, 0 prior answers, 1 selected prior-session excerpts \(trimmed/)
  assert(!markdown.includes('data:image'))
})

test('Markdown export preserves interview requirements and code inside a fence that cannot close early', () => {
  const attempt = "```python\ndef solve(nums, target):\n    print('````')\n    return [0, 0]\n```"
  const current = session({ interview: { ...DEFAULT_INTERVIEW_CONTEXT, company: 'Example company', role: 'Senior engineer', round: 'coding', stage: 'verify', problem: 'Find two distinct indices whose values sum to target.', constraints: 'Negative values and duplicates are allowed.', candidateAttempt: attempt }, answers: [answer()] })
  const markdown = sessionMarkdown(current)
  assert(markdown.startsWith('# Two Sum practice\n'))
  assert(markdown.includes('Created: 1970-01-01T00:00:01.000Z'))
  assert(markdown.includes('Ended: 1970-01-01T00:00:03.000Z'))
  assert(markdown.includes('Company: Example company'))
  assert(markdown.includes('Role: Senior engineer'))
  assert(markdown.includes('Round: Coding'))
  assert(markdown.includes('Stage: Verify and test'))
  assert(markdown.includes(current.interview!.problem))
  assert(markdown.includes(current.interview!.constraints))
  assert(markdown.includes(`\n\n\`\`\`\`\`\n${attempt}\n\`\`\`\`\`\n\n`))
  assert(markdown.includes('## Notes\n\nCheck distinct indices.'))
  assert(markdown.includes('Solve the pair-of-indices problem.'))
  assert(markdown.includes(answer().text))
})

test('meeting export excludes interview brief even when one exists on the supplied object', () => {
  const markdown = sessionMarkdown(session({ mode: 'meeting', interview: { ...DEFAULT_INTERVIEW_CONTEXT, company: 'PRIVATE_COMPANY_MARKER', problem: 'PRIVATE_PROBLEM_MARKER', candidateAttempt: 'PRIVATE_ATTEMPT_MARKER' }, notes: 'Meeting action items.' }))
  assert(markdown.includes('Mode: Meeting'))
  assert(markdown.includes('Meeting action items.'))
  assert(!markdown.includes('Interview brief'))
  assert(!markdown.includes('PRIVATE_'))
})

test('cancelled, failed and streaming answers retain partial text, error and timing with explicit incomplete status', () => {
  const answers = [answer({ id: 'cancelled', status: 'cancelled', text: 'PARTIAL_CANCELLED_TEXT', firstTokenMs: 0, totalMs: 500 }), answer({ id: 'failed', action: 'debug', status: 'failed', text: 'PARTIAL_FAILED_TEXT', error: 'Provider disconnected.', firstTokenMs: 220, totalMs: 800 }), answer({ id: 'streaming', action: 'hint', status: 'streaming', text: 'PARTIAL_STREAMING_TEXT', usedPartialContext: true })]
  const markdown = sessionMarkdown(session({ answers }))
  for (const text of ['PARTIAL_CANCELLED_TEXT', 'PARTIAL_FAILED_TEXT', 'PARTIAL_STREAMING_TEXT']) assert(markdown.includes(text))
  assert(markdown.includes('Cancelled — incomplete'))
  assert(markdown.includes('Failed — incomplete'))
  assert(markdown.includes('In progress — incomplete'))
  assert.equal(markdown.match(/This response is incomplete/g)?.length, 3)
  assert(markdown.includes('Provider disconnected.'))
  assert(markdown.includes('First text: 0 ms'))
  assert(markdown.includes('First text: 220 ms'))
  assert(markdown.includes('Total time: 800 ms'))
  assert(markdown.includes('Model: gpt-4.1-mini'))
  assert(markdown.includes('### Debugging'))
  assert(markdown.includes('### Hint'))
  assert(markdown.includes('used provisional speech'))
})

test('transcripts are exported in capture order with source labels and timestamps without mutating the input', () => {
  const current = session({ transcript: [{ id: 'later', sessionId: 'session', channel: 'microphone', text: 'LATER_CANDIDATE_ANSWER', timestamp: 2_000 }, { id: 'earlier', sessionId: 'session', channel: 'system', text: 'EARLIER_INTERVIEWER_QUESTION', timestamp: 1_000 }] })
  const markdown = sessionMarkdown(current)
  assert(markdown.indexOf('EARLIER_INTERVIEWER_QUESTION') < markdown.indexOf('LATER_CANDIDATE_ANSWER'))
  assert(markdown.includes('**system** · 1970-01-01T00:00:01.000Z'))
  assert(markdown.includes('**microphone** · 1970-01-01T00:00:02.000Z'))
  assert.deepEqual(current.transcript.map(turn => turn.id), ['later', 'earlier'])
})

test('image exports contain metadata only and never serialize data URLs or image payloads', () => {
  const markdown = sessionMarkdown(session({ attachments: [{ id: 'image', sessionId: 'session', name: 'problem.png', width: 1280, height: 800, createdAt: 1, dataUrl: 'data:image/png;base64,RAW_IMAGE_PAYLOAD_MARKER' }] }))
  assert(markdown.includes('problem.png (1280 × 800 pixels)'))
  assert(!markdown.includes('data:image'))
  assert(!markdown.includes('RAW_IMAGE_PAYLOAD_MARKER'))
})

test('export keeps other-session transcript, answers and image metadata out of the document', () => {
  const markdown = sessionMarkdown(session({ transcript: [{ id: 'foreign-turn', sessionId: 'other-session', channel: 'system', text: 'FOREIGN_TRANSCRIPT_MARKER', timestamp: 1 }], answers: [answer({ sessionId: 'other-session', text: 'FOREIGN_ANSWER_MARKER' })], attachments: [{ id: 'foreign-image', sessionId: 'other-session', name: 'FOREIGN_IMAGE_MARKER.png', width: 1, height: 1, createdAt: 1, dataUrl: 'data:image/png;base64,FOREIGN_PAYLOAD' }] }))
  assert(!markdown.includes('FOREIGN_'))
  assert(markdown.includes('No transcript saved.'))
  assert(markdown.includes('No answers saved.'))
})

test('invalid historical timestamps do not prevent exporting recoverable session content', () => {
  const markdown = sessionMarkdown(session({ createdAt: Number.MAX_SAFE_INTEGER, transcript: [{ id: 'turn', sessionId: 'session', channel: 'manual', text: 'Recoverable context.', timestamp: Number.MAX_SAFE_INTEGER }], answers: [answer({ createdAt: Number.MAX_SAFE_INTEGER, status: 'failed', text: '' })] }))
  assert(markdown.includes('Created: Unknown time'))
  assert(markdown.includes('Recoverable context.'))
  assert(markdown.includes('No response text available.'))
  assert(markdown.includes('Failed — incomplete'))
})
