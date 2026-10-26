import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt, type CompiledPrompt } from '../src/main/prompts'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Action, type Answer, type InterviewContext, type Session, type TranscriptTurn } from '../src/shared/types'
import { INTERVIEW_SITUATION_LIMITS } from '../src/main/interview-situation'

function session(brief: Partial<InterviewContext> = {}): Session {
  return { id: 'situation', title: 'Interview', mode: 'interview', status: 'recording', createdAt: 0, updatedAt: 0, notes: '', transcript: [], answers: [], attachments: [], selectedAttachmentIds: [], contextEpoch: 0, interview: { ...DEFAULT_INTERVIEW_CONTEXT, problem: 'Find a shortest path in a graph.', constraints: 'Edges are unweighted.', ...brief } }
}
function turn(current: Session, id: string, text: string, timestamp: number, patch: Partial<TranscriptTurn> = {}): void {
  current.transcript.push({ id, sessionId: current.id, channel: 'system', text, timestamp, ...patch })
}
function savedAnswer(current: Session, action: Action = 'solve', text = 'Use BFS with a deque.\n```python\ndef shortest_path(graph, start):\n    queue = deque([start])\n    distance = {start: 0}\n    while queue:\n        node = queue.popleft()\n        for neighbor in graph[node]:\n            if neighbor not in distance:\n                distance[neighbor] = distance[node] + 1\n                queue.append(neighbor)\n    return distance\n```\nThis relies on unit edge weights. O(V + E) time and O(V) auxiliary space.'): Answer {
  const compiled = compilePrompt({ action, prompt: 'Prepare the initial answer.', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  const answer: Answer = { id: 'baseline', requestId: 'initial-request', sessionId: current.id, action, prompt: 'Prepare the initial answer.', text, status: 'complete', model: 'fixture', createdAt: 10, context: compiled.sources }
  current.answers.push(answer)
  return answer
}
function data(compiled: CompiledPrompt): any {
  const input = compiled.input.at(-1)!.content
  assert(Array.isArray(input))
  const source = input.find(part => part.type === 'input_text')
  assert(source?.type === 'input_text')
  return JSON.parse(source.text)
}
function evidenceText(value: unknown): string { return JSON.stringify(value) }

const scenarios: Array<{ name: string; brief?: Partial<InterviewContext>; initialAction?: Action; action: Action; oldAnswer?: string; next: string; changedConstraints?: string; guidance: RegExp }> = [
  { name: 'actual nonnegative weighted graph revision', action: 'solve', next: 'The edges now have nonnegative weights. Update your implementation.', changedConstraints: 'Edge weights are arbitrary nonnegative integers.', guidance: /nonnegative-weight Dijkstra/ },
  { name: 'hypothetical negative-weight twist', action: 'reply', next: 'What if negative edge weights were allowed? I am asking hypothetically; keep our original requirements for now.', guidance: /hypothetical what-if/ },
  { name: 'cycles and memory constraint', action: 'solve', next: 'Cycles are allowed now and you only have O(1) auxiliary memory. Can the old implementation meet that?', changedConstraints: 'Cycles allowed; O(1) auxiliary memory.', guidance: /explain feasibility and what memory is counted/ },
  { name: 'system design scale and consistency revision', brief: { round: 'system-design', problem: 'Design a shared document service.', constraints: 'Read-heavy, eventual consistency is acceptable.' }, initialAction: 'design', action: 'design', oldAnswer: 'Use an API service, a primary datastore, asynchronous replicas, and a read-through cache. Assume 90% reads and eventual consistency.', next: 'Now assume 100,000 writes per second and all readers must see each accepted write immediately. How does your architecture change?', changedConstraints: '100,000 writes/s; strong read-after-write consistency for all readers.', guidance: /capacity estimates with units, APIs, storage, cache, partitioning and replication/ },
  { name: 'behavioral scenario pivot', brief: { round: 'behavioral', problem: 'Explain a real disagreement you handled.', constraints: 'Use only the supplied real experience.' }, initialAction: 'behavioral', action: 'behavioral', oldAnswer: 'Suggested STAR outline using your supplied story: discuss the disagreement, your listening, and the documented result. Do not add a metric.', next: 'Suppose the teammate still refused your proposal. What would you do in that hypothetical situation?', guidance: /separate a hypothetical response from an actual past event/ },
]

for (const scenario of scenarios) {
  test(`source-grounded scenario adaptation: ${scenario.name}`, () => {
    const current = session(scenario.brief)
    if (scenario.initialAction === 'behavioral') current.notes = 'Actual experience supplied: I listened to a teammate and we agreed to test both proposals.'
    const baseline = savedAnswer(current, scenario.initialAction, scenario.oldAnswer)
    if (scenario.changedConstraints) current.interview!.constraints = scenario.changedConstraints
    turn(current, 'twist', scenario.next, 20)
    const compiled = compilePrompt({ action: scenario.action, settings: DEFAULT_SETTINGS, session: current, attachments: [] })
    assert(compiled.sources.priorAnswerIds.includes(baseline.id))
    assert(compiled.input.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes(baseline.text.slice(0, 80))))
    const situation = data(compiled).interviewSituation
    assert.equal(situation.workingArtifacts.baselineAnswerId, baseline.id)
    assert.equal(situation.workingArtifacts.latestCompleteAnswerId, baseline.id)
    assert(evidenceText(situation.questionFocus).includes(scenario.next))
    assert(evidenceText(situation.evidenceSinceBaseline).includes(scenario.next))
    assert.deepEqual(situation.briefRevision.changedFields, scenario.changedConstraints ? ['constraints'] : [])
    assert.equal(situation.briefRevision.priorConstraints.excerpts[0].text, baseline.context!.interviewSnapshot!.constraints)
    assert.match(compiled.instructions, scenario.guidance)
    assert.match(compiled.instructions, /do not silently promote a hypothetical or candidate suggestion into an accepted requirement/)
    assert.equal(situation.activeRequirements, undefined)
    assert(!compiled.instructions.includes(scenario.next))
  })
}

test('competing utterances remain quoted evidence and do not become guessed requirement state or named speakers', () => {
  const current = session(); savedAnswer(current)
  turn(current, 'proposal', 'Could we use weighted edges as an optional extension?', 20, { channel: 'microphone' })
  turn(current, 'clarification', 'No, keep the original graph unweighted. The actual change is that cycles are allowed.', 21)
  turn(current, 'question', 'Would your current visited handling still work?', 22)
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  const situation = data(compiled).interviewSituation
  assert.deepEqual(situation.evidenceSinceBaseline.map((item: any) => item.turnId), ['proposal', 'clarification', 'question'])
  assert.equal(situation.evidenceSinceBaseline[0].channel, 'microphone')
  assert.equal(situation.evidenceSinceBaseline[0].speaker, undefined)
  assert.equal(situation.evidenceSinceBaseline[0].requirement, undefined)
  assert.match(compiled.instructions, /when evidence conflicts or adoption is unclear and affects correctness, ask one focused clarification/)
})

test('the first post-baseline requirement survives a long discussion and newest question suffix survives clipping', () => {
  const current = session(); savedAnswer(current)
  turn(current, 'early-revision', 'Important revision: edge weights may be zero or one.', 20)
  for (let index = 0; index < 320; index++) turn(current, `discussion-${index}`, `Discussion passage ${index}. `.padEnd(200, 'x'), 30 + index)
  turn(current, 'latest', `Question setup: ${'q'.repeat(20_000)} Finally, require O(1) auxiliary memory and explain whether that is feasible.`, 400)
  const compiled = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  const source = data(compiled), situation = source.interviewSituation
  assert(situation.evidenceSinceBaseline.some((item: any) => item.turnId === 'early-revision'))
  assert(compiled.sources.transcriptIds.includes('early-revision'))
  assert(situation.evidenceSinceBaseline.length <= INTERVIEW_SITUATION_LIMITS.evidenceTurns)
  const quotedCharacters = situation.evidenceSinceBaseline.reduce((sum: number, item: any) => sum + item.excerpts.reduce((count: number, part: any) => count + part.text.length, 0), 0)
  assert(quotedCharacters <= INTERVIEW_SITUATION_LIMITS.evidenceCharacters)
  assert(situation.omittedEvidenceTurns > 0)
  assert(evidenceText(situation.questionFocus).includes('Finally, require O(1) auxiliary memory'))
  assert(source.transcript.at(-1).text.includes('Finally, require O(1) auxiliary memory'))
  assert.equal(compiled.sources.truncated, true)
  for (const item of situation.evidenceSinceBaseline) {
    const original = current.transcript.find(turn => turn.id === item.turnId)!
    for (const part of item.excerpts) assert.equal(part.text, original.text.slice(part.start, part.end))
  }
})

test('interrupted solution drafts remain explicit untrusted user data alongside the complete implementation', () => {
  const current = session(); const baseline = savedAnswer(current)
  turn(current, 'weighted', 'Use positive edge weights now.', 20)
  current.interview!.constraints = 'Positive weighted edges.'
  const draftContext = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: current, attachments: [] }).sources
  current.answers.push({ ...baseline, id: 'interrupted', status: 'cancelled', text: 'INTERRUPTED_DIJKSTRA_DRAFT: initialize a heap, then ...', createdAt: 21, context: draftContext, interruption: { reason: 'new-speech', transcriptId: 'negative', at: 24 } })
  turn(current, 'negative', 'Actually, negative weights are possible too. Does that change your answer?', 24)
  const compiled = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.priorAnswerIds, ['baseline'])
  assert.deepEqual(compiled.sources.interruptedAnswerIds, ['interrupted'])
  const situation = data(compiled).interviewSituation
  assert.equal(situation.workingArtifacts.baselineAnswerId, 'baseline')
  assert.equal(situation.interruptedDrafts[0].status, 'interrupted_draft')
  assert.equal(situation.interruptedDrafts[0].trust, 'untrusted_reference_data')
  assert.equal(situation.interruptedDrafts[0].interruption.transcriptId, 'negative')
  assert(evidenceText(situation.interruptedDrafts).includes('INTERRUPTED_DIJKSTRA_DRAFT'))
  assert(!compiled.input.filter(message => message.role === 'assistant').some(message => evidenceText(message.content).includes('INTERRUPTED_DIJKSTRA_DRAFT')))
  assert.match(compiled.instructions, /never treat a draft as implemented, accepted or correct/)
})

