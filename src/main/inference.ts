import WebSocket, { type ClientOptions, type RawData } from 'ws'
import type { AudioChannel, ConnectionReport, Settings } from '../shared/types'
import { compilePrompt, ContextError, type AnswerInput, type CompiledPrompt } from './prompts'
import { answerReasoning, supportsImageInput } from './model-capabilities'

const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const MAX_EVENT_CHARACTERS = 256 * 1024
const MAX_OUTPUT_CHARACTERS = 128 * 1024
const MAX_SOCKET_BUFFER = 30 * 24_000 * 2
const MAX_PENDING_COMMITS = 32
const MIN_COMMIT_BYTES = 2_400 * 2 // Realtime rejects turns shorter than 100 ms.

export type InferenceErrorCode = 'invalid_credentials' | 'permission_denied' | 'unsupported_capability' | 'rate_limited' | 'quota_exhausted' | 'offline' | 'timeout' | 'malformed_response' | 'cancelled' | 'missing_context' | 'invalid_input'
export class InferenceError extends Error {
  constructor(readonly code: InferenceErrorCode, message: string) { super(message); this.name = 'InferenceError' }
}

/** Main-process dependency injection for local fixtures; endpoints are never renderer settings. */
export interface InferenceTransport {
  fetch?: typeof globalThis.fetch
  createWebSocket?: (url: string, options: ClientOptions) => WebSocket
}
interface DeadlineOptions { connectMs?: number; firstTokenMs?: number; inactivityMs?: number; totalMs?: number }
export interface GenerationOptions {
  apiKey: string
  signal: AbortSignal
  onDelta: (delta: string) => void
  transport?: InferenceTransport
  deadlines?: DeadlineOptions
  maxOutputTokens?: number
}
export interface AnswerResult { text: string; model: string; inputTokens?: number; outputTokens?: number }

