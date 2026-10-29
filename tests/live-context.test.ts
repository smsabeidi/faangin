import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt, ContextError, type CompiledPrompt } from '../src/main/prompts'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type InterviewContext, type Session, type TranscriptTurn } from '../src/shared/types'

function session(transcript: TranscriptTurn[], patch: Partial<Session> = {}): Session {
  return { id: 'live-interview', title: 'Practice', mode: 'interview', status: 'recording', createdAt: 1, updatedAt: 1, notes: '', transcript, answers: [], attachments: [], contextEpoch: 0, ...patch }
}

function turn(id: string, text: string, timestamp: number, patch: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return { id, sessionId: 'live-interview', channel: 'system', text, timestamp, ...patch }
}

type TranscriptSource = Pick<TranscriptTurn, 'id' | 'channel' | 'timestamp' | 'text' | 'provisional'>
function sourceData(compiled: CompiledPrompt): { transcript: TranscriptSource[]; interview?: InterviewContext; truncated: boolean; interviewSituation?: { truncated: boolean; omittedEvidenceTurns: number } } {
  const content = compiled.input.at(-1)?.content
  assert(Array.isArray(content))
  const source = content.find(part => part.type === 'input_text')
  assert(source?.type === 'input_text')
  return JSON.parse(source.text)
}

function turns(count: number, characters: number): TranscriptTurn[] {
  return Array.from({ length: count }, (_, i) => turn(`turn-${i}`, `Utterance ${i}: `.padEnd(characters, 'x'), i + 1))
}

test('live speech can support a solution but remains explicitly provisional in data, instructions and source metadata', () => {
  const current = session([turn('live-question', 'PARTIAL_REFERENCE_MARKER: find two distinct indices adding up to the target.', 10, { provisional: true })])
  const compiled = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.transcriptIds, ['live-question'])
  assert.equal(compiled.sources.provisional, true)
  assert.equal(sourceData(compiled).transcript[0].provisional, true)
  assert(compiled.instructions.includes('may change when transcription finishes'))
  assert(compiled.instructions.includes('do not treat unfinished speech as a confirmed requirement'))
  assert(!compiled.instructions.includes('PARTIAL_REFERENCE_MARKER'))

  const finalized = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: session([turn('live-question', 'Find two distinct indices adding up to the target.', 10)]), attachments: [] })
  assert.equal(finalized.sources.provisional, false)
  assert.equal(sourceData(finalized).transcript[0].provisional, undefined)
  assert(!finalized.instructions.includes('Some current speech is marked provisional'))
})

test('Notes and Recap use finalized speech only and reject sessions containing solely provisional speech', () => {
  const final = turn('final-decision', 'We agreed to investigate the duplicate-index bug.', 10)
  const provisional = turn('unfinished', 'UNCONFIRMED_MARKER: perhaps ship without fixing it', 20, { provisional: true })
  for (const action of ['notes', 'recap'] as const) {
    const compiled = compilePrompt({ action, settings: DEFAULT_SETTINGS, session: session([final, provisional]), attachments: [] })
    assert.deepEqual(compiled.sources.transcriptIds, ['final-decision'])
    assert.equal(compiled.sources.provisional, false)
    assert.deepEqual(sourceData(compiled).transcript.map(item => item.id), ['final-decision'])
    assert(!JSON.stringify(compiled.input).includes('UNCONFIRMED_MARKER'))
    assert(!compiled.instructions.includes('Some current speech is marked provisional'))
    assert.throws(() => compilePrompt({ action, settings: DEFAULT_SETTINGS, session: session([provisional]), attachments: [] }), ContextError)
  }
})

test('foreign-session provisional speech cannot supply context or contaminate provisional metadata', () => {
  const foreign = turn('foreign-live-question', 'FOREIGN_PARTIAL_MARKER', 20, { sessionId: 'another-session', provisional: true })
  assert.throws(() => compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: session([foreign]), attachments: [] }), ContextError)
  const compiled = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: session([turn('own-question', 'Find the pair of distinct indices.', 10), foreign]), attachments: [] })
  assert.deepEqual(compiled.sources.transcriptIds, ['own-question'])
  assert.equal(compiled.sources.provisional, false)
  assert(!JSON.stringify(compiled.input).includes('FOREIGN_PARTIAL_MARKER'))
})

test('Fast interview context retains the latest sixty turns and keeps the saved brief intact', () => {
  const interview: InterviewContext = { ...DEFAULT_INTERVIEW_CONTEXT, problem: 'SAVED_PROBLEM_MARKER'.padEnd(8_000, 'p'), constraints: 'SAVED_CONSTRAINT_MARKER'.padEnd(4_000, 'c'), candidateAttempt: 'SAVED_ATTEMPT_MARKER'.padEnd(12_000, 'a'), stage: 'verify' }
  const compiled = compilePrompt({ action: 'review', settings: DEFAULT_SETTINGS, session: session(turns(90, 100), { interview }), attachments: [] })
  const data = sourceData(compiled)
  assert.equal(data.transcript.length, 60)
  assert.deepEqual(data.transcript.map(item => item.id), Array.from({ length: 60 }, (_, i) => `turn-${i + 30}`))
  assert(data.transcript.reduce((sum, item) => sum + item.text.length, 0) <= 8_000)
  assert.equal(data.interview?.problem, interview.problem)
  assert.equal(data.interview?.constraints, interview.constraints)
  assert.equal(data.interview?.candidateAttempt, interview.candidateAttempt)
  assert.equal(data.interview?.stage, 'verify')
  assert.equal(compiled.sources.truncated, true)
  assert.equal(data.truncated, true)
})