test('a completed response retires its consumed draft while a newer interrupted draft remains eligible', () => {
  const current = session(); const baseline = savedAnswer(current)
  const firstDraft: Answer = { ...baseline, id: 'first-draft', status: 'cancelled', text: 'FIRST_DRAFT_MARKER', createdAt: 20, interruption: { reason: 'new-question', at: 22 } }
  current.answers.push(firstDraft)
  turn(current, 'question', 'How should we adapt the algorithm?', 22)
  const responseContext = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] }).sources
  assert.deepEqual(responseContext.interruptedAnswerIds, ['first-draft'])
  current.answers.push({ ...baseline, id: 'completed-reply', action: 'reply', text: 'Use the complete baseline and revise only the required invariant.', createdAt: 24, context: responseContext })
  turn(current, 'followup', 'Why is that revision sufficient?', 25)
  let compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.interruptedAnswerIds, [])
  assert.deepEqual(data(compiled).interviewSituation.interruptedDrafts, [])
  assert.equal(data(compiled).interviewSituation.workingArtifacts.latestCompleteAnswerId, baseline.id)
  current.answers.push({ ...baseline, id: 'newer-draft', status: 'cancelled', text: 'NEWER_DRAFT_MARKER', createdAt: 26, context: compiled.sources, interruption: { reason: 'new-speech', at: 27 } })
  turn(current, 'latest', 'And what if memory is limited?', 28)
  compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.interruptedAnswerIds, ['newer-draft'])
  assert(evidenceText(data(compiled).interviewSituation.interruptedDrafts).includes('NEWER_DRAFT_MARKER'))
  assert(!evidenceText(data(compiled).interviewSituation.interruptedDrafts).includes('FIRST_DRAFT_MARKER'))
})