function validKey(apiKey: string): string {
  const key = apiKey.trim()
  if (!key || key.length > 1_024 || /[\r\n]/.test(key)) throw new InferenceError('invalid_credentials', 'Enter a valid OpenAI API key in Settings, then try again.')
  return key
}
function validModel(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw new InferenceError('invalid_input', 'Enter a valid OpenAI model ID in Settings.')
  return model
}
function safeProviderError(status?: number, value?: unknown): InferenceError {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const detail = object.error && typeof object.error === 'object' ? object.error as Record<string, unknown> : object
  const code = typeof detail.code === 'string' ? detail.code : typeof detail.type === 'string' ? detail.type : ''
  if (status === 401 || ['invalid_api_key', 'authentication_error'].includes(code)) return new InferenceError('invalid_credentials', 'OpenAI rejected the API key. Replace it in Settings and test the connection.')
  if (status === 403 || code === 'permission_denied') return new InferenceError('permission_denied', 'This OpenAI project does not have permission for the selected model. Check project access or select another model.')
  if (code === 'insufficient_quota' || code === 'quota_exceeded') return new InferenceError('quota_exhausted', 'OpenAI quota is exhausted. Check billing and project limits before trying again.')
  if (status === 429 || code === 'rate_limit_exceeded') return new InferenceError('rate_limited', 'OpenAI is rate limiting this request. Wait, then retry explicitly.')
  if (status === 404 || ['model_not_found', 'unsupported_model', 'unsupported_value'].includes(code)) return new InferenceError('unsupported_capability', 'The selected OpenAI model or capability is unavailable. Check the model in Settings.')
  if (status === 400 || status === 413 || code === 'invalid_request_error') return new InferenceError('invalid_input', 'OpenAI rejected the request configuration or input size. Check the selected model, language, and attachments.')
  if (status && status >= 500) return new InferenceError('offline', 'OpenAI is temporarily unavailable. Your partial output is retained; retry explicitly when service returns.')
  return new InferenceError('malformed_response', 'OpenAI could not complete this request. Your partial output is retained; retry explicitly.')
}
function cancelled(): InferenceError { return new InferenceError('cancelled', 'The request was cancelled.') }
function malformed(): InferenceError { return new InferenceError('malformed_response', 'OpenAI returned an incomplete or malformed stream. Your partial output is retained; retry explicitly.') }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? cancelled())
    if (signal.aborted) { void promise.catch(() => {}); reject(signal.reason ?? cancelled()); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** SSE line framing handles LF, CRLF (including split CR/LF), comments, and multiline data. */
class EventDecoder {
  private buffer = ''
  private data: string[] = []
  private event = ''
  private eventSize = 0
  push(chunk: string, final = false): Array<{ event: string; data: string }> {
    this.buffer += chunk
    if (this.buffer.length > MAX_EVENT_CHARACTERS) throw malformed()
    const result: Array<{ event: string; data: string }> = []
    const line = (text: string): void => {
      if (!text) {
        if (this.data.length) result.push({ event: this.event, data: this.data.join('\n') })
        this.data = []; this.event = ''; this.eventSize = 0
        return
      }
      if (text.startsWith(':')) return
      const separator = text.indexOf(':')
      const field = separator < 0 ? text : text.slice(0, separator)
      const raw = separator < 0 ? '' : text.slice(separator + 1)
      const value = raw.startsWith(' ') ? raw.slice(1) : raw
      if (field === 'data') { this.eventSize += value.length; if (this.eventSize > MAX_EVENT_CHARACTERS) throw malformed(); this.data.push(value) }
      else if (field === 'event') this.event = value
    }
    while (true) {
      const index = this.buffer.search(/[\r\n]/)
      if (index < 0 || (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1)) break
      const length = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1
      line(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index + length)
    }
    if (final) { if (this.buffer) line(this.buffer); this.buffer = ''; line('') }
    return result
  }
}

async function errorBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  let text = ''; let size = 0
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > 32_768) return undefined
      text += decoder.decode(value, { stream: true })
    }
    try { return JSON.parse(text + decoder.decode()) } catch { return undefined }
  } finally { void reader.cancel().catch(() => {}) }
}

function finalText(response: Record<string, unknown>): string {
  if (!Array.isArray(response.output)) return ''
  return response.output.flatMap(item => {
    if (!item || typeof item !== 'object' || !Array.isArray(item.content)) return []
    return item.content.flatMap((part: unknown) => {
      if (!part || typeof part !== 'object') return []
      const content = part as Record<string, unknown>
      return content.type === 'output_text' && typeof content.text === 'string' ? [content.text] : content.type === 'refusal' && typeof content.refusal === 'string' ? [content.refusal] : []
    })
  }).join('')
}

export async function generateAnswer(input: AnswerInput, options: GenerationOptions): Promise<AnswerResult> {
  if (options.signal.aborted) throw cancelled()
  validKey(options.apiKey)
  const model = validModel((input.smart ?? input.settings.smartMode) ? input.settings.smartModel : input.settings.fastModel)
  let prompt
  try { prompt = compilePrompt(input) } catch (error) {
    if (error instanceof ContextError) throw new InferenceError('missing_context', error.message)
    throw new InferenceError('invalid_input', error instanceof Error ? error.message : 'Review the request context and selected images.')
  }
  return generateCompiledAnswer(prompt, model, options)
}

