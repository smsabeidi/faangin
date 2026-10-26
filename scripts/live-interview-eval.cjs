/* Explicit opt-in evaluation. Reads the existing OS-encrypted key in memory;
 * sends only public synthetic interview data, never primary session contents.
 * Run with Electron and FAANGIN_LIVE_EVAL=1 after generating a 24kHz mono WAV.
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
require('tsx/cjs')
const { createLiveTranscriber, generateCompiledAnswer, verifyKey, verifyConfiguredModels, InferenceError } = require('../src/main/inference.ts')
const { compilePrompt } = require('../src/main/prompts.ts')
const { InterviewResponseDecoder } = require('../src/main/interview-response.ts')
const { DEFAULT_SETTINGS, DEFAULT_INTERVIEW_CONTEXT } = require('../src/shared/types.ts')

app.setName('Faangin')
const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'faangin-live-eval-'))
app.setPath('userData', runtimeDirectory)
const report = { synthetic: true, physicalCapture: false, primaryWorkspaceModified: false, runtimeIsolated: true, trials: [] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function pcmWav(file) {
  const wav = fs.readFileSync(file)
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a PCM WAV fixture.')
  let format, pcm
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), bytes = wav.subarray(offset + 8, offset + 8 + size)
    if (id === 'fmt ') format = bytes
    if (id === 'data') pcm = bytes
    offset += 8 + size + size % 2
  }
  if (!format || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 24_000 || format.readUInt16LE(14) !== 16 || !pcm?.length) throw new Error('Expected 24kHz mono PCM16.')
  return pcm
}
async function run() {
  if (process.env.FAANGIN_LIVE_EVAL !== '1') throw new Error('Live evaluation requires explicit opt-in.')
  const keyFile = path.join(os.homedir(), 'Library/Application Support/Faangin/openai.key.enc')
  if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(keyFile)) throw new Error('The saved encrypted OpenAI connection is unavailable.')
  const apiKey = safeStorage.decryptString(fs.readFileSync(keyFile))
  if (process.env.FAANGIN_EVAL_ACCESS_ONLY === '1') {
    const access = await verifyConfiguredModels(apiKey, { fastModel: 'gpt-6-luna', smartModel: 'gpt-6.1-sol', transcriptionModel: 'gpt-live-transcribe' })
    fs.writeFileSync('/private/tmp/faangin-handsfree-model-access.json', JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(access)); return
  }
  let model = process.env.FAANGIN_EVAL_MODEL || 'gpt-4.1-mini'
  if (process.env.FAANGIN_EVAL_MODERN === '1') {
    try { await verifyKey(apiKey, 'gpt-6-luna'); model = 'gpt-6-luna' }
    catch (error) { report.modernModelAccess = { available: false, code: error.code || 'unavailable' } }
  }
  report.model = model
  report.stage = 'transcription'
  const pcm = pcmWav(process.env.FAANGIN_EVAL_WAV)
  let transcript = '', firstPartialMs, committedAt
  const audioStarted = performance.now()
  let resolveFinal, rejectFinal
  const finalized = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject })
  // Attach a handler before network startup so early errors cannot be unhandled.
  void finalized.catch(() => {})
  const transcriber = await createLiveTranscriber({ apiKey, model: 'gpt-live-transcribe', language: 'en', channel: 'system', context: 'Technical interview about BFS and DFS in an unweighted graph. Transcribe verbatim; do not answer.', onPartial(_id, text) { if (text.trim()) firstPartialMs ??= Math.round(performance.now() - audioStarted) }, onFinal(_id, text) { transcript = text; resolveFinal() }, onError() { rejectFinal(new Error('Live synthetic transcription failed.')) } })
  try {
    for (let offset = 0; offset < pcm.length; offset += 960) { transcriber.write(pcm.subarray(offset, offset + 960)); await delay(20) }
    committedAt = performance.now(); transcriber.commit()
    let timer
    try { await Promise.race([finalized, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic transcription timed out.')), 12_000) })]) }
    finally { clearTimeout(timer) }
    report.transcription = { text: transcript, pcmSeconds: pcm.length / 48_000, firstPartialMs, commitToFinalMs: Math.round(performance.now() - committedAt) }
  } finally { await transcriber.stop() }
  const settings = { ...DEFAULT_SETTINGS, fastModel: model, smartModel: model }
  const session = { id: 'synthetic-interview', title: 'Public synthetic evaluation', mode: 'interview', status: 'recording', createdAt: 0, updatedAt: 0, notes: '', contextEpoch: 0, transcript: [], answers: [], attachments: [], interview: { ...DEFAULT_INTERVIEW_CONTEXT, problem: 'Find the shortest path in an unweighted graph. The proposed implementation uses a queue and BFS.', constraints: 'Initially all edges have equal weight.' } }
  async function trial(id, text, expected, channel = 'system', other = []) {
    const turn = { id, sessionId: session.id, channel, text, timestamp: Date.now() }
    session.transcript.push(turn, ...other.map((text, index) => ({ id: `${id}-candidate-${index}`, sessionId: session.id, channel: 'microphone', text, timestamp: turn.timestamp + index + 1 })))
    report.stage = id
    const compiled = compilePrompt({ action: 'reply', prompt: '', settings, session, attachments: [], replyTarget: id, automatic: { source: channel, channels: channel === 'system' ? ['system', 'microphone'] : ['microphone'] } })
    const decoder = new InterviewResponseDecoder(), started = performance.now()
    let visible = '', firstVisibleMs
    const result = await generateCompiledAnswer(compiled, model, { apiKey, signal: AbortSignal.timeout(35_000), maxOutputTokens: 600, onDelta(delta) { const body = decoder.push(delta); if (body.trim()) firstVisibleMs ??= Math.round(performance.now() - started); visible += body } })
    const disposition = decoder.finish()
    report.trials.push({ id, expected, disposition, passed: expected === disposition, firstVisibleMs, totalMs: Math.round(performance.now() - started), inputTokens: result.inputTokens, outputTokens: result.outputTokens, answer: visible })
    fs.writeFileSync(process.env.FAANGIN_EVAL_REPORT || '/private/tmp/faangin-live-interview-eval.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    if (disposition === 'assist') session.answers.push({ id: `answer-${id}`, requestId: id, sessionId: session.id, action: 'reply', origin: 'automatic', prompt: '', text: visible, model, status: 'complete', createdAt: turn.timestamp + 2, context: { transcriptIds: compiled.sources.transcriptIds, replyTargetId: id, attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, interviewContextKey: compiled.sources.interviewContextKey, interviewSnapshot: compiled.sources.interviewSnapshot } })
  }
  await trial('bfs-question', transcript, 'assist')
  await trial('already-answered', 'Why use BFS instead of DFS?', 'wait', 'system', ['BFS explores vertices in shortest-distance order in this unweighted graph, so the first visit finds a shortest path. DFS may find a longer path first. Both have O(V + E) traversal time and O(V) worst-case space.'])
  await trial('acknowledgment', 'Yes, exactly. Thank you.', 'wait', 'system', ['BFS visits vertices by distance, so the first visit gives a shortest path. DFS can take a longer path first.'])
  await trial('changed-scenario', 'Now suppose edges have different nonnegative weights. Should we keep the same queue and BFS implementation?', 'assist')
  await trial('candidate-thinking', 'I am thinking out loud. Let me work through that example for a moment. I might use a heap, but I am still reasoning about the invariant.', 'wait', 'microphone')
  report.passed = report.trials.every(trial => trial.passed)
  fs.writeFileSync(process.env.FAANGIN_EVAL_REPORT || '/private/tmp/faangin-live-interview-eval.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ passed: report.passed, model, trials: report.trials.map(({ id, disposition, passed, firstVisibleMs, totalMs }) => ({ id, disposition, passed, firstVisibleMs, totalMs })), transcription: report.transcription }))
  if (!report.passed) process.exitCode = 1
}
app.whenReady().then(run).catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || 'evaluation_error', stage: report.stage, message: error instanceof InferenceError ? error.message : /^The saved encrypted|^Expected|^Live evaluation|^Synthetic transcription|^Live synthetic/.test(error.message) ? error.message : 'Live evaluation could not complete; no credentials were printed.' })); process.exitCode = 1 }).finally(() => app.exit(process.exitCode || 0))