test('a foreign or different-problem completed reference cannot retire the current interrupted draft', () => {
  for (const otherProblem of [false, true]) {
    const current = session(); const baseline = savedAnswer(current)
    current.answers.push({ ...baseline, id: 'current-draft', status: 'cancelled', text: 'CURRENT_DRAFT_MARKER', createdAt: 20, interruption: { reason: 'new-speech', at: 21 } })
    current.answers.push({ ...baseline, id: 'unrelated-completion', sessionId: otherProblem ? current.id : 'foreign-session', action: 'reply', text: 'Unrelated answer', createdAt: 24,
      context: { ...baseline.context!, interruptedAnswerIds: ['current-draft'], ...(otherProblem ? { interviewSnapshot: { ...baseline.context!.interviewSnapshot!, problem: 'An entirely different problem' } } : {}) } })
    turn(current, 'latest', 'How does the current draft affect your approach?', 25)
    const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
    assert.deepEqual(compiled.sources.interruptedAnswerIds, ['current-draft'])
    assert(evidenceText(data(compiled).interviewSituation.interruptedDrafts).includes('CURRENT_DRAFT_MARKER'))
  }
})

test('intentional cancellation, foreign drafts and new problem/image boundaries exclude stale implementation data', () => {
  const current = session(); const baseline = savedAnswer(current)
  current.answers.push({ ...baseline, id: 'cancelled', status: 'cancelled', text: 'INTENTIONALLY_CANCELLED', createdAt: 20 })
  current.answers.push({ ...baseline, id: 'foreign', sessionId: 'other', status: 'cancelled', text: 'FOREIGN_DRAFT', createdAt: 21, interruption: { reason: 'new-speech', at: 22 } })
  turn(current, 'latest', 'How would you adapt it?', 25)
  let compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.interruptedAnswerIds, [])
  assert(!JSON.stringify(compiled.input).includes('INTENTIONALLY_CANCELLED'))
  assert(!JSON.stringify(compiled.input).includes('FOREIGN_DRAFT'))
  current.answers = [baseline]
  current.interview!.problem = 'Design an unrelated payroll system.'
  for (const includeHistory of [false, true]) {
    compiled = compilePrompt({ action: 'design', settings: { ...DEFAULT_SETTINGS, includeHistory }, session: current, attachments: [] })
    assert.deepEqual(compiled.sources.priorAnswerIds, [])
    assert(!compiled.input.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('Use BFS')))
  }
  current.interview!.problem = baseline.context!.interviewSnapshot!.problem
  current.selectedAttachmentIds = ['another-problem-screenshot']
  compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.deepEqual(compiled.sources.priorAnswerIds, [])
})

test('meeting and finalized record actions do not acquire interview situation or interrupted drafts', () => {
  const current = session(); const baseline = savedAnswer(current)
  current.answers.push({ ...baseline, id: 'interrupted', status: 'cancelled', text: 'DRAFT_PRIVATE_MARKER', createdAt: 20, interruption: { reason: 'manual-takeover', at: 21 } })
  turn(current, 'words', 'Supported finalized words.', 25)
  for (const action of ['notes', 'recap', 'draft'] as const) {
    const compiled = compilePrompt({ action, settings: DEFAULT_SETTINGS, session: current, attachments: [] })
    assert.equal(data(compiled).interviewSituation, undefined)
    assert(!JSON.stringify(compiled.input).includes('DRAFT_PRIVATE_MARKER'))
  }
  const compiled = compilePrompt({ action: 'reply', settings: DEFAULT_SETTINGS, session: { ...current, mode: 'meeting' }, attachments: [] })
  assert.equal(data(compiled).interviewSituation, undefined)
})
