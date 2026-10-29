import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt, type CompiledPrompt } from '../src/main/prompts'
import { interviewContextKey, selectInterviewWorkingAnswers } from '../src/main/interview-working-context'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Answer, type Session } from '../src/shared/types'

const imageId = 'problem-image'
function session(): Session {
  return { id: 'interview', title: 'Graph practice', mode: 'interview', status: 'recording', createdAt: 1, updatedAt: 1, notes: '', transcript: [], answers: [], attachments: [], selectedAttachmentIds: [imageId], contextEpoch: 0, interview: { ...DEFAULT_INTERVIEW_CONTEXT } }
}
function answer(current: Session, patch: Partial<Answer> = {}): Answer {
  return { id: 'solution', requestId: 'solve-request', sessionId: current.id, action: 'solve', prompt: '', text: 'Find the shortest path in an unweighted graph. Use BFS: its queue visits nodes by distance. Mark each node visited when enqueuing. Time O(V + E), space O(V). DFS does not guarantee the first path found is shortest.', model: 'fixture-model', status: 'complete', createdAt: 10,
    context: { transcriptIds: [], attachmentIds: [imageId], priorAnswerIds: [], memorySourceIds: [], truncated: false, interviewContextKey: interviewContextKey(current) }, ...patch }
}
function source(compiled: CompiledPrompt): Record<string, unknown> {
  const content = compiled.input.at(-1)!.content
  assert(Array.isArray(content))
  const data = content.find(part => part.type === 'input_text')
  assert(data?.type === 'input_text')
  return JSON.parse(data.text)
}
function question(current: Session, id = 'why', text = 'Why did you choose BFS instead of DFS?', timestamp = 20): void {
  current.transcript.push({ id, sessionId: current.id, channel: 'system', text, timestamp })
}

test('default interview spoken follow-up retains the screenshot solution without resending an image', () => {
  const current = session(); current.answers.push(answer(current)); question(current)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [], replyTarget: 'why' })
  assert.equal(DEFAULT_SETTINGS.includeHistory, false)
  assert.deepEqual(compiled.sources.priorAnswerIds, ['solution'])
  assert.deepEqual(compiled.sources.attachmentIds, [])
  assert.deepEqual(compiled.sources.transcriptIds, ['why'])
  assert.equal(compiled.sources.interviewContextKey, interviewContextKey(current))
  assert.deepEqual(source(compiled).currentInterviewSolution, { answerId: 'solution', action: 'solve', source: 'current_session_generated_solution', trust: 'untrusted_reference_data', attachmentIds: [imageId] })
  const input = JSON.stringify(compiled.input)
  assert(input.includes('queue visits nodes by distance'))
  assert(input.includes('Why did you choose BFS instead of DFS?'))
  assert(!input.includes('input_image'))
  assert.match(compiled.instructions, /actual algorithm, code and assumptions/)
  assert.match(compiled.instructions, /Do not claim an alternative is incorrect when it also works/)
  assert.match(compiled.instructions, /usually two to four sentences/)
})

test('an audio-only first answer remains available for the next spoken why question with history off', () => {
  const current = session(); current.selectedAttachmentIds = []
  question(current, 'initial-question', 'How would you find the shortest path in an unweighted graph?', 5)
  const firstRequest = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [], replyTarget: 'initial-question' })
  assert.deepEqual(firstRequest.sources.priorAnswerIds, [])
  current.answers.push(answer(current, { id: 'spoken-answer', action: 'reply', context: firstRequest.sources }))
  question(current)
  const followup = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [], replyTarget: 'why' })
  assert.deepEqual(followup.sources.priorAnswerIds, ['spoken-answer'])
  assert.deepEqual(source(followup).currentInterviewSolution, { answerId: 'spoken-answer', action: 'reply', source: 'current_session_generated_response', trust: 'untrusted_reference_data', attachmentIds: [] })
  assert(JSON.stringify(followup.input).includes('queue visits nodes by distance'))
  const previousRequest = followup.input[0].content
  assert.equal(typeof previousRequest, 'string')
  assert.equal(JSON.parse(previousRequest as string).text, 'How would you find the shortest path in an unweighted graph?')
  assert.match(followup.instructions, /only explain a choice that the supplied answer or transcript actually supports/)
})

