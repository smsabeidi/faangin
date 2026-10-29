/* Explicit synthetic speech acceptance: file output only; no microphone, loopback, or playback. */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
require('tsx/cjs')
const { VoiceActivity, SOURCE_VAD_OPTIONS } = require('../src/capture/vad.ts')
const { createLiveTranscriber, generateCompiledAnswer } = require('../src/main/inference.ts')
const { LiveReplyCoordinator } = require('../src/main/live-replies.ts')
const { liveReplyTranscript } = require('../src/main/live-reply-context.ts')
const { compilePrompt } = require('../src/main/prompts.ts')
const { transcriptionContext } = require('../src/main/transcription-context.ts')
const { createInterviewResponseDecoder, supportsStructuredInterviewReply } = require('../src/main/structured-interview-response.ts')
const { DEFAULT_SETTINGS, DEFAULT_INTERVIEW_CONTEXT } = require('../src/shared/types.ts')
const { pcmWave, frameRms: level, compressQuietGaps } = require('./conversation-audio-fixture.ts')

const QUESTION = 'For the same shortest path solution actually do not assume unit weights anymore because every edge has weight zero or one rather than arbitrary positive weights in a graph with ten thousand vertices and fifteen thousand sorry fifty thousand edges so what changes about the queue the distance updates and the time complexity?'
const MODEL = process.env.FAANGIN_AUDIO_EVAL_MODEL || 'gpt-6-luna'
const FRAME_BYTES = 960, FRAME_MS = 20
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'faangin-conversation-audio-'))
app.setName('Faangin')
app.setPath('userData', path.join(runtime, 'profile'))

const errorCode = error => typeof error?.code === 'string' && /^[a-z_]{1,60}$/i.test(error.code) ? error.code : 'evaluation_error'

