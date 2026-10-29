/** Synthetic-only paired evaluation. Offline mode never opens credentials or a network connection. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { compilePrompt, type AnswerInput, type CompiledPrompt } from '../src/main/prompts'
import { generateCompiledAnswer, type InferenceTransport } from '../src/main/inference'
import { InterviewResponseProtocolError } from '../src/main/interview-response'
import { answerReasoning } from '../src/main/model-capabilities'
import { createInterviewResponseDecoder, supportsStructuredInterviewReply } from '../src/main/structured-interview-response'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { DELIVERY_FIXTURES, type DeliveryFixture } from './response-delivery-fixtures'
import { HOLDOUT_FIXTURES } from './response-delivery-holdout'

export const DELIVERY_BASELINE = '6fd27174f03690b6c24d73b2db5da5d8ab3738e9'
type Compiler = (request: AnswerInput) => CompiledPrompt
export const HUMAN_REVIEW_DIMENSIONS = ['factualAccuracy', 'technicalCompleteness', 'conversationalNaturalness', 'contextualFit', 'consistency'] as const
function percentile(values: number[], fraction: number) { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] }
const round = (value: number) => Math.round(value * 1_000) / 1_000
export function promptFootprint(compiled: CompiledPrompt) {
  const wire = JSON.stringify({ instructions: compiled.instructions, input: compiled.input })
  return { instructionsCharacters: compiled.instructions.length, inputCharacters: JSON.stringify(compiled.input).length, serializedUtf8Bytes: Buffer.byteLength(wire), serializedScope: 'instructions and input only; excludes response format and transport metadata', maxOutputTokens: compiled.maxOutputTokens, tokenUsage: { measured: false, reason: 'Token counts require provider usage; character and byte counts are not token estimates.' } }
}
export function auditCompiledFixture(fixture: DeliveryFixture, compiled: CompiledPrompt) {
  const admitted = JSON.stringify(compiled.input)
  // JSON encoding escapes quotes/newlines, so search serialized literal contents.
  const missingSourceText = fixture.preserve.filter(text => !admitted.includes(JSON.stringify(text).slice(1, -1)))
  const automaticPartialLeak = !!fixture.request.automatic && fixture.request.session.transcript.some(turn => turn.provisional && admitted.includes(JSON.stringify(turn.text).slice(1, -1)))
  const expectedSourceIds = fixture.request.automatic ? fixture.request.session.transcript.filter(turn => !turn.provisional).map(turn => turn.id) : []
  const missingTranscriptIds = expectedSourceIds.filter(id => !compiled.sources.transcriptIds.includes(id))
  return { passed: !missingSourceText.length && !automaticPartialLeak && !missingTranscriptIds.length && compiled.sources.attachmentIds.length === 0, missingSourceText, automaticPartialLeak, missingTranscriptIds, attachmentCount: compiled.sources.attachmentIds.length, retainedPriorAnswerIds: compiled.sources.priorAnswerIds }
}
/** Allow only removal of derived empty situation metadata; raw source JSON stays exact. */
export function compareContextPayloads(fixture: DeliveryFixture, baseline: CompiledPrompt, current: CompiledPrompt) {
  const contextPayloadIdentical = JSON.stringify(baseline.input) === JSON.stringify(current.input)
  if (contextPayloadIdentical) return { contextPayloadIdentical: true, contextPayloadEquivalent: true, allowedContextAdjustments: [] as string[] }
  const session = fixture.request.session
  const noFinalizedSpeech = !session.transcript.some(turn => turn.sessionId === session.id && !turn.provisional && turn.text.trim())
  const noSavedProblem = ![session.interview?.problem, session.interview?.constraints, session.interview?.candidateAttempt].some(value => value?.trim())
  const noIncludedAnswers = baseline.sources.priorAnswerIds.length === 0 && current.sources.priorAnswerIds.length === 0
  if (!noFinalizedSpeech || !noSavedProblem || !noIncludedAnswers) return { contextPayloadIdentical: false, contextPayloadEquivalent: false, allowedContextAdjustments: [] as string[] }
  const adjusted = structuredClone(baseline.input)
  let omitted = 0
  for (const message of adjusted) {
    if (!Array.isArray(message.content)) continue
    for (const content of message.content) {
      if (content.type !== 'input_text') continue
      let data
      try { data = JSON.parse(content.text) } catch { continue }
      const situation = data?.interviewSituation
      if (!situation || typeof situation !== 'object' || situation.source !== 'bounded_current_interview_context') continue
      const focus = situation.questionFocus, artifacts = situation.workingArtifacts
      const knownFieldsOnly = Object.keys(situation).every(key => ['source', 'trust', 'questionFocus', 'evidenceSinceBaseline', 'omittedEvidenceTurns', 'evidencePolicy', 'workingArtifacts', 'exchanges', 'interruptedDrafts', 'truncated'].includes(key)) &&
        focus && Object.keys(focus).every(key => ['explicitRequest', 'precedingSegments', 'interpretation'].includes(key)) && artifacts && Object.keys(artifacts).every(key => ['candidateAttemptSource', 'status'].includes(key))
      const isEmpty = knownFieldsOnly && Array.isArray(situation.evidenceSinceBaseline) && situation.evidenceSinceBaseline.length === 0 &&
        Array.isArray(situation.exchanges) && situation.exchanges.length === 0 && Array.isArray(situation.interruptedDrafts) && situation.interruptedDrafts.length === 0 &&
        situation.omittedEvidenceTurns === 0 && !situation.briefRevision && focus && !focus.latestFinalizedUtterance && Array.isArray(focus.precedingSegments) && focus.precedingSegments.length === 0 &&
        artifacts && !artifacts.baselineAnswerId && !artifacts.latestCompleteAnswerId
      if (!isEmpty) continue
      delete data.interviewSituation
      content.text = JSON.stringify(data)
      omitted++
    }
  }
  const contextPayloadEquivalent = omitted === 1 && JSON.stringify(adjusted) === JSON.stringify(current.input)
  return { contextPayloadIdentical: false, contextPayloadEquivalent, allowedContextAdjustments: contextPayloadEquivalent ? ['omitted_empty_interview_situation'] : [] }
}
/** Check explicit raw-payload daily estimates and bit-rate conversions; omissions remain a completeness review. */
export function capacityEstimateIndicators(fixture: DeliveryFixture, text: string) {
  if (fixture.id !== 'system-design-units') return []
  const checks: Array<{ observed: string; expected: number; actual: number; withinOnePercent: boolean; units: string }> = []
  const number = '([0-9]+(?:[,.][0-9]+)*)'
  const multiplier: Record<string, number> = { '': 1, k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }
  const events = new RegExp(number + '\\s*(billion|million|thousand|[kmb])?\\s*events?\\s*(?:/\\s*day|per day|a day)', 'gi')
  for (const match of text.matchAll(events)) {
    const actual = Number(match[1].replaceAll(',', '')) * multiplier[(match[2] ?? '').toLowerCase()]
    const expected = 2_000 * 86_400
    checks.push({ observed: match[0], expected, actual, withinOnePercent: Math.abs(actual - expected) / expected <= .01, units: 'events/day' })
  }
  const payload = new RegExp(number + '\\s*(TB|GB|MB|TiB|GiB|MiB)\\s*(?:/\\s*day|per day|a day)', 'gi')
  const bytes: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, tib: 1024 ** 4, gib: 1024 ** 3, mib: 1024 ** 2 }
  for (const match of text.matchAll(payload)) {
    const actual = Number(match[1].replaceAll(',', '')) * bytes[match[2].toLowerCase()]
    const expected = 2_000 * 1_000 * 86_400
    checks.push({ observed: match[0], expected, actual, withinOnePercent: Math.abs(actual - expected) / expected <= .01, units: 'payload bytes/day, decimal input KB, excludes overhead/replicas/retries' })
  }
  const bits = new RegExp(number + '\\s*(Gbps|Mbps|[kK]bps|Gb/s|Mb/s|[kK]b/s)', 'g')
  for (const match of text.matchAll(bits)) {
    const factor = match[2][0].toLowerCase() === 'g' ? 1e9 : match[2][0].toLowerCase() === 'm' ? 1e6 : 1e3
    const actual = Number(match[1].replaceAll(',', '')) * factor
    const expected = 2_000 * 1_000 * 8
    checks.push({ observed: match[0], expected, actual, withinOnePercent: Math.abs(actual - expected) / expected <= .01, units: 'raw payload bits/second; excludes overhead/replicas/retries' })
  }
  return checks
}
export function reviewAnswerIndicators(fixture: DeliveryFixture, text: string, disposition?: string) {
  const requiredFacts = fixture.requiredFacts.map(fact => ({ label: fact.label, observed: new RegExp(fact.pattern, 'i').test(text) }))
  const forbiddenClaims = (fixture.forbiddenClaims ?? []).map(fact => ({ label: fact.label, flagged: new RegExp(fact.pattern, 'i').test(text) }))
  const stockPhrases = text.match(/\b(?:great question|excellent question|let['’]s (?:dive|delve)|in conclusion|to summarize|it['’]s worth noting|first and foremost)\b/gi) ?? []
  const headings = text.match(/^#{1,6}\s+.+$/gm) ?? []
  return { supportingEvidenceOnly: true, requiredFacts, forbiddenClaims, capacityEstimateChecks: capacityEstimateIndicators(fixture, text), dispositionMatches: fixture.expectedDisposition ? disposition === fixture.expectedDisposition : null, wordCount: text.trim() ? text.trim().split(/\s+/).length : 0, stockPhrases, headingCount: headings.length, humanReview: Object.fromEntries(HUMAN_REVIEW_DIMENSIONS.map(dimension => [dimension, null])), reviewFocus: fixture.reviewFocus, limitation: 'Phrase matching can miss correct paraphrases and accept incorrect uses; it cannot establish factual accuracy, completeness or naturalness. Human review remains required.' }
}
export function loadBaselineCompiler(root = process.cwd(), revision = DELIVERY_BASELINE): { compiler: Compiler; revision: string; cleanup: () => void } {
  const resolved = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  const directory = mkdtempSync(path.join(tmpdir(), 'faangin-delivery-baseline-'))
  try {
    const archive = execFileSync('git', ['archive', resolved, 'src/main', 'src/shared'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
    const compiler = createRequire(path.join(root, 'package.json'))(path.join(directory, 'src/main/prompts.ts')).compilePrompt as Compiler
    return { compiler, revision: resolved, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
export function evaluationCurrentRequest(request: AnswerInput, model: string): AnswerInput {
  return request.automatic && request.session.mode === 'interview' && supportsStructuredInterviewReply(model) ? { ...request, responseProtocol: 'json' } : request
}
export function runOfflineEvaluation(baseline: Compiler, options: { iterations?: number; revision?: string; fixtures?: readonly DeliveryFixture[]; fixtureSuite?: string; model?: string } = {}) {
  const iterations = options.iterations ?? 120
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10_000) throw new Error('Evaluation iterations must be an integer from 1 to 10000.')
  const fixtures = options.fixtures ?? DELIVERY_FIXTURES
  const model = options.model ?? DEFAULT_SETTINGS.fastModel
  if (!fixtures.length || new Set(fixtures.map(fixture => fixture.id)).size !== fixtures.length) throw new Error('Evaluation fixtures must be nonempty and have unique IDs.')
  const cases = fixtures.map((fixture, index) => {
    const currentRequest = evaluationCurrentRequest(fixture.request, model)
    const compiled = { baseline: baseline(fixture.request), current: compilePrompt(currentRequest) }
    const measurements = { baseline: [] as number[], current: [] as number[] }
    for (let warmup = 0; warmup < 20; warmup++) { baseline(fixture.request); compilePrompt(currentRequest) }
    for (let iteration = 0; iteration < iterations; iteration++) {
      // Alternate measurement order to reduce systematic warm-cache/order bias.
      const variants = (index + iteration) % 2 ? ['current', 'baseline'] as const : ['baseline', 'current'] as const
      for (const variant of variants) { const started = performance.now(); (variant === 'baseline' ? baseline(fixture.request) : compilePrompt(currentRequest)); measurements[variant].push(performance.now() - started) }
    }
    const variants = Object.fromEntries((['baseline', 'current'] as const).map(variant => [variant, { responseProtocol: fixture.request.automatic ? compiled[variant].responseProtocol ?? 'line' : 'plain', footprint: promptFootprint(compiled[variant]), sourceAudit: auditCompiledFixture(fixture, compiled[variant]), localCompileMs: { samples: iterations, median: round(percentile(measurements[variant], .5)), p95: round(percentile(measurements[variant], .95)) } }]))
    return { id: fixture.id, category: fixture.category, expectedDisposition: fixture.expectedDisposition ?? null, reviewFocus: fixture.reviewFocus, ...(fixture.illustration ? { illustration: fixture.illustration } : {}), variants, ...compareContextPayloads(fixture, compiled.baseline, compiled.current), outputBudgetUnchanged: compiled.baseline.maxOutputTokens === compiled.current.maxOutputTokens }
  })
  return { kind: 'offline_compiler_evaluation', model, syntheticOnly: true, generatedAnswers: false, fixtureSuite: options.fixtureSuite ?? (options.fixtures ? 'custom' : 'development'), fixtureCatalogSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), baselineRevision: options.revision ?? DELIVERY_BASELINE, currentPromptSha256: createHash('sha256').update(fixtures.map(fixture => compilePrompt(evaluationCurrentRequest(fixture.request, model)).instructions).join('\n')).digest('hex'), measuredAt: new Date().toISOString(), caseCount: cases.length, passed: cases.every(item => item.contextPayloadEquivalent && item.outputBudgetUnchanged && Object.values(item.variants).every((value: any) => value.sourceAudit.passed)), cases, limitations: ['Local compile timings exclude provider latency, transcription, IPC, rendering and physical paint.', 'No model outputs or token usage are measured in offline mode.', 'Source-preservation checks establish prompt integrity, not model compliance or response quality.'] }
}
export function resolvedEvaluationReasoning(model: string, compiled: Pick<CompiledPrompt, 'reasoningEffort'>, override?: string): string {
  return override ?? answerReasoning(model, compiled.reasoningEffort).reasoning?.effort ?? 'provider_default'
}
/** Explicit evaluation experiment only; never changes the production reasoning policy. */
export function evaluationReasoningTransport(model: string, effort: string | undefined, fetcher: typeof globalThis.fetch = globalThis.fetch): InferenceTransport | undefined {
  if (effort === undefined) return undefined
  if (model !== 'gpt-6-luna' || !['none', 'low'].includes(effort)) throw new Error('Evaluation reasoning override requires gpt-6-luna and none or low.')
  return { fetch: async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://api.openai.com/v1/responses' || typeof init?.body !== 'string') throw new Error('Unexpected evaluation reasoning transport request.')
    const body = JSON.parse(init.body)
    if (body.model !== model) throw new Error('Evaluation reasoning model changed unexpectedly.')
    return fetcher(input, { ...init, body: JSON.stringify({ ...body, reasoning: { ...body.reasoning, effort } }) })
  } }
}
export async function runLiveEvaluation(options: { baseline: Compiler; apiKey: string; model: string; revision?: string; reportPath: string; onProgress?: (progress: Record<string, unknown>) => void; selectedCaseIds?: string[]; fixtures?: readonly DeliveryFixture[]; fixtureSuite?: string; reasoningOverride?: string; generate?: typeof generateCompiledAnswer }) {
  const transport = evaluationReasoningTransport(options.model, options.reasoningOverride)
  const generate = options.generate ?? generateCompiledAnswer
  const catalog = options.fixtures ?? DELIVERY_FIXTURES
  if (new Set(catalog.map(fixture => fixture.id)).size !== catalog.length) throw new Error('Evaluation fixture IDs must be unique.')
  const fixtures = options.selectedCaseIds ? catalog.filter(fixture => options.selectedCaseIds!.includes(fixture.id)) : catalog
  if (!fixtures.length) throw new Error('No evaluation fixtures selected.')
  if (options.selectedCaseIds?.some(id => !fixtures.some(fixture => fixture.id === id))) throw new Error('Unknown evaluation fixture selected.')
  const report = { kind: 'paired_synthetic_provider_evaluation', complete: false, syntheticOnly: true, primaryWorkspaceModified: false, fixtureSuite: options.fixtureSuite ?? (options.fixtures ? 'custom' : 'development'), fixtureCatalogSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), baselineRevision: options.revision ?? DELIVERY_BASELINE, model: options.model, reasoningOverride: options.reasoningOverride ?? null, measuredAt: new Date().toISOString(), trialsPerCasePerVariant: 1, automaticDispositionGate: { baseline: true, current: true }, trials: [] as Array<Record<string, any>>, limitations: ['One trial per variant is exploratory; it cannot establish a latency distribution or universal quality improvement.', 'First visible text is the generation callback after protocol stripping; it excludes rendering and physical paint.', 'Only public synthetic text is sent. No microphone, system audio, screenshots, saved profile or private session is loaded.', 'Automatic phrase indicators support review and cannot replace human judgments. Human rubric fields remain unscored.'] }
  const persist = () => writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const overall = AbortSignal.timeout(20 * 60_000)
  for (const [index, fixture] of fixtures.entries()) {
    for (const variant of index % 2 ? ['current', 'baseline'] as const : ['baseline', 'current'] as const) {
      if (overall.aborted) throw new Error('Synthetic evaluation exceeded its overall time budget.')
      const compiled = variant === 'baseline' ? options.baseline(fixture.request) : compilePrompt(evaluationCurrentRequest(fixture.request, options.model))
      const responseProtocol = fixture.request.automatic ? compiled.responseProtocol ?? 'line' : 'plain'
      const resolvedReasoning = resolvedEvaluationReasoning(options.model, compiled, options.reasoningOverride)
      const decoder = fixture.request.automatic ? createInterviewResponseDecoder(compiled.responseProtocol) : undefined
      const started = performance.now(); let answer = '', rawAnswer = '', firstTextMs: number | undefined
      let decoderFailure: { code: string; message: string } | null = null
      const rememberDecoderFailure = (error: unknown) => { if (error instanceof InterviewResponseProtocolError) decoderFailure = { code: error.code, message: error.message } }
      options.onProgress?.({ id: fixture.id, variant, resolvedReasoning, responseProtocol, phase: 'started' })
      try {
        const result = await generate(compiled, options.model, { apiKey: options.apiKey, ...(transport ? { transport } : {}), signal: AbortSignal.any([overall, AbortSignal.timeout(60_000)]), onDelta(delta) { rawAnswer += delta; let visible: string; try { visible = decoder ? decoder.push(delta) : delta } catch (error) { rememberDecoderFailure(error); throw error } if (visible.trim()) firstTextMs ??= round(performance.now() - started); answer += visible } })
        let disposition
        try { disposition = decoder?.finish() } catch (error) { rememberDecoderFailure(error); throw error }
        const trial = { id: fixture.id, category: fixture.category, variant, resolvedReasoning, responseProtocol, disposition: disposition ?? null, answer, rawAnswer, decoderFailure, firstTextMs: firstTextMs ?? null, totalMs: round(performance.now() - started), model: result.model, inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null, footprint: promptFootprint(compiled), compiledPromptSha256: createHash('sha256').update(JSON.stringify(compiled)).digest('hex'), review: reviewAnswerIndicators(fixture, answer, disposition) }
        if (fixture.expectedDisposition && disposition !== fixture.expectedDisposition) report.automaticDispositionGate[variant] = false
        report.trials.push(trial); persist()
        options.onProgress?.({ id: fixture.id, variant, phase: 'completed', firstTextMs: trial.firstTextMs, totalMs: trial.totalMs, inputTokens: trial.inputTokens, outputTokens: trial.outputTokens, disposition: trial.disposition })
      } catch (error) {
        const transportCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'evaluation_error'
        const failure = decoderFailure as { code: string; message: string } | null
        const code = failure?.code ?? transportCode
        if (failure) report.automaticDispositionGate[variant] = false
        report.trials.push({ id: fixture.id, variant, resolvedReasoning, responseProtocol, rawAnswer, decoderFailure: failure, error: { code, transportCode }, firstTextMs: firstTextMs ?? null, totalMs: round(performance.now() - started), partialAnswer: answer }); persist()
        options.onProgress?.({ id: fixture.id, variant, phase: 'failed', code })
        // A strict framing failure belongs to this independent sample: retain it and
        // continue without retrying, so a failed baseline cannot hide current coverage.
        if (failure) continue
        // Access/quota/transport errors abort the bounded run; never retry or change models silently.
        throw Object.assign(new Error('Synthetic provider evaluation failed; the safe report contains its error code.'), { code })
      }
    }
  }
  report.complete = true
  persist()
  return report
}

async function main() {
  const fixtureSuite = process.env.FAANGIN_DELIVERY_SUITE ?? 'development'
  if (!['development', 'holdout'].includes(fixtureSuite)) throw new Error('Unknown evaluation suite.')
  const fixtures = fixtureSuite === 'holdout' ? HOLDOUT_FIXTURES : DELIVERY_FIXTURES
  const reportPath = process.argv[2] ?? `/private/tmp/faangin-response-delivery-${fixtureSuite === 'holdout' ? 'holdout-' : ''}offline.json`
  const baseline = loadBaselineCompiler()
  try {
    const report = runOfflineEvaluation(baseline.compiler, { revision: baseline.revision, fixtures, fixtureSuite, model: process.env.FAANGIN_DELIVERY_MODEL })
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ passed: report.passed, fixtureSuite: report.fixtureSuite, caseCount: report.caseCount, baselineRevision: report.baselineRevision, reportPath, cases: report.cases.map(item => ({ id: item.id, instructionDeltaCharacters: item.variants.current.footprint.instructionsCharacters - item.variants.baseline.footprint.instructionsCharacters, localCompileMs: { baseline: item.variants.baseline.localCompileMs, current: item.variants.current.localCompileMs }, contextPayloadIdentical: item.contextPayloadIdentical, contextPayloadEquivalent: item.contextPayloadEquivalent, allowedContextAdjustments: item.allowedContextAdjustments, outputBudgetUnchanged: item.outputBudgetUnchanged })) }, null, 2))
    if (!report.passed) process.exitCode = 1
  } finally { baseline.cleanup() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main().catch(() => { console.error('Offline evaluation failed. Check fixture integrity and the baseline revision.'); process.exitCode = 1 })