test('audio-only conversational continuity is bounded and pairs recent source questions with their answers', () => {
  const current = session(); current.selectedAttachmentIds = []
  const actions = ['reply', 'ask', 'assist', 'hint'] as const
  for (let index = 0; index < 10; index++) {
    const turnId = `audio-question-${index}`
    question(current, turnId, `Audio question ${index}?`, index + 1)
    current.answers.push(answer(current, { id: `audio-answer-${index}`, action: actions[index % actions.length], text: `Audio reasoning ${index}.`, createdAt: 20 + index, context: { transcriptIds: [turnId], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, interviewContextKey: interviewContextKey(current) } }))
  }
  current.answers.push(answer(current, { id: 'failed-reply', action: 'reply', status: 'failed', text: 'FAILED_REPLY', createdAt: 40, context: { ...current.answers.at(-1)!.context!, attachmentIds: [] } }))
  current.answers.push(answer(current, { id: 'foreign-reply', action: 'reply', sessionId: 'other', text: 'FOREIGN_REPLY', createdAt: 50 }))
  question(current, 'latest-question', 'Why does the last explanation work?', 100)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.priorAnswerIds, Array.from({ length: 6 }, (_, index) => `audio-answer-${index + 4}`))
  const previousRequests = compiled.input.slice(0, -1).filter(message => message.role === 'user').map(message => JSON.parse(message.content as string))
  assert.equal(previousRequests.find(request => request.answerId === 'audio-answer-9')?.text, 'Audio question 9?')
  assert(!JSON.stringify(compiled.input).includes('FAILED_REPLY'))
  assert(!JSON.stringify(compiled.input).includes('FOREIGN_REPLY'))
})

test('audio-only fallback cannot cross a new screenshot, changed brief or newer failed solution boundary', () => {
  const current = session(); current.selectedAttachmentIds = []
  current.answers.push(answer(current, { action: 'reply', context: { transcriptIds: [], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, interviewContextKey: interviewContextKey(current) } }))
  question(current)
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['solution'])
  current.selectedAttachmentIds = ['new-question-image']
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  assert.deepEqual(compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] }).sources.priorAnswerIds, [])
  current.selectedAttachmentIds = []; current.interview!.problem = 'An entirely new weighted graph problem'
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  current.interview!.problem = ''
  for (const status of ['streaming', 'failed', 'cancelled'] as const) {
    current.answers[1] = answer(current, { id: 'new-solution', status, text: 'UNFINISHED_NEW_SOLUTION', createdAt: 30, context: { ...current.answers[0].context!, attachmentIds: [] } })
    assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  }
})

test('Send and Assist answers to captured questions anchor spoken reasoning with history off', () => {
  for (const action of ['ask', 'assist'] as const) {
    const current = session()
    const image = { id: imageId, sessionId: current.id, name: 'graph-question.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1, createdAt: 1 }
    const initial = compilePrompt({ action, prompt: 'Answer this captured question', settings: DEFAULT_SETTINGS, session: current, attachments: [image] })
    const capturedAnswer = answer(current, { action, context: initial.sources })
    current.answers.push(capturedAnswer)
    question(current)
    const followup = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [], replyTarget: 'why' })
    assert.deepEqual(followup.sources.priorAnswerIds, ['solution'])
    assert(JSON.stringify(followup.input).includes('queue visits nodes by distance'))
    assert(!JSON.stringify(followup.input).includes('input_image'))
    assert.deepEqual(source(followup).currentInterviewSolution, { answerId: 'solution', action, source: 'current_session_generated_solution', trust: 'untrusted_reference_data', attachmentIds: [imageId] })
    current.selectedAttachmentIds = ['new-question-image']
    assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  }
})