/** Main-process admission has already validated and frozen this context snapshot. */
export async function generateCompiledAnswer(prompt: CompiledPrompt, selectedModel: string, options: GenerationOptions): Promise<AnswerResult> {
  if (options.signal.aborted) throw cancelled()
  const key = validKey(options.apiKey), model = validModel(selectedModel)
  if (prompt.sources.attachmentIds.length && !supportsImageInput(model)) throw new InferenceError('unsupported_capability', 'Select a supported image model in Settings, such as gpt-6-luna, gpt-6.1-sol or gpt-4.1.')
  const maxOutputTokens = options.maxOutputTokens ?? prompt.maxOutputTokens
  if (options.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > prompt.maxOutputTokens) throw new InferenceError('invalid_input', 'The request output limit is outside its allowed range.')
  }
  const controller = new AbortController()
  let abortError: InferenceError | undefined
  const abort = (error: InferenceError): void => { if (!controller.signal.aborted) { abortError = error; controller.abort(error) } }
  const callerAbort = (): void => abort(cancelled())
  options.signal.addEventListener('abort', callerAbort, { once: true })
  if (options.signal.aborted) callerAbort()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const timeout = (ms: number, message: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => abort(new InferenceError('timeout', message)), ms); timers.add(timer); return timer
  }
  const clear = (timer: ReturnType<typeof setTimeout> | undefined): void => { if (timer) { clearTimeout(timer); timers.delete(timer) } }
  timeout(options.deadlines?.totalMs ?? 120_000, 'The answer exceeded its time limit. Partial output is retained; retry explicitly.')
  const connectionTimer = timeout(options.deadlines?.connectMs ?? 15_000, 'Connecting to OpenAI timed out. Check your connection, then retry.')
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let text = ''; let completed: Record<string, unknown> | undefined
  const emit = (delta: string): void => {
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (text.length + delta.length > MAX_OUTPUT_CHARACTERS) throw malformed()
    text += delta
    clear(firstTokenTimer); clear(inactivityTimer)
    inactivityTimer = timeout(options.deadlines?.inactivityMs ?? 20_000, 'OpenAI stopped sending answer text. Partial output is retained; retry explicitly.')
    options.onDelta(delta)
  }
  try {
    const fetcher = options.transport?.fetch ?? globalThis.fetch
    const response = await abortable(fetcher(RESPONSES_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model, instructions: prompt.instructions, input: prompt.input, stream: true, store: false, max_output_tokens: maxOutputTokens, ...answerReasoning(model) }),
      signal: controller.signal
    }), controller.signal)
    clear(connectionTimer)
    if (!response.ok) throw safeProviderError(response.status, await errorBody(response, controller.signal))
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw malformed()
    firstTokenTimer = timeout(options.deadlines?.firstTokenMs ?? 30_000, 'OpenAI did not start an answer in time. Retry explicitly or choose the Fast model.')
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const parser = new EventDecoder()
    const processEvents = (events: Array<{ event: string; data: string }>): void => {
      for (const event of events) {
        if (controller.signal.aborted) throw abortError ?? cancelled()
        if (completed || event.data === '[DONE]') continue
        let value: Record<string, unknown>
        try { value = JSON.parse(event.data) } catch { throw malformed() }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed()
        const type = typeof value.type === 'string' ? value.type : event.event
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          if (typeof value.delta !== 'string') throw malformed()
          if (value.delta) emit(value.delta)
        } else if (type === 'response.completed') {
          if (!value.response || typeof value.response !== 'object') throw malformed()
          const result = value.response as Record<string, unknown>
          if (result.status && result.status !== 'completed') throw safeProviderError(undefined, result)
          completed = result
        } else if (type === 'error' || type === 'response.failed') throw safeProviderError(undefined, value.response ?? value)
        else if (type === 'response.incomplete') throw new InferenceError('malformed_response', 'The answer was cut short by the provider. Partial output is retained; retry with a narrower request.')
      }
    }
    while (!completed) {
      const chunk = await abortable(reader.read(), controller.signal)
      let decoded: string
      try { decoded = decoder.decode(chunk.value, { stream: !chunk.done }) } catch { throw malformed() }
      processEvents(parser.push(decoded, chunk.done))
      if (chunk.done) break
    }
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (!completed) throw malformed()
    const authoritativeText = finalText(completed)
    if (authoritativeText && authoritativeText !== text) {
      if (!authoritativeText.startsWith(text)) throw malformed()
      emit(authoritativeText.slice(text.length))
    }
    if (!text.trim()) throw new InferenceError('malformed_response', 'OpenAI completed without answer text. Refine the request and retry explicitly.')
    const usage = completed.usage && typeof completed.usage === 'object' ? completed.usage as Record<string, unknown> : {}
    const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    return { text, model: typeof completed.model === 'string' && completed.model.length <= 128 ? completed.model : model, inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) }
  } catch (error) {
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (error instanceof InferenceError) throw error
    if (error instanceof TypeError) throw new InferenceError('offline', 'Could not reach OpenAI. Check your internet connection, then retry explicitly.')
    throw malformed()
  } finally {
    for (const timer of timers) clearTimeout(timer)
    options.signal.removeEventListener('abort', callerAbort)
    // Cancelling the body and controller releases the actual transport, including on malformed events.
    controller.abort()
    if (reader) void reader.cancel().catch(() => {})
  }
}