test('Fast interview character budget is eight thousand characters even when fewer than sixty turns exist', () => {
  const compiled = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: session(turns(20, 1_000)), attachments: [] })
  const data = sourceData(compiled)
  assert.equal(data.transcript.reduce((sum, item) => sum + item.text.length, 0), 8_000)
  assert.deepEqual(data.transcript.map(item => item.id), Array.from({ length: 8 }, (_, i) => `turn-${i + 12}`))
  assert.equal(compiled.sources.truncated, true)
})

test('Smart interview context uses the larger budget and explicit request policy overrides the saved preference', () => {
  const current = session(turns(90, 100))
  for (const options of [{ settings: { ...DEFAULT_SETTINGS, smartMode: true } }, { settings: DEFAULT_SETTINGS, smart: true }]) {
    const compiled = compilePrompt({ action: 'solve', session: current, attachments: [], ...options })
    assert.equal(sourceData(compiled).transcript.length, 90)
    assert.equal(sourceData(compiled).transcript.reduce((sum, item) => sum + item.text.length, 0), 9_000)
    assert.equal(sourceData(compiled).interviewSituation?.truncated, true)
    assert.equal(compiled.sources.truncated, true, 'the full Smart transcript fits, but the separate situation evidence is still bounded and must report its omissions')
  }
  const explicitFast = compilePrompt({ action: 'solve', settings: { ...DEFAULT_SETTINGS, smartMode: true }, smart: false, session: current, attachments: [] })
  assert.equal(sourceData(explicitFast).transcript.length, 60)
  assert.equal(explicitFast.sources.truncated, true)
})

test('Smart context still bounds old turns and long transcripts and accurately reports truncation', () => {
  const tooMany = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, smart: true, session: session(turns(250, 100)), attachments: [] })
  assert.equal(sourceData(tooMany).transcript.length, 200)
  assert.equal(sourceData(tooMany).transcript[0].id, 'turn-50')
  assert.equal(sourceData(tooMany).transcript.at(-1)?.id, 'turn-249')
  assert.equal(tooMany.sources.truncated, true)

  const tooLong = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, smart: true, session: session(turns(60, 1_000)), attachments: [] })
  assert.equal(sourceData(tooLong).transcript.reduce((sum, item) => sum + item.text.length, 0), 24_000)
  assert.equal(sourceData(tooLong).transcript[0].id, 'turn-36')
  assert.equal(tooLong.sources.truncated, true)
})

test('meeting actions and interview Notes or Recap retain the larger conversation budget in Fast mode', () => {
  const transcript = turns(90, 100)
  for (const action of ['notes', 'recap'] as const) {
    const compiled = compilePrompt({ action, settings: DEFAULT_SETTINGS, session: session(transcript), attachments: [] })
    assert.equal(sourceData(compiled).transcript.length, 90)
    assert.equal(compiled.sources.truncated, false)
  }
  const meeting = compilePrompt({ action: 'assist', settings: DEFAULT_SETTINGS, session: session(transcript, { mode: 'meeting' }), attachments: [] })
  assert.equal(sourceData(meeting).transcript.length, 90)
  assert.equal(meeting.sources.truncated, false)
})

test('provisional metadata reflects only speech actually included after budget trimming', () => {
  const oldPartial = turn('old-partial', 'OMITTED_PARTIAL_MARKER', 0, { provisional: true })
  const current = session([oldPartial, ...turns(60, 100)])
  const fast = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.equal(fast.sources.provisional, false)
  assert(!JSON.stringify(fast.input).includes('OMITTED_PARTIAL_MARKER'))
  assert(!fast.instructions.includes('Some current speech is marked provisional'))

  const smart = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, smart: true, session: current, attachments: [] })
  assert.equal(smart.sources.provisional, true)
  assert(smart.sources.transcriptIds.includes('old-partial'))
  assert(smart.instructions.includes('Some current speech is marked provisional'))
})

test('captured timestamps sort finalized and provisional context independently of arrival without mutating the snapshot', () => {
  const arrivalOrder = [turn('latest-partial', 'Newest unfinished follow-up.', 30, { provisional: true }), turn('middle-answer', 'Candidate explains the approach.', 20, { channel: 'microphone' }), turn('first-question', 'Interviewer asks the problem.', 10)]
  const current = session(arrivalOrder)
  const compiled = compilePrompt({ action: 'assist', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.transcriptIds, ['first-question', 'middle-answer', 'latest-partial'])
  assert.deepEqual(sourceData(compiled).transcript.map(item => item.timestamp), [10, 20, 30])
  assert.deepEqual(current.transcript.map(item => item.id), ['latest-partial', 'middle-answer', 'first-question'])
  assert.equal(compiled.sources.provisional, true)
})