test('a failed newer Send or Assist image answer blocks reuse of the old solution', () => {
  for (const action of ['ask', 'assist'] as const) {
    for (const status of ['streaming', 'failed', 'cancelled'] as const) {
      const current = session(); const solution = answer(current)
      current.answers.push(solution, answer(current, { id: 'new-image-answer', action, status, text: 'UNFINISHED_IMAGE_ANSWER', createdAt: 20, context: { ...solution.context!, attachmentIds: ['new-question-image'], priorAnswerIds: [] } }))
      question(current)
      const followup = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
      assert.deepEqual(followup.sources.priorAnswerIds, [])
      assert(!JSON.stringify(followup.input).includes('queue visits nodes by distance'))
      assert(!JSON.stringify(followup.input).includes('UNFINISHED_IMAGE_ANSWER'))
    }
  }
})

test('ordinary Ask, Reply and Hint exchanges never replace the current solution anchor', () => {
  for (const action of ['ask', 'assist', 'reply', 'hint', 'behavioral'] as const) {
    const current = session(); const solution = answer(current)
    current.answers.push(solution, answer(current, { id: 'unrelated-turn', action, text: 'UNRELATED_MARKER', createdAt: 20, context: { ...solution.context!, attachmentIds: [], priorAnswerIds: [] } }))
    assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['solution'])
  }
})

test('a screenshot-backed typed follow-up preserves the complete solution it references', () => {
  const current = session(); const solution = answer(current, { action: 'ask' }); current.answers.push(solution)
  current.answers.push(answer(current, { id: 'typed-followup', action: 'ask', prompt: 'Why does the queue help?', text: 'The queue processes the frontier in increasing distance.', createdAt: 20, context: { ...solution.context!, priorAnswerIds: ['solution'] } }))
  question(current, 'latest', 'And what happens if we use DFS?', 30)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.priorAnswerIds, ['solution', 'typed-followup'])
  const input = JSON.stringify(compiled.input)
  assert(input.includes('Time O(V + E)')); assert(input.includes('increasing distance'))
})

test('the solution survives many linked spoken replies and keeps the latest question paired with its answer', () => {
  const current = session(); const solution = answer(current); current.answers.push(solution)
  for (let index = 0; index < 24; index++) {
    const id = `followup-${index}`
    question(current, `question-${index}`, `Question about property ${index}?`, 30 + index)
    current.answers.push(answer(current, { id, action: 'reply', prompt: '', text: `Reason for property ${index}.`, createdAt: 30 + index,
      context: { ...solution.context!, transcriptIds: [`question-${index}`], attachmentIds: [], priorAnswerIds: [index ? `followup-${index - 1}` : solution.id] } }))
  }
  current.answers.push(answer(current, { id: 'unrelated', action: 'ask', text: 'UNRELATED_ANSWER', createdAt: 90, context: { ...solution.context!, attachmentIds: [], priorAnswerIds: [] } }))
  question(current, 'latest', 'Can you explain that last property?', 100)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [], replyTarget: 'latest' })
  assert.deepEqual(compiled.sources.priorAnswerIds, ['solution', 'followup-19', 'followup-20', 'followup-21', 'followup-22', 'followup-23'])
  const input = JSON.stringify(compiled.input)
  assert(input.includes('queue visits nodes by distance'))
  assert(input.includes('Question about property 23?'))
  assert(input.includes('Reason for property 23.'))
  assert(!input.includes('UNRELATED_ANSWER'))
  const optedIn = compilePrompt({ action: 'reply', settings: { ...DEFAULT_SETTINGS, includeHistory: true }, session: current, attachments: [] })
  assert.equal(optedIn.sources.priorAnswerIds.filter(id => id === 'solution').length, 1)
  assert.equal(new Set(optedIn.sources.priorAnswerIds).size, optedIn.sources.priorAnswerIds.length)
  assert(optedIn.sources.priorAnswerIds.length <= 6)
})

