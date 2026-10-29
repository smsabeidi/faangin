import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt } from '../src/main/prompts'
import { DELIVERY_FIXTURES } from '../scripts/response-delivery-fixtures'
import { HOLDOUT_FIXTURES } from '../scripts/response-delivery-holdout'
import { auditCompiledFixture, loadBaselineCompiler, reviewAnswerIndicators, runOfflineEvaluation } from '../scripts/response-delivery-eval'

test('holdout catalog is disjoint from development and freezes model configuration without changing action budgets', () => {
  assert.equal(HOLDOUT_FIXTURES.length, 12)
  assert.equal(new Set(HOLDOUT_FIXTURES.map(fixture => fixture.id)).size, 12)
  for (const fixture of HOLDOUT_FIXTURES) {
    assert.ok(!DELIVERY_FIXTURES.some(development => development.id === fixture.id || development.request.prompt && development.request.prompt === fixture.request.prompt), fixture.id)
    assert.equal(fixture.request.settings.fastModel, 'gpt-4.1-mini')
    assert.equal(fixture.request.settings.smartModel, 'gpt-4.1')
    const compiled = compilePrompt(fixture.request)
    assert.equal(compiled.maxOutputTokens, ['solve', 'design'].includes(fixture.request.action) ? 4_096 : 2_048, fixture.id)
    assert.equal(auditCompiledFixture(fixture, compiled).passed, true, fixture.id)
    assert.doesNotThrow(() => reviewAnswerIndicators(fixture, ''))
  }
})

test('holdout source audit detects changed correction, negation and identifier while excluding provisional completion', () => {
  const corrected = HOLDOUT_FIXTURES.find(fixture => fixture.id === 'holdout-corrected-payment-transcript')!
  const compiled = compilePrompt(corrected.request)
  const changed = structuredClone(compiled)
  changed.input = JSON.parse(JSON.stringify(changed.input).replaceAll('eighteen—no, eighty milliseconds', 'eighteen milliseconds').replaceAll('retry_after_ms', 'retryAfterMs').replaceAll('must not retry a failed payment', 'must retry a failed payment'))
  assert.equal(auditCompiledFixture(corrected, changed).passed, false)
  assert.equal(auditCompiledFixture(corrected, changed).missingSourceText.length, 3)
  const incomplete = HOLDOUT_FIXTURES.find(fixture => fixture.id === 'holdout-unfinished-rate-limit')!
  const incompletePrompt = compilePrompt(incomplete.request)
  assert.ok(!JSON.stringify(incompletePrompt.input).includes('503s should we'))
  assert.deepEqual(incompletePrompt.sources.transcriptIds, ['h1'])
  assert.equal(reviewAnswerIndicators(incomplete, '', 'wait').dispositionMatches, true)
})

test('holdout indicators recognize new technical substance and flag unsupported outcome or payment changes', () => {
  const code = HOLDOUT_FIXTURES.find(fixture => fixture.id === 'holdout-inplace-deduplication')!
  const codeReview = reviewAnswerIndicators(code, 'def dedupe_sorted(nums):\n    if not nums: return 0\n# empty input []; O(n) time, O(1) auxiliary space')
  assert.ok(codeReview.requiredFacts.every(fact => fact.observed))
  const incident = HOLDOUT_FIXTURES.find(fixture => fixture.id === 'holdout-grounded-incident')!
  assert.equal(reviewAnswerIndicators(incident, 'The queue caught up in 13 minutes.').forbiddenClaims[0].flagged, true)
  const correction = HOLDOUT_FIXTURES.find(fixture => fixture.id === 'holdout-corrected-payment-transcript')!
  assert.ok(reviewAnswerIndicators(correction, 'Use retry_after_ms = 80; do not retry a failed payment.').requiredFacts.every(fact => fact.observed))
  assert.equal(reviewAnswerIndicators(correction, 'Use 18 milliseconds.').forbiddenClaims[0].flagged, true)
  assert.ok(Object.values(codeReview.humanReview).every(value => value === null))
})

test('injected holdout compiler evaluation preserves strict source-equivalence checks and suite identity', () => {
  const baseline = loadBaselineCompiler()
  try {
    const report = runOfflineEvaluation(baseline.compiler, { fixtures: HOLDOUT_FIXTURES, fixtureSuite: 'holdout', revision: baseline.revision, iterations: 2 })
    assert.equal(report.fixtureSuite, 'holdout')
    assert.equal(report.caseCount, 12)
    assert.equal(report.passed, true)
    assert.ok(report.cases.every(item => item.contextPayloadEquivalent && item.outputBudgetUnchanged))
    assert.ok(report.cases.filter(item => item.id.includes('followup') || item.id.includes('transcript') || item.id.includes('unfinished')).every(item => item.contextPayloadIdentical))
    assert.throws(() => runOfflineEvaluation(baseline.compiler, { fixtures: [], iterations: 1 }), /nonempty/)
    assert.throws(() => runOfflineEvaluation(baseline.compiler, { fixtures: [HOLDOUT_FIXTURES[0], HOLDOUT_FIXTURES[0]], iterations: 1 }), /unique/)
  } finally { baseline.cleanup() }
})