async function run() {
  if (process.env.FAANGIN_AUDIO_EVAL !== '1') throw new Error('Explicit FAANGIN_AUDIO_EVAL=1 opt-in is required.')
  if (!supportsStructuredInterviewReply(MODEL)) throw new Error('Synthetic audio evaluation model must support structured interview replies.')
  if (process.platform !== 'darwin') throw new Error('This synthetic speech harness requires macOS say and afconvert.')
  const mode = process.env.FAANGIN_AUDIO_EVAL_MODE || 'natural'
  if (!['natural', 'continuous-transport'].includes(mode)) throw new Error('Synthetic speech mode must be natural or continuous-transport.')
  const maxProviderCalls = mode === 'natural' ? 6 : 2
  const reportPath = process.env.FAANGIN_AUDIO_EVAL_REPORT || '/private/tmp/faangin-conversation-audio.json'
  const report = { kind: 'synthetic_speech_pipeline_acceptance', mode, syntheticOnly: true, physicalAudioCapture: false, audioPlayed: false, privateSessionLoaded: false, savedSettingsModified: false, model: MODEL, responseProtocol: 'json', measuredAt: new Date().toISOString(), question: QUESTION, source: 'system', frameMs: FRAME_MS, vad: SOURCE_VAD_OPTIONS.system, maxProviderCalls, providerCallCount: 0, transcript: [], commits: [], finals: [], partials: [], coordinator: [], generations: [], guards: {}, limitations: ['A single system-generated voice is not evidence for accents, noise, overlapping people, microphone or conferencing capture.', 'Input is public synthesized speech replayed as PCM; timings exclude hardware capture, IPC and physical paint.', 'Observed silence endpoints are reported individually and are not assumed to establish semantic completion.', 'Continuous-transport mode deliberately shortens synthetic frames below the VAD release threshold, potentially including low-level speech; it is not natural human pacing.', 'Phrase indicators support engineering review; they do not establish semantic accuracy or naturalness.'] }
  const persist = () => { report.dispatchAttemptCount = report.generations.length; fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
  const cancellation = new AbortController(), deadline = setTimeout(() => cancellation.abort(), 90_000)
  let transcriber, coordinator, phase = 'synthetic_audio', started = 0, finalIndex = 0, writes = 0, lastWritten = -1, providerContinuationUnsettled = false, vadUtteranceOpen = false, activeGeneration = false
  let firstPartialMs, firstFinalMs, inputEndedMs, replayStartMs, bufferedPcmBytes = 0, bufferedAudibleSamples = 0, utteranceAdmittedFrames = 0
  const jobs = [], providerCommitOrder = [], turnMetadata = new Map(), frameOrder = new WeakMap(), admittedHash = createHash('sha256')
  const at = () => Math.round((performance.now() - started) * 1000) / 1000
  const sourceId = itemId => `synthetic-speech:1:system:${itemId}`
  const candidate = turn => ({ turn, generation: 1, epoch: 0 })
  const session = { id: 'synthetic-speech', title: 'Public synthetic graph question', mode: 'interview', status: 'recording', createdAt: 0, updatedAt: 0, notes: '', contextEpoch: 0, transcript: [], attachments: [], selectedAttachmentIds: [], answers: [], interview: { ...DEFAULT_INTERVIEW_CONTEXT, role: 'Senior software engineer', problem: 'Find a shortest path in an unweighted graph.', constraints: 'The current proposed solution assumes every edge has unit weight and uses an adjacency list.' } }
  session.answers.push({ id: 'synthetic-bfs-baseline', requestId: 'synthetic-bfs-request', sessionId: session.id, action: 'solve', prompt: session.interview.problem, text: 'Use BFS with a FIFO queue. Mark a vertex visited when enqueuing and store parent pointers. BFS visits vertices in distance order. Time is O(V + E), auxiliary space is O(V).', model: 'synthetic-reference-not-spoken-evidence', status: 'complete', createdAt: 0, context: { transcriptIds: [], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, interviewSnapshot: { round: session.interview.round, problem: session.interview.problem, constraints: session.interview.constraints } } })
  const settings = { ...DEFAULT_SETTINGS, fastModel: MODEL, profile: '', jobDescription: '', instructions: '', liveSuggestions: true }
  try {
    const aiffPath = path.join(runtime, 'question.aiff'), wavePath = path.join(runtime, 'question.wav')
    execFileSync('/usr/bin/say', ['-r', '165', '-o', aiffPath, QUESTION], { stdio: 'ignore', timeout: 20_000 })
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiffPath, wavePath], { stdio: 'ignore', timeout: 20_000 })
    const wav = fs.readFileSync(wavePath), { format, pcm: originalPcm } = pcmWave(wav), originalDurationMs = originalPcm.length / 48
    if (originalDurationMs < 8_000 || originalDurationMs > 35_000) throw new Error('Synthetic question must last 8 to 35 seconds.')
    const derived = mode === 'continuous-transport' ? compressQuietGaps(originalPcm) : null
    const pcm = derived?.pcm ?? originalPcm
    report.audio = { ...format, pcmBytes: pcm.length, durationMs: pcm.length / 48, originalDurationMs, wavSha256: createHash('sha256').update(wav).digest('hex'), voice: 'macOS configured default voice; no playback', wordsPerMinute: 165, transformation: derived?.metadata ?? { kind: 'none', originalPcmBytes: originalPcm.length, transformedPcmBytes: originalPcm.length } }
    const keyPath = path.join(os.homedir(), 'Library/Application Support/Faangin/openai.key.enc')
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(keyPath)) throw new Error('The saved encrypted OpenAI connection is unavailable.')
    const apiKey = safeStorage.decryptString(fs.readFileSync(keyPath))
    phase = 'transcription_connection'
    coordinator = new LiveReplyCoordinator({ hooks: {
      allowed: current => !cancellation.signal.aborted && current.generation === 1 && current.epoch === 0 && current.turn.sessionId === session.id && current.turn.channel === 'system' && !current.turn.provisional,
      busy: () => activeGeneration,
      onState: state => { if (started) report.coordinator.push({ atMs: at(), ...state }) },
      run: (target, signal) => {
        const targetUtterance = turnMetadata.get(target.turn.id)?.utterance
        const candidateEndpointObserved = targetUtterance !== undefined && report.commits.some(commit => commit.utterance === targetUtterance && commit.utteranceComplete)
        const trial = { number: report.generations.length + 1, targetId: target.turn.id, targetUtterance: targetUtterance ?? null, dispatchMs: at(), candidateEndpointObserved, utteranceStillOpen: !candidateEndpointObserved, vadSpeechInProgress: vadUtteranceOpen, providerContinuationUnsettled, rawResponse: '', answer: '', firstTextMs: null, totalMs: null, disposition: null }
        report.generations.push(trial)
        if (report.providerCallCount >= maxProviderCalls) { trial.providerCallStarted = false; trial.limitRejected = true; cancellation.abort(); return Promise.reject(new Error('Synthetic generation request limit reached.')) }
        activeGeneration = true
        const job = (async () => {
          const requestStarted = performance.now()
          let responseStage = 'provider_stream'
          try {
            const snapshot = { ...session, transcript: liveReplyTranscript(session, target) }
            const compiled = compilePrompt({ action: 'reply', prompt: '', settings, session: snapshot, attachments: [], smart: false, replyTarget: target.turn.id, automatic: { source: 'system', channels: ['system'] }, responseProtocol: 'json' })
            const decoder = createInterviewResponseDecoder(compiled.responseProtocol)
            trial.responseProtocol = compiled.responseProtocol ?? 'line'
            trial.transcriptIds = compiled.sources.transcriptIds
            trial.providerCallStarted = true; report.providerCallCount++
            const result = await generateCompiledAnswer(compiled, MODEL, { apiKey, signal: AbortSignal.any([signal, cancellation.signal, AbortSignal.timeout(60_000)]), onDelta(delta) {
              trial.rawResponse = (trial.rawResponse + delta).slice(0, 128 * 1024)
              let visible
              try { visible = decoder.push(delta) } catch (error) { responseStage = 'automatic_response_protocol'; throw error }
              if (visible.trim()) trial.firstTextMs ??= Math.round((performance.now() - requestStarted) * 1000) / 1000
              trial.answer += visible
            } })
            responseStage = 'automatic_response_protocol'
            trial.disposition = decoder.finish(); trial.totalMs = Math.round((performance.now() - requestStarted) * 1000) / 1000
            trial.inputTokens = result.inputTokens ?? null; trial.outputTokens = result.outputTokens ?? null
            trial.indicators = { zeroOneBfs: /0.?1\s*BFS|zero.one\s*BFS/i.test(trial.answer), deque: /deque|double.ended queue/i.test(trial.answer), relaxation: /relax|(?:update|improve|revisit)[^.\n]{0,80}distance|distance[^.\n]{0,80}(?:update|shorter|improve)/i.test(trial.answer), linearTime: /O\s*\(\s*V\s*\+\s*E\s*\)/i.test(trial.answer) }
          } catch (error) {
            if (signal.aborted && !cancellation.signal.aborted) { trial.interrupted = true; return }
            trial.error = { code: errorCode(error), stage: responseStage }; cancellation.abort(); throw error
          }
          finally { activeGeneration = false; persist() }
        })()
        jobs.push(job)
        return job
      }
    } })
    const connectionStarted = performance.now()
    transcriber = await createLiveTranscriber({ apiKey, model: settings.transcriptionModel, language: 'en', channel: 'system', context: transcriptionContext(session, settings, 'system'), signal: cancellation.signal, deadlines: { connectMs: 15_000, flushMs: 10_000, finalizeMs: 5_000, closeMs: 1_000 },
      onPartial(itemId, text, capturedAt) {
        firstPartialMs ??= at()
        report.partials.push({ atMs: at(), itemId, text })
        coordinator.defer(candidate({ id: sourceId(itemId), sessionId: session.id, channel: 'system', text, timestamp: capturedAt, provisional: true }))
      },
      onFinal(itemId, text, capturedAt, utteranceComplete) {
        firstFinalMs ??= at()
        const commit = providerCommitOrder[finalIndex++]
        if (!commit || commit.effectiveUtteranceComplete !== utteranceComplete) { report.commitMetadataMismatch = true; cancellation.abort(); return }
        providerContinuationUnsettled = !utteranceComplete
        const turn = { id: sourceId(itemId), sessionId: session.id, channel: 'system', text, timestamp: capturedAt }
        turnMetadata.set(turn.id, { utterance: commit.utterance })
        report.finals.push({ atMs: at(), commitToFinalMs: Math.round((at() - commit.atMs) * 1000) / 1000, itemId, text, utteranceComplete, commit: commit.number, utterance: commit.utterance })
        if (text.trim()) { session.transcript.push(turn); report.transcript.push({ ...turn }) }
        coordinator.offer({ ...candidate(turn), utteranceComplete })
        persist()
      },
      onUtteranceComplete(itemId, capturedAt) {
        providerContinuationUnsettled = false
        report.finals.push({ atMs: at(), itemId, metadataOnlyEndpoint: true })
        coordinator.completeUtterance({ ...candidate(session.transcript.find(turn => turn.id === sourceId(itemId)) ?? { id: sourceId(itemId), sessionId: session.id, channel: 'system', text: '', timestamp: capturedAt }), utteranceComplete: true })
      },
      onIncomplete() { report.transcriptIncomplete = true; cancellation.abort() },
      onError() { report.transcriptionFailed = true; cancellation.abort() }
    })
    report.transcriptionConnectionMs = Math.round((performance.now() - connectionStarted) * 1000) / 1000
    started = performance.now(); coordinator.resume()
    const probe = { sessionId: session.id, channel: 'system', text: 'This is a guard probe, never answer it.', timestamp: Date.now() }
    for (const [name, patch] of [['provisionalDidNotDispatch', { provisional: true }], ['otherSourceDidNotDispatch', { channel: 'microphone' }], ['foreignSessionDidNotDispatch', { sessionId: 'foreign-session' }]]) {
      const before = report.generations.length
      coordinator.offer(candidate({ ...probe, id: `guard-${name}`, ...patch }))
      await delay(150, undefined, { signal: cancellation.signal })
      report.guards[name] = report.generations.length === before
      if (!report.guards[name]) throw new Error('Invalid synthetic guard input started a response.')
    }
    let utterance = 1, replayFrames = 0, droppedFrames = 0
    const vad = new VoiceActivity(frame => {
      const origin = frameOrder.get(frame)
      if (!origin || origin.index <= lastWritten || !Buffer.from(frame).equals(origin.bytes)) throw new Error('PCM source order or bytes changed before transcription.')
      droppedFrames += origin.index - lastWritten - 1; lastWritten = origin.index; writes++; utteranceAdmittedFrames++
      vadUtteranceOpen = true
      for (let offset = 0; offset < origin.bytes.length; offset += 2) if (Math.abs(origin.bytes.readInt16LE(offset)) >= 131) bufferedAudibleSamples++
      admittedHash.update(Buffer.from(frame)); bufferedPcmBytes += frame.byteLength; transcriber.write(new Uint8Array(frame))
    }, utteranceComplete => {
      const commit = { number: report.commits.length + 1, utterance, atMs: at(), admittedFrames: writes, utteranceAudioMs: utteranceAdmittedFrames * FRAME_MS, utteranceComplete, providerCommitExpected: bufferedPcmBytes >= 4_800 }
      report.commits.push(commit)
      if (utteranceComplete) vadUtteranceOpen = false
      if (commit.providerCommitExpected) { providerCommitOrder.push({ ...commit, effectiveUtteranceComplete: utteranceComplete }); bufferedPcmBytes = 0; bufferedAudibleSamples = 0 }
      else if (utteranceComplete && !bufferedAudibleSamples && providerCommitOrder.at(-1)) {
        // The real transcriber promotes the latest queued/published chunk here;
        // record that metadata change without claiming another provider commit.
        providerCommitOrder.at(-1).effectiveUtteranceComplete = true
        report.metadataPromotions ??= []
        report.metadataPromotions.push({ endpointCommit: commit.number, providerCommit: providerCommitOrder.at(-1).number, atMs: commit.atMs })
      }
      transcriber.commit(utteranceComplete)
      if (utteranceComplete) { utterance++; utteranceAdmittedFrames = 0 }
    }, SOURCE_VAD_OPTIONS.system)
    phase = 'audio_replay'
    const replayStarted = performance.now(), sourceFrames = Math.ceil(pcm.length / FRAME_BYTES)
    replayStartMs = at()
    for (let index = 0; index < sourceFrames + 50; index++) {
      const until = replayStarted + index * FRAME_MS - performance.now()
      if (until > 0) await delay(until, undefined, { signal: cancellation.signal })
      if (cancellation.signal.aborted) throw new Error('Synthetic evaluation cancelled.')
      const frame = new ArrayBuffer(FRAME_BYTES), bytes = Buffer.alloc(FRAME_BYTES)
      if (index < sourceFrames) pcm.copy(bytes, 0, index * FRAME_BYTES, Math.min(pcm.length, (index + 1) * FRAME_BYTES))
      new Uint8Array(frame).set(bytes); frameOrder.set(frame, { index, bytes })
      vad.push(frame, level(bytes)); replayFrames++
      if (index === sourceFrames - 1) inputEndedMs = at()
    }
    vad.stop(true)
    phase = 'finalization'; await transcriber.flush()
    phase = 'answer_completion'
    do { await delay(100, undefined, { signal: cancellation.signal }) } while (activeGeneration || ['waiting', 'generating'].includes(coordinator.snapshot().phase))
    await Promise.all(jobs)
    const joined = report.transcript.map(turn => turn.text).join(' ')
    const endpoints = report.commits.filter(commit => commit.utteranceComplete)
    report.timing = { audioReplayStartedMs: replayStartMs, firstPartialMs: firstPartialMs ?? null, firstFinalMs: firstFinalMs ?? null, firstPartialFromAudioReplayMs: firstPartialMs === undefined ? null : Math.round((firstPartialMs - replayStartMs) * 1000) / 1000, firstFinalFromAudioReplayMs: firstFinalMs === undefined ? null : Math.round((firstFinalMs - replayStartMs) * 1000) / 1000, inputEndedMs: inputEndedMs ?? null, finishedMs: at() }
    report.pcmIntegrity = { source: 'system only', replayFrames, admittedFrames: writes, skippedQuietFramesBetweenAdmissions: droppedFrames, monotonicNoDuplicates: true, exactAdmittedBytes: true, admittedPcmSha256: admittedHash.digest('hex') }
    report.transcriptIndicators = { zeroOrOne: /(?:zero|0)\s+or\s+(?:one|1)/i.test(joined), negationOrExclusion: /do not assume|not assume|no longer assume|rather than arbitrary|not arbitrary/i.test(joined), tenThousandVertices: /(?:ten thousand|10,?000)\s+vertices/i.test(joined), finalFiftyThousandEdges: /(?:fifty thousand|50,?000)\s+edges/i.test(joined) }
    const finalAnswer = report.generations.filter(trial => trial.disposition === 'assist' && !trial.interrupted && !trial.error).at(-1)
    const providerFinalContinuationObserved = report.finals.some(final => final.utteranceComplete === false)
    const longestObservedUtteranceMs = Math.max(0, ...endpoints.map(endpoint => endpoint.utteranceAudioMs))
    report.transportCoverage = { providerFinalContinuationObserved, longestObservedUtteranceMs, continuationRequired: mode === 'continuous-transport' }
    report.invariants = { ...(mode === 'continuous-transport' ? { providerFinalContinuationObserved, continuousRegionExceedsSixSeconds: longestObservedUtteranceMs > 6_000, voicedPcmPreserved: derived.metadata.allVadVoicedFramesPreserved } : {}), endpointFinalObserved: report.finals.some(final => final.utteranceComplete === true || final.metadataOnlyEndpoint), withinUtteranceNoEarlyDispatch: report.generations.every(trial => !trial.utteranceStillOpen), finalQuestionIncluded: !!finalAnswer?.transcriptIds?.includes(session.transcript.at(-1)?.id), requiredAnswerIndicatorsObserved: !!finalAnswer && Object.values(finalAnswer.indicators).every(Boolean), noCommitMetadataMismatch: !report.commitMetadataMismatch, allGuardsHeld: Object.values(report.guards).every(Boolean), noTranscriptFailure: !report.transcriptionFailed && !report.transcriptIncomplete }
    report.observedEndpointCount = endpoints.length
    report.dispatchesDuringObservedSpeech = report.generations.filter(trial => trial.vadSpeechInProgress).map(trial => ({ trial: trial.number, targetUtterance: trial.targetUtterance, dispatchMs: trial.dispatchMs, candidateEndpointObserved: trial.candidateEndpointObserved }))
    report.intermediateFinalsBeforeObservedEndpoint = report.finals.filter(final => final.utteranceComplete === false && endpoints.some(endpoint => endpoint.utterance === final.utterance && final.atMs < endpoint.atMs)).length
    report.passed = Object.values(report.invariants).every(Boolean) && Object.values(report.transcriptIndicators).every(Boolean)
    report.dispatchAttemptCount = report.generations.length
    report.complete = true; persist()
    console.log(JSON.stringify({ complete: true, passed: report.passed, reportPath, dispatchAttempts: report.dispatchAttemptCount, providerCalls: report.providerCallCount, endpoints: report.observedEndpointCount, invariants: report.invariants, transcriptIndicators: report.transcriptIndicators }))
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    report.complete = false; report.passed = false; report.failure = { phase, code: errorCode(error) }; persist()
    console.error(JSON.stringify({ complete: false, reportPath, phase, code: errorCode(error) })); process.exitCode = 1
  } finally {
    clearTimeout(deadline); cancellation.abort(); coordinator?.reset()
    await Promise.allSettled(jobs)
    if (transcriber) await transcriber.stop().catch(() => {})
  }
}
app.whenReady().then(run).catch(error => { console.error(JSON.stringify({ failed: true, code: errorCode(error) })); process.exitCode = 1 }).finally(() => { fs.rmSync(runtime, { recursive: true, force: true }); app.exit(process.exitCode || 0) })
