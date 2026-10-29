import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compilePrompt, type CompiledPrompt } from '../src/main/prompts'
import { auditCompiledFixture, capacityEstimateIndicators, compareContextPayloads, evaluationReasoningTransport, evaluationCurrentRequest, HUMAN_REVIEW_DIMENSIONS, loadBaselineCompiler, promptFootprint, reviewAnswerIndicators, resolvedEvaluationReasoning, runLiveEvaluation, runOfflineEvaluation } from '../scripts/response-delivery-eval'
import { createInterviewResponseDecoder } from '../src/main/structured-interview-response'
import { DELIVERY_FIXTURES } from '../scripts/response-delivery-fixtures'

const framedAnswer = (compiled: CompiledPrompt, text: string) => compiled.responseProtocol === 'json' ? JSON.stringify({ disposition: 'assist', answer: text }) : `ASSIST\n${text}`

test('representative delivery fixtures preserve exact technical evidence and finalized automatic source boundaries', () => {
  assert.equal(DELIVERY_FIXTURES.length, 12)
  for (const fixture of DELIVERY_FIXTURES) {
    const compiled = compilePrompt(fixture.request)
    assert.deepEqual(auditCompiledFixture(fixture, compiled), { passed: true, missingSourceText: [], automaticPartialLeak: false, missingTranscriptIds: [], attachmentCount: 0, retainedPriorAnswerIds: compiled.sources.priorAnswerIds }, fixture.id)
  }
  const followup = DELIVERY_FIXTURES.find(item => item.id === 'focused-followup')!
  assert.deepEqual(compilePrompt(followup.request).sources.priorAnswerIds, ['bfs-solution'])
})

test('source audit rejects changed negation, identifier spelling, missing source ids and provisional leakage', () => {
  const fixture = DELIVERY_FIXTURES.find(item => item.id === 'imperfect-transcript')!
  const original = compilePrompt(fixture.request)
  const corrupted = structuredClone(original)
  corrupted.input = JSON.parse(JSON.stringify(corrupted.input).replaceAll('Do not retry HTTP 401', 'Do retry HTTP 401').replaceAll('request_id', 'requestId'))
  corrupted.sources.transcriptIds = []
  const audit = auditCompiledFixture(fixture, corrupted)
  assert.equal(audit.passed, false)
  assert.deepEqual(audit.missingSourceText, ['Do not retry HTTP 401', 'request_id, not requestId'])
  assert.deepEqual(audit.missingTranscriptIds, ['t1'])
  const partial = DELIVERY_FIXTURES.find(item => item.id === 'unfinished-question')!
  const leaked = compilePrompt(partial.request)
  leaked.input.push({ role: 'user', content: partial.request.session.transcript[1].text })
  assert.equal(auditCompiledFixture(partial, leaked).automaticPartialLeak, true)
})

test('automated indicators remain supporting evidence and never invent human judgments or token measurements', () => {
  const fixture = DELIVERY_FIXTURES.find(item => item.id === 'technical-correctness')!
  const review = reviewAnswerIndicators(fixture, 'Great question! BFS visits by distance. Time O(V + E), space O(V).')
  assert.equal(review.supportingEvidenceOnly, true)
  assert.equal(review.stockPhrases.length, 1)
  assert.ok(review.requiredFacts.every(item => item.observed))
  assert.deepEqual(review.humanReview, Object.fromEntries(HUMAN_REVIEW_DIMENSIONS.map(dimension => [dimension, null])))
  const footprint = promptFootprint(compilePrompt(fixture.request))
  assert.equal(footprint.tokenUsage.measured, false)
  assert.match(footprint.tokenUsage.reason, /not token estimates/)
})

test('generation checks retain explicit WAIT and flag unsupported behavioral metrics for review', () => {
  const unfinished = DELIVERY_FIXTURES.find(item => item.id === 'unfinished-question')!
  assert.equal(reviewAnswerIndicators(unfinished, '', 'wait').dispositionMatches, true)
  assert.equal(reviewAnswerIndicators(unfinished, 'Use a cache fallback.', 'assist').dispositionMatches, false)
  const behavioral = DELIVERY_FIXTURES.find(item => item.id === 'behavioral-grounding')!
  assert.equal(reviewAnswerIndicators(behavioral, 'I cut costs by 70%.').forbiddenClaims[0].flagged, true)
  assert.equal(reviewAnswerIndicators(behavioral, 'I wrote the rollback checklist.').forbiddenClaims[0].flagged, false)
})

