import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt, type CompiledPrompt } from '../src/main/prompts'
import { INTERVIEW_CONVERSATION_LIMITS } from '../src/main/interview-conversation'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Answer, type AudioChannel, type Session, type TranscriptTurn } from '../src/shared/types'

function session(): Session {
  return { id: 'conversation', title: 'Graph interview', mode: 'interview', status: 'recording', createdAt: 0, updatedAt: 0, notes: '', transcript: [], answers: [], attachments: [], selectedAttachmentIds: [], contextEpoch: 0, interview: { ...DEFAULT_INTERVIEW_CONTEXT, problem: 'Find a shortest path in an unweighted graph.' } }
}
function turn(current: Session, id: string, channel: TranscriptTurn['channel'], text: string, timestamp: number, patch: Partial<TranscriptTurn> = {}): void {
  current.transcript.push({ id, sessionId: current.id, channel, text, timestamp, ...patch })
}
function compile(current: Session, target = 'trigger', source: AudioChannel = 'system', channels: AudioChannel[] = ['system', 'microphone']) {
  return compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [], replyTarget: target, automatic: { source, channels } })
}
function data(compiled: CompiledPrompt): any {
  const content = compiled.input.at(-1)!.content
  assert(Array.isArray(content)); const source = content.find(part => part.type === 'input_text'); assert(source?.type === 'input_text')
  return JSON.parse(source.text)
}

test('automatic interview receives candidate reasoning before and after the exact trigger without claiming diarization', () => {
  const current = session()
  turn(current, 'thinking', 'microphone', 'I could use a queue to process one distance layer at a time.', 1)
  turn(current, 'trigger', 'system', 'Why did you choose BFS instead of DFS?', 2)
  turn(current, 'candidate-answer', 'microphone', 'BFS finds shortest paths in an unweighted graph because it visits increasing distance layers.', 3)
  const compiled = compile(current), context = data(compiled).interviewConversation
  assert.equal(context.trigger.turnId, 'trigger')
  assert.deepEqual(context.recentObservations.map((item: any) => item.turnId), ['thinking', 'trigger', 'candidate-answer'])
  assert.equal(context.recentObservations.at(-1).relativeToTarget, 'observed_after_trigger')
  assert.equal(context.recentObservations.at(-1).speaker, undefined)
  assert.match(context.sourceHints, /source hints, not verified speaker identities/)
  assert.match(compiled.instructions, /candidate speech observed after the trigger already answers that question adequately, WAIT/)
  assert.equal(compiled.sources.replyTargetId, 'trigger')
  assert(compiled.sources.transcriptIds.includes('candidate-answer'))
})

test('in-person microphone capture keeps roles unknown and self-questioning is not automatically an interviewer request', () => {
  const current = session()
  turn(current, 'trigger', 'microphone', 'I think BFS works here. Why would I need a visited set? Let me reason through a cycle.', 1)
  const compiled = compile(current, 'trigger', 'microphone', ['microphone'])
  const context = data(compiled).interviewConversation
  assert.match(context.sourceHints, /unknown speakers/)
  assert(!context.sourceHints.includes('Microphone speech may be candidate reasoning'))
  assert.match(compiled.instructions, /WAIT for candidate thinking aloud, self-questioning/)
  assert.match(compiled.instructions, /A candidate may ask a genuine question and an interviewer may use first-person wording/)
})

for (const [name, utterance] of [
  ['question', 'Why use BFS instead of DFS?'],
  ['imperative', 'Explain the invariant that makes the queue correct.'],
  ['correction', 'No, the edge weights may be negative. Reconsider your algorithm.'],
  ['candidate quotation', 'They asked why BFS instead of DFS. I will explain the distance layers.'],
  ['acknowledgment', 'Okay, that makes sense.'],
  ['hypothetical', 'What if each edge had a nonnegative cost instead?'],
] as const) {
  test(`intent evidence remains quoted and the model, not a keyword rule, decides: ${name}`, () => {
    const current = session(); turn(current, 'trigger', 'system', utterance, 1)
    const compiled = compile(current), context = data(compiled).interviewConversation
    assert.equal(context.trigger.excerpts[0].text, utterance)
    assert.equal(context.trigger.intent, undefined)
    assert.equal(context.trigger.speaker, undefined)
    assert.match(compiled.instructions, /ASSIST for an interviewer question or instruction/)
    assert.match(compiled.instructions, /changed constraint requiring a response even without a question mark/)
    assert.match(compiled.instructions, /A question mark alone does not establish interviewer intent/)
    assert.match(compiled.instructions, /For a hypothetical interviewer challenge, ASSIST with conditional reasoning/)
    assert(!compiled.instructions.includes(utterance))
  })
}