/** Check credentials and model visibility without a paid inference request. */
export async function verifyKey(apiKey: string, model: string, transport: InferenceTransport = {}, timeoutMs = 15_000): Promise<void> {
  const key = validKey(apiKey); validModel(model)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new InferenceError('timeout', 'Testing the OpenAI connection timed out. Check your connection, then try again.')), timeoutMs)
  try {
    const response = await abortable((transport.fetch ?? globalThis.fetch)(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal }), controller.signal)
    if (!response.ok) throw safeProviderError(response.status, await errorBody(response, controller.signal))
    void response.body?.cancel().catch(() => {})
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof InferenceError) throw error
    throw new InferenceError('offline', 'Could not reach OpenAI. Check your internet connection and test again.')
  } finally { clearTimeout(timer); controller.abort() }
}

/** Verify credentials and configured model visibility; this does not spend generation tokens or test audio. */
export async function verifyConfiguredModels(apiKey: string, settings: Pick<Settings, 'fastModel' | 'smartModel' | 'transcriptionModel'>, transport: InferenceTransport = {}): Promise<ConnectionReport> {
  const entries = [{ label: 'Fast answers', model: settings.fastModel }, { label: 'Smart answers', model: settings.smartModel }, { label: 'Transcription', model: settings.transcriptionModel }]
  const pending = new Map<string, Promise<void>>()
  for (const { model } of entries) if (!pending.has(model)) pending.set(model, verifyKey(apiKey, model, transport))
  const checks = await Promise.all(entries.map(async entry => {
    try { await pending.get(entry.model); return { ...entry, ok: true, message: 'Model access verified' } }
    catch (error) { return { ...entry, ok: false, message: error instanceof InferenceError ? error.message : 'Model access could not be verified.' } }
  }))
  const ok = checks.every(check => check.ok)
  return { ok, checks, message: ok ? 'Credentials and configured model access verified. Live answers, quota, and audio still require a session test.' : 'One or more configured models could not be verified. Review the results below.' }
}

export interface TranscriberOptions {
  apiKey: string
  model: string
  language: string
  channel: AudioChannel
  context?: string
  onPartial: (itemId: string, text: string, capturedAt: number) => void
  onFinal: (itemId: string, text: string, capturedAt: number) => void
  onIncomplete?: (message: string) => void
  onError: (message: string) => void
  /** Cancels admission until session.updated; stop() owns finalization after readiness. */
  signal?: AbortSignal
  transport?: InferenceTransport
  deadlines?: { connectMs?: number; finalizeMs?: number; closeMs?: number; flushMs?: number }
}
export interface LiveTranscriber { write(pcm: Uint8Array): void; commit(): void; flush(): Promise<void>; stop(): Promise<void> }