test('paired offline audit loads the pinned original compiler and preserves output budgets', () => {
  const baseline = loadBaselineCompiler()
  try {
    const report = runOfflineEvaluation(baseline.compiler, { revision: baseline.revision, iterations: 2 })
    assert.equal(report.passed, true)
    assert.equal(report.generatedAnswers, false)
    assert.equal(report.caseCount, 12)
    assert.ok(report.cases.every(item => item.contextPayloadEquivalent && item.outputBudgetUnchanged))
    assert.ok(report.cases.every(item => item.variants.current.localCompileMs.samples === 2))
    assert.throws(() => runOfflineEvaluation(baseline.compiler, { iterations: 0 }), /iterations/)
  } finally { baseline.cleanup() }
})

test('capacity indicators catch explicit arithmetic errors without inventing omitted estimates', () => {
  const fixture = DELIVERY_FIXTURES.find(item => item.id === 'system-design-units')!
  assert.deepEqual(capacityEstimateIndicators(fixture, 'Use workers with per-tenant queues.'), [])
  const correct = capacityEstimateIndicators(fixture, '2,000 events/s is 172.8 million events/day, about 172.8 GB/day payload.')
  assert.equal(correct.length, 2)
  assert.ok(correct.every(check => check.withinOnePercent))
  const wrong = capacityEstimateIndicators(fixture, 'Scale: ~7.2 million events/day, ~7.2 GB/day payload.')
  assert.equal(wrong.length, 2)
  assert.ok(wrong.every(check => !check.withinOnePercent))
  assert.equal(capacityEstimateIndicators(fixture, '2 MB/s is 16 Mbps.')[0].withinOnePercent, true)
  assert.equal(capacityEstimateIndicators(fixture, '2 MB/s is about172 Mbps.')[0].withinOnePercent, false)
  const behavioral = DELIVERY_FIXTURES.find(item => item.id === 'behavioral-grounding')!
  assert.ok(reviewAnswerIndicators(behavioral, 'The rollout completed successfully with no negative impact.').forbiddenClaims.some(check => check.flagged))
  const weighted = DELIVERY_FIXTURES.find(item => item.id === 'weighted-correction')!
  const relaxation = reviewAnswerIndicators(weighted, 'Use 0-1 BFS with a deque. Update distances only when a shorter path is found.')
  assert.ok(relaxation.requiredFacts.every(fact => fact.observed))
})


test('context comparison allows only derived empty situation omission and preserves every raw field', () => {
  const baseline = loadBaselineCompiler()
  try {
    const empty = DELIVERY_FIXTURES.find(item => item.id === 'technical-correctness')!
    const compiled = baseline.compiler(empty.request)
    const omit = (original: typeof compiled) => {
      const changed = structuredClone(original)
      for (const message of changed.input) {
        if (!Array.isArray(message.content)) continue
        for (const item of message.content) if (item.type === 'input_text') {
          const data = JSON.parse(item.text)
          delete data.interviewSituation
          item.text = JSON.stringify(data)
        }
      }
      return changed
    }
    const omitted = omit(compiled)
    assert.deepEqual(compareContextPayloads(empty, compiled, omitted), { contextPayloadIdentical: false, contextPayloadEquivalent: true, allowedContextAdjustments: ['omitted_empty_interview_situation'] })
    const lostRequest = structuredClone(omitted)
    const last = lostRequest.input.at(-1)!.content
    assert.ok(Array.isArray(last))
    const data = JSON.parse(last[0].type === 'input_text' ? last[0].text : '{}')
    data.userRequest = 'changed question'
    if (last[0].type === 'input_text') last[0].text = JSON.stringify(data)
    assert.equal(compareContextPayloads(empty, compiled, lostRequest).contextPayloadEquivalent, false)
    const meaningful = DELIVERY_FIXTURES.find(item => item.id === 'focused-followup')!
    const meaningfulCompiled = baseline.compiler(meaningful.request)
    assert.equal(compareContextPayloads(meaningful, meaningfulCompiled, omit(meaningfulCompiled)).contextPayloadEquivalent, false)
    const corrupted = structuredClone(compiled)
    const content = corrupted.input.at(-1)!.content
    assert.ok(Array.isArray(content))
    if (content[0].type === 'input_text') {
      const source = JSON.parse(content[0].text)
      source.interviewSituation.interruptedDrafts = [{ answerId: 'meaningful-draft', excerpts: [{ text: 'tentative code' }] }]
      content[0].text = JSON.stringify(source)
    }
    assert.equal(compareContextPayloads(empty, corrupted, omit(corrupted)).contextPayloadEquivalent, false)
  } finally { baseline.cleanup() }
})