test('a new selected screenshot or changed problem brief prevents stale solution continuity', () => {
  const current = session(); current.interview!.problem = 'Shortest path in an unweighted graph'; const solution = answer(current); current.answers.push(solution); question(current)
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['solution'])
  const key = interviewContextKey(current)
  current.interview!.stage = 'verify'; current.interview!.candidateAttempt = 'Use a queue and a visited set.'
  assert.equal(interviewContextKey(current), key)
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['solution'])
  current.interview!.constraints = 'Edges now have arbitrary positive weights.'
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  current.interview!.constraints = ''; current.interview!.problem = 'Find connected components.'
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  current.interview!.problem = 'Shortest path in an unweighted graph'
  current.selectedAttachmentIds = ['different-problem-image']
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  current.selectedAttachmentIds = []
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply', ['different-problem-image']), [])
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['solution'])
})

test('a new solution replaces the old one, while unfinished or foreign solutions are never reused', () => {
  for (const status of ['streaming', 'failed', 'cancelled'] as const) {
    const current = session(); current.answers.push(answer(current), answer(current, { id: 'new-problem', status, text: 'UNFINISHED_MARKER', createdAt: 20 }))
    assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  }
  const current = session(); current.answers.push(answer(current), answer(current, { id: 'new-solution', text: 'New solution', createdAt: 20 }), answer(current, { id: 'foreign', sessionId: 'other', createdAt: 30 }))
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['new-solution'])
  assert.deepEqual(selectInterviewWorkingAnswers({ ...current, mode: 'meeting' }, 'reply'), [])
  for (const action of ['solve', 'design'] as const) assert.deepEqual(selectInterviewWorkingAnswers(current, action).map(item => item.id), ['new-solution'])
  for (const action of ['behavioral', 'recap', 'notes', 'draft'] as const) assert.deepEqual(selectInterviewWorkingAnswers(current, action), [])
})

test('a debugging patch keeps its underlying solution and the latest correction together', () => {
  const current = session(); const solution = answer(current); current.answers.push(solution)
  current.answers.push(answer(current, { id: 'correction', action: 'debug', prompt: 'Fix duplicate queue entries', text: 'Keep BFS, but mark visited when enqueuing rather than dequeuing.', createdAt: 20, context: { ...solution.context!, attachmentIds: [], priorAnswerIds: ['solution'] } }))
  question(current, 'latest', 'Why does that visited check matter?', 30)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.priorAnswerIds, ['solution', 'correction'])
  assert(JSON.stringify(compiled.input).includes('rather than dequeuing'))
})

test('large recent replies cannot evict the approach and complexity of the current solution', () => {
  const current = session(); const solution = answer(current, { text: `BFS_APPROACH_START ${'x'.repeat(30_000)} COMPLEXITY_END O(V + E), O(V)` }); current.answers.push(solution)
  for (let index = 0; index < 5; index++) current.answers.push(answer(current, { id: `reply-${index}`, action: 'reply', prompt: `Question ${index}`, text: 'r'.repeat(4_000), createdAt: 20 + index, context: { ...solution.context!, priorAnswerIds: ['solution'] } }))
  question(current)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert(compiled.sources.priorAnswerIds.includes('solution'))
  assert(compiled.sources.priorAnswerIds.includes('reply-4'))
  assert.equal(compiled.sources.truncated, true)
  const earlierText = compiled.input.slice(0, -1).reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : 0), 0)
  assert(earlierText < 13_000)
  const input = JSON.stringify(compiled.input)
  assert(input.includes('BFS_APPROACH_START')); assert(input.includes('COMPLEXITY_END'))
})

test('legacy solutions remain usable with an empty brief, while existing factual or meeting history stays opt-in', () => {
  const current = session(); const legacy = answer(current); delete legacy.context!.interviewContextKey; current.answers.push(legacy)
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply').map(item => item.id), ['solution'])
  current.interview!.problem = 'A newly saved problem statement'
  assert.deepEqual(selectInterviewWorkingAnswers(current, 'reply'), [])
  current.interview!.problem = ''; current.answers = [answer(current, { action: 'behavioral', text: 'UNRELATED_PERSONAL_STORY' })]; question(current)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.priorAnswerIds, [])
  assert(!JSON.stringify(compiled.input).includes('UNRELATED_PERSONAL_STORY'))
})