export async function createLiveTranscriber(options: TranscriberOptions): Promise<LiveTranscriber> {
  if (options.signal?.aborted) throw cancelled()
  const key = validKey(options.apiKey); const model = validModel(options.model)
  if (!['gpt-live-transcribe', 'gpt-transcribe'].includes(model)) throw new InferenceError('unsupported_capability', 'Select gpt-live-transcribe for live transcription in Settings.')
  if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(options.language)) throw new InferenceError('invalid_input', 'Select a supported input language code in Settings, such as en or es.')
  const createSocket = options.transport?.createWebSocket ?? ((url: string, configuration: ClientOptions) => new WebSocket(url, configuration))
  let socket: WebSocket
  try { socket = createSocket(TRANSCRIPTION_URL, { headers: { Authorization: `Bearer ${key}` }, maxPayload: MAX_EVENT_CHARACTERS, handshakeTimeout: options.deadlines?.connectMs ?? 15_000 }) }
  catch { throw new InferenceError('offline', 'Could not connect live transcription. Check your internet connection and start capture again.') }
  type Item = { itemId?: string; final?: string; capturedAt: number }
  const commits: Item[] = []
  const finalizationWaiters = new Set<{ pending: Set<Item>; finish(error?: Error): void }>()
  const items = new Map<string, { text: string; final?: string; capturedAt: number }>()
  const published = new Set<string>()
  let ready = false; let stopping = false; let failed = false; let closed = false; let acceptingEvents = true
  let audioBytes = 0; let audibleSamples = 0; let tail: number | undefined; let sequence = 0; let capturedAt = 0
  let stopPromise: Promise<void> | undefined
  let settleDrain: (() => void) | undefined
  let closeResolve: (() => void) | undefined
  let readyResolve!: () => void; let readyReject!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const admissionAbort = (): void => { if (!ready) fail(cancelled()) }
  const connectTimer = setTimeout(() => fail(new InferenceError('timeout', 'Live transcription did not become ready in time. Check your connection and start capture again.')), options.deadlines?.connectMs ?? 15_000)
  function fail(error: InferenceError): void {
    if (failed || closed || !acceptingEvents) return
    failed = true; clearTimeout(connectTimer); options.signal?.removeEventListener('abort', admissionAbort)
    for (const waiter of [...finalizationWaiters]) waiter.finish(error)
    if (ready && (commits.length || (audioBytes >= MIN_COMMIT_BYTES && audibleSamples >= 240))) options.onIncomplete?.('Transcription ended before all captured speech could be finalized. The transcript may be incomplete.')
    if (ready) options.onError(error.message)
    else readyReject(error)
    commits.length = 0; items.clear(); tail = undefined; audioBytes = 0; audibleSamples = 0
    settleDrain?.()
    socket.terminate()
  }
  const send = (event: Record<string, unknown>): boolean => {
    if (failed || closed || socket.readyState !== WebSocket.OPEN) return false
    const message = JSON.stringify(event)
    if (socket.bufferedAmount + Buffer.byteLength(message) > MAX_SOCKET_BUFFER) {
      fail(new InferenceError('offline', 'Live transcription cannot keep up with audio. Capture for this channel stopped; check your connection and start it again.'))
      return false
    }
    try { socket.send(message, error => { if (error) fail(new InferenceError('offline', 'Live transcription could not send audio. Check your connection and start capture again.')) }); return true }
    catch { fail(new InferenceError('offline', 'Live transcription disconnected. Check your connection and start capture again.')); return false }
  }
  const flushFinals = (): void => {
    while (commits[0]?.itemId && commits[0].final !== undefined) {
      const item = commits.shift()!; const id = item.itemId!
      if (!published.has(id)) {
        published.add(id); if (published.size > 2_048) published.delete(published.values().next().value!)
        items.delete(id)
        // An empty final still retires provisional speech shown or used by the app.
        options.onFinal(id, item.final!, item.capturedAt)
      }
      for (const waiter of [...finalizationWaiters]) {
        waiter.pending.delete(item)
        if (!waiter.pending.size) waiter.finish()
      }
    }
    if (!commits.length) settleDrain?.()
  }
  const commitBuffered = (): void => {
    if (audioBytes < MIN_COMMIT_BYTES) return
    if (commits.length >= MAX_PENDING_COMMITS) { fail(new InferenceError('offline', 'Too many audio turns are awaiting transcription. Capture for this channel stopped; start it again after checking your connection.')); return }
    commits.push({ capturedAt })
    if (send({ type: 'input_audio_buffer.commit', event_id: `faangin_${options.channel}_${++sequence}` })) { audioBytes = 0; audibleSamples = 0; tail = undefined }
  }
  socket.on('open', () => {
    if (stopping || failed) { socket.terminate(); return }
    send({ type: 'session.update', session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: model === 'gpt-live-transcribe' ? { model, languages: [options.language], delay: 'low', ...(options.context ? { prompt: options.context.slice(0, 2_500) } : {}) } : { model }, turn_detection: null
    } } } })
  })
  socket.on('message', (raw: RawData) => {
    if (failed || closed || !acceptingEvents) return
    let event: Record<string, unknown>
    try { event = JSON.parse(raw.toString()) } catch { fail(malformed()); return }
    if (!event || typeof event !== 'object') { fail(malformed()); return }
    if (event.type === 'session.updated') { if (!ready && !stopping) { ready = true; clearTimeout(connectTimer); options.signal?.removeEventListener('abort', admissionAbort); readyResolve() }; return }
    if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') { fail(safeProviderError(undefined, event)); return }
    const id = typeof event.item_id === 'string' && event.item_id.length <= 128 ? event.item_id : undefined
    if (event.type === 'input_audio_buffer.committed') {
      if (!id || published.has(id) || commits.some(item => item.itemId === id)) return
      const slot = commits.find(item => !item.itemId)
      if (!slot) { fail(malformed()); return }
      slot.itemId = id; slot.final = items.get(id)?.final; flushFinals(); return
    }
    if (event.type !== 'conversation.item.input_audio_transcription.delta' && event.type !== 'conversation.item.input_audio_transcription.completed') return
    if (!id) { fail(malformed()); return }
    if (published.has(id)) return
    if (!items.has(id)) {
      if (items.size >= MAX_PENDING_COMMITS * 2) { fail(malformed()); return }
      items.set(id, { text: '', capturedAt: commits.find(commit => commit.itemId === id)?.capturedAt || capturedAt || Date.now() })
    }
    const item = items.get(id)!
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      if (item.final !== undefined) return
      if (typeof event.delta !== 'string' || item.text.length + event.delta.length > 32_768) { fail(malformed()); return }
      item.text += event.delta; if (!stopping) options.onPartial(id, item.text, item.capturedAt)
    } else {
      if (typeof event.transcript !== 'string' || event.transcript.length > 32_768) { fail(malformed()); return }
      if (item.final !== undefined) return
      item.final = event.transcript
      const slot = commits.find(candidate => candidate.itemId === id)
      if (slot) slot.final = item.final
      flushFinals()
    }
  })
  socket.on('unexpected-response', (_request, response) => { fail(safeProviderError(response.statusCode)); response.resume() })
  socket.on('error', () => fail(new InferenceError('offline', 'Live transcription disconnected. Check your connection and start capture again.')))
  socket.on('close', () => {
    if (ready && !stopping && !failed && (commits.length || (audioBytes >= MIN_COMMIT_BYTES && audibleSamples >= 240))) options.onIncomplete?.('Live transcription disconnected before all captured speech could be finalized. The transcript may be incomplete.')
    closed = true; clearTimeout(connectTimer); options.signal?.removeEventListener('abort', admissionAbort); closeResolve?.(); settleDrain?.()
    for (const waiter of [...finalizationWaiters]) waiter.finish(new InferenceError('offline', 'Live transcription disconnected before the question was finalized. Check the transcript and retry.'))
    if (!ready && !failed) readyReject(new InferenceError('offline', 'Live transcription closed before it was ready. Start capture again.'))
    else if (!stopping && !failed) options.onError('Live transcription disconnected. Check your connection and start capture again.')
  })
  options.signal?.addEventListener('abort', admissionAbort, { once: true })
  if (options.signal?.aborted) admissionAbort()
  await readyPromise
  return {
    write(pcm): void {
      if (!ready || stopping || failed || closed || !pcm.byteLength) return
      if (pcm.byteLength > 96_000) { fail(new InferenceError('invalid_input', 'An audio frame exceeded the channel limit. Start capture again.')); return }
      const bytes = tail === undefined ? Buffer.from(pcm) : Buffer.concat([Buffer.from([tail]), Buffer.from(pcm)])
      const complete = bytes.length - bytes.length % 2
      tail = complete === bytes.length ? undefined : bytes[complete]
      if (!complete) return
      if (audioBytes + complete > 15 * 24_000 * 2) { fail(new InferenceError('invalid_input', 'An audio turn exceeded 15 seconds without a commit. Start capture again.')); return }
      if (send({ type: 'input_audio_buffer.append', audio: bytes.subarray(0, complete).toString('base64') })) {
        if (!audioBytes) capturedAt = Date.now()
        audioBytes += complete
        for (let offset = 0; offset < complete; offset += 2) if (Math.abs(bytes.readInt16LE(offset)) >= 131) audibleSamples++
      }
    },
    commit(): void {
      if (!ready || stopping || failed || closed || audioBytes < MIN_COMMIT_BYTES) return
      commitBuffered()
    },
    flush(): Promise<void> {
      if (!ready || stopping || failed || closed) return Promise.reject(new InferenceError('offline', 'The question audio is disconnected. Check the transcript or restart listening before answering.'))
      if (audioBytes >= MIN_COMMIT_BYTES && audibleSamples >= 240) commitBuffered()
      if (failed || closed) return Promise.reject(new InferenceError('offline', 'The question could not be finalized. Restart listening or type the question.'))
      if (!commits.length) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const waiter = { pending: new Set(commits), finish(error?: Error) { clearTimeout(timer); finalizationWaiters.delete(waiter); error ? reject(error) : resolve() } }
        const timer = setTimeout(() => waiter.finish(new InferenceError('timeout', 'The latest question is still transcribing. Wait for its words in Conversation, then answer again.')), options.deadlines?.flushMs ?? 2_500)
        finalizationWaiters.add(waiter)
      })
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopping = true; tail = undefined
      for (const waiter of [...finalizationWaiters]) waiter.finish(cancelled())
      stopPromise = Promise.resolve().then(async () => {
        // Finalize speech already accepted before Stop; new frames remain blocked.
        if (!failed && !closed && audioBytes >= MIN_COMMIT_BYTES && audibleSamples >= 240) commitBuffered()
        audioBytes = 0; audibleSamples = 0
        if (!failed && !closed && commits.length) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
              if (commits.length && !failed && !closed) {
                const message = 'Live transcription ended before all committed speech was finalized. The transcript may be incomplete.'
                options.onIncomplete?.(message); options.onError(message)
              }
              resolve()
            }, options.deadlines?.finalizeMs ?? 5_000)
            settleDrain = () => { clearTimeout(timer); resolve() }
          })
        }
        acceptingEvents = false
        clearTimeout(connectTimer)
        if (!closed) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { socket.terminate(); resolve() }, options.deadlines?.closeMs ?? 1_000)
            closeResolve = () => { clearTimeout(timer); resolve() }
            try { socket.close(1000) } catch { socket.terminate(); clearTimeout(timer); resolve() }
          })
        }
        closed = true; commits.length = 0; items.clear(); published.clear()
      })
      return stopPromise
    }
  }
}