test('recorded prior targets remain paired with their answers when later candidate speech is also in context', () => {
  const current = session()
  turn(current, 'earlier-question', 'system', 'Why BFS instead of DFS?', 1)
  turn(current, 'candidate-progress', 'microphone', 'I have initialized my queue.', 2)
  const prior = compile(current, 'earlier-question')
  const answer: Answer = { id: 'prior-reply', requestId: 'prior', sessionId: current.id, action: 'reply', prompt: '', text: 'BFS visits increasing distance layers.', status: 'complete', model: 'fixture', createdAt: 3, context: prior.sources }
  current.answers.push(answer)
  turn(current, 'trigger', 'system', 'And why mark a node visited when enqueuing it?', 4)
  const compiled = compile(current), context = data(compiled).interviewConversation
  assert.equal(context.priorSuggestions[0].addressedUtterance.turnId, 'earlier-question')
  assert.equal(context.priorSuggestions[0].targetAttribution, 'recorded_target')
  assert.equal(context.priorSuggestions[0].source, 'generated_suggestion_not_spoken_evidence')
  const request = compiled.input.find(message => message.role === 'user' && typeof message.content === 'string')!
  assert.equal(JSON.parse(request.content as string).text, 'Why BFS instead of DFS?')
  assert.equal(data(compiled).interviewSituation.exchanges[0].request.excerpts[0].text, 'Why BFS instead of DFS?')
})

test('conversation observations are bounded, exact, immutable, same-session and exclude future selected-source turns', () => {
  const current = session()
  for (let index = 0; index < 30; index++) turn(current, `before-${index}`, index % 2 ? 'microphone' : 'system', `Beginning ${index} ${'x'.repeat(1_000)} Ending ${index}`, index)
  turn(current, 'trigger', 'system', 'Explain the selected approach.', 31)
  for (let index = 0; index < 8; index++) turn(current, `after-${index}`, 'microphone', `Candidate ${index} ${'y'.repeat(1_000)} conclusion`, 32 + index)
  turn(current, 'future-question', 'system', 'FUTURE_SELECTED_SOURCE', 40)
  turn(current, 'foreign', 'microphone', 'FOREIGN_MARKER', 41, { sessionId: 'other' })
  turn(current, 'unfinished', 'microphone', 'PROVISIONAL_MARKER', 42, { provisional: true })
  const compiled = compile(current), context = data(compiled).interviewConversation
  assert(context.recentObservations.length <= INTERVIEW_CONVERSATION_LIMITS.turns)
  const characters = context.recentObservations.reduce((total: number, item: any) => total + item.excerpts.reduce((sum: number, part: any) => sum + part.text.length, 0), 0)
  assert(characters <= INTERVIEW_CONVERSATION_LIMITS.characters)
  for (const item of context.recentObservations) for (const part of item.excerpts) assert.equal(part.text, current.transcript.find(turn => turn.id === item.turnId)!.text.slice(part.start, part.end))
  assert(!JSON.stringify(context).includes('FUTURE_SELECTED_SOURCE'))
  assert(!JSON.stringify(context).includes('FOREIGN_MARKER'))
  assert(!JSON.stringify(context).includes('PROVISIONAL_MARKER'))
  assert(!JSON.stringify(data(compiled).transcript).includes('FUTURE_SELECTED_SOURCE'))
  assert(!JSON.stringify(data(compiled).transcript).includes('PROVISIONAL_MARKER'))
  assert.equal(context.truncated, true)
  context.recentObservations[0].excerpts[0].text = 'Mutated output'
  assert(!current.transcript.some(turn => turn.text === 'Mutated output'))
})

test('the exact target remains pinned when later candidate reasoning exceeds both transcript budgets', () => {
  const current = session(); turn(current, 'trigger', 'system', 'Why is the queue invariant correct?', 1)
  for (let index = 0; index < 100; index++) turn(current, `candidate-${index}`, 'microphone', `Candidate thought ${index}: ${'r'.repeat(1_000)}`, 2 + index)
  const compiled = compile(current), source = data(compiled)
  assert(source.transcript.length <= 60)
  assert(source.transcript.reduce((total: number, item: any) => total + item.text.length, 0) <= 8_000)
  assert(source.transcript.some((item: any) => item.id === 'trigger' && item.text === 'Why is the queue invariant correct?'))
  assert.equal(source.interviewConversation.trigger.turnId, 'trigger')
  assert.equal(source.interviewConversation.recentObservations.at(-1).turnId, 'candidate-99')
  assert(compiled.sources.transcriptIds.includes('trigger'))
  assert.equal(compiled.sources.truncated, true)
})

test('manual and meeting replies keep ordinary output and malformed automatic source metadata is rejected', () => {
  const current = session(); turn(current, 'trigger', 'system', 'Why BFS?', 1)
  const manual = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  const meeting = compile({ ...current, mode: 'meeting' })
  for (const compiled of [manual, meeting]) { assert(!compiled.instructions.includes('Automatic interview response protocol')); assert.equal(data(compiled).interviewConversation, undefined) }
  assert.throws(() => compile(current, 'trigger', 'microphone', ['microphone']), /selected question audio/)
  assert.throws(() => compile(current, 'trigger', 'system', ['microphone']), /automatic reply source/)
  assert.throws(() => compile(current, 'trigger', 'system', ['system', 'system']), /automatic reply source/)
})