test('evaluation reasoning override is explicit, Luna-only and changes only the request effort', async () => {
  assert.equal(evaluationReasoningTransport('gpt-6-luna', undefined), undefined)
  assert.throws(() => evaluationReasoningTransport('gpt-4.1', 'low'), /requires/)
  assert.throws(() => evaluationReasoningTransport('gpt-6-luna', 'high'), /requires/)
  const original = { model: 'gpt-6-luna', instructions: 'Public fixture.', input: [], store: false, stream: true, reasoning: { effort: 'none' } }
  let observed: RequestInit | undefined
  const fetcher: typeof globalThis.fetch = async (_input, init) => { observed = init; return new Response('fixture') }
  const transport = evaluationReasoningTransport('gpt-6-luna', 'low', fetcher)!
  await transport.fetch!('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer synthetic-test-value' }, body: JSON.stringify(original) })
  assert.deepEqual(JSON.parse(String(observed!.body)), { ...original, reasoning: { effort: 'low' } })
  assert.deepEqual(observed!.headers, { Authorization: 'Bearer synthetic-test-value' })
  assert.equal(original.reasoning.effort, 'none')
  await assert.rejects(transport.fetch!('https://example.test/v1/responses', { body: JSON.stringify(original) }), /Unexpected/)
})

test('evaluation retains strict decoder failures but continues independent variants without retrying', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'faangin-eval-protocol-test-'))
  const reportPath = path.join(directory, 'report.json')
  const fixture = DELIVERY_FIXTURES.find(item => item.id === 'imperfect-transcript')!
  let calls = 0
  try {
    const result = await runLiveEvaluation({ baseline: compilePrompt, apiKey: 'synthetic-never-sent', model: 'gpt-6-luna', reportPath, fixtures: [fixture], fixtureSuite: 'test', generate: async (compiled, model, options) => {
      calls++
      if (calls === 1) {
        try { options.onDelta('REPLY\nThis prefix must never be shown.') } catch { throw Object.assign(new Error('Wrapped callback error'), { code: 'malformed_response' }) }
        throw new Error('The strict decoder unexpectedly accepted the bad header.')
      }
      const wire = framedAnswer(compiled, 'Keep the explicit no-retry policy.')
      options.onDelta(wire)
      return { text: wire, model, inputTokens: 2, outputTokens: 3 }
    } })
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(result.complete, true)
    assert.equal(calls, 2)
    assert.equal(report.trials.length, 2)
    assert.equal(report.automaticDispositionGate.baseline, false)
    assert.equal(report.automaticDispositionGate.current, true)
    assert.equal(report.trials[0].rawAnswer, 'REPLY\nThis prefix must never be shown.')
    assert.equal(report.trials[0].partialAnswer, '')
    assert.equal(report.trials[0].decoderFailure.code, 'invalid_interview_response')
    assert.deepEqual(report.trials[0].error, { code: 'invalid_interview_response', transportCode: 'malformed_response' })
    assert.equal(report.trials[1].answer, 'Keep the explicit no-retry policy.')
    assert.ok(!readFileSync(reportPath, 'utf8').includes('synthetic-never-sent'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('evaluation collects a current framing failure and later cases but still aborts access or transport failures', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'faangin-eval-continue-test-'))
  const reportPath = path.join(directory, 'report.json')
  const fixture = DELIVERY_FIXTURES.find(item => item.id === 'imperfect-transcript')!
  const next = { ...fixture, id: 'next-independent-question' }
  let calls = 0
  try {
    const result = await runLiveEvaluation({ baseline: compilePrompt, apiKey: 'synthetic-never-sent', model: 'gpt-6-luna', reportPath, fixtures: [fixture, next], generate: async (compiled, model, options) => {
      calls++
      const wire = framedAnswer(compiled, 'A useful answer.')
      options.onDelta(calls === 2 ? 'ASSIST Invalid separator' : wire)
      return { text: wire, model }
    } })
    assert.equal(calls, 4)
    assert.equal(result.complete, true)
    assert.equal(result.automaticDispositionGate.current, false)
    assert.equal(result.trials[1].error.code, 'invalid_interview_response')
    assert.equal(result.trials[3].id, next.id)
    let failedCalls = 0
    await assert.rejects(runLiveEvaluation({ baseline: compilePrompt, apiKey: 'synthetic-never-sent', model: 'gpt-6-luna', reportPath, fixtures: [fixture, next], generate: async () => { failedCalls++; throw Object.assign(new Error('Synthetic transport failure'), { code: 'quota_exhausted' }) } }), { code: 'quota_exhausted' })
    assert.equal(failedCalls, 1)
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).complete, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('evaluation records the same effective reasoning policy as production including explicit experiment precedence', () => {
  assert.equal(resolvedEvaluationReasoning('gpt-6-luna', { reasoningEffort: 'low' }), 'low')
  assert.equal(resolvedEvaluationReasoning('gpt-6-luna', {}), 'none')
  assert.equal(resolvedEvaluationReasoning('gpt-6-luna', { reasoningEffort: 'low' }, 'none'), 'none')
  assert.equal(resolvedEvaluationReasoning('gpt-6-sol', { reasoningEffort: 'low' }), 'none')
  assert.equal(resolvedEvaluationReasoning('gpt-4.1', { reasoningEffort: 'low' }), 'provider_default')
})


test('current structured protocol changes instructions and decoder without changing any source payload or frozen fixture', () => {
  const fixture = DELIVERY_FIXTURES.find(item => item.id === 'imperfect-transcript')!
  const frozenRequest = JSON.stringify(fixture.request)
  const line = compilePrompt(fixture.request)
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    const selected = evaluationCurrentRequest(fixture.request, model)
    assert.equal(selected.responseProtocol, 'json')
    const current = compilePrompt(selected)
    assert.equal(current.responseProtocol, 'json')
    assert.deepEqual(current.input, line.input)
    assert.deepEqual(current.sources, line.sources)
    assert.equal(current.maxOutputTokens, line.maxOutputTokens)
    const decoder = createInterviewResponseDecoder(current.responseProtocol)
    const wire = JSON.stringify({ disposition: 'assist', answer: 'Use request_id.\n```python\nmaxRetries = 50\n```' })
    let visible = ''
    for (const character of wire) visible += decoder.push(character)
    assert.equal(decoder.finish(), 'assist')
    assert.equal(visible, 'Use request_id.\n```python\nmaxRetries = 50\n```')
  }
  assert.equal(evaluationCurrentRequest(fixture.request, 'gpt-4.1'), fixture.request)
  const meeting = { ...fixture.request, session: { ...fixture.request.session, mode: 'meeting' as const } }
  assert.equal(evaluationCurrentRequest(meeting, 'gpt-6.1-sol'), meeting)
  assert.equal(JSON.stringify(fixture.request), frozenRequest)
  const plain = DELIVERY_FIXTURES.find(item => item.id === 'already-strong')!
  assert.equal(evaluationCurrentRequest(plain.request, 'gpt-6.1-sol'), plain.request)
  const baseline = loadBaselineCompiler()
  try { assert.equal(baseline.compiler(fixture.request).responseProtocol, undefined) } finally { baseline.cleanup() }
})
