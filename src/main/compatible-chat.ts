import { InferenceError, type AnswerResult } from './inference'
import type { CompiledPrompt, InputContent } from './prompts'

export interface CompatibleChatConfiguration { endpoint: string; model: string; vision: boolean }
export interface CompatibleChatCredential { endpoint: string; apiKey: string }
export interface CompatibleChatDeadlines { connectMs?: number; firstTokenMs?: number; inactivityMs?: number; totalMs?: number }
export interface CompatibleChatOptions {
  signal: AbortSignal
  onDelta(delta: string): void
  /** A separately entered credential bound to this exact destination; never the OpenAI key. */
  credential?: CompatibleChatCredential
  deadlines?: CompatibleChatDeadlines
  transport?: { fetch?: typeof globalThis.fetch }
}
export const COMPATIBLE_CHAT_LIMITS = { endpointCharacters: 2_048, modelCharacters: 128, messages: 32, instructionsCharacters: 32_000, textCharacters: 256_000, requestBytes: 32 * 1024 * 1024, images: 4, imageBytes: 8 * 1024 * 1024, totalImageBytes: 20 * 1024 * 1024, outputCharacters: 128 * 1024, eventCharacters: 256 * 1024, streamBytes: 2 * 1024 * 1024, events: 16_384, outputTokens: 16_384 } as const

function invalid(message: string): InferenceError { return new InferenceError('invalid_input', message) }
function malformed(): InferenceError { return new InferenceError('malformed_response', 'The configured chat service returned an incomplete or malformed stream. Partial output is retained; retry explicitly.') }
function cancelled(): InferenceError { return new InferenceError('cancelled', 'The request was cancelled.') }

/** The configured URL is the exact POST destination. Only localhost is pinned to a loopback literal; no paths or model routes are inferred. */
export function normalizeCompatibleChatEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > COMPATIBLE_CHAT_LIMITS.endpointCharacters || /[\s\\?#\u0000-\u001F\u007F]/.test(value)) throw invalid('Enter an exact HTTPS Chat Completions URL, or a literal loopback HTTP URL, without credentials, query parameters, or a fragment.')
  let url: URL
  try { url = new URL(value) } catch { throw invalid('Enter a valid absolute Chat Completions URL.') }
  if (url.username || url.password || !url.hostname || url.search || url.hash || url.port === '0') throw invalid('The chat endpoint must not contain credentials, query parameters, a fragment, or port zero.')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('Use HTTPS for a remote chat service. HTTP is allowed only for literal loopback addresses.')
  if (url.protocol === 'http:') {
    const authority = value.match(/^http:\/\/([^/]+)/i)?.[1] ?? ''
    const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
    // Never resolve localhost through DNS or a hosts-file override. Keep the
    // original port/path, and bind credentials to this normalized destination.
    const localhost = rawHost.toLowerCase() === 'localhost' && url.hostname === 'localhost'
    if (localhost) url.hostname = '127.0.0.1'
    const octets = rawHost.split('.')
    const ipv4 = octets.length === 4 && octets[0] === '127' && octets.every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255) && url.hostname === rawHost
    const ipv6 = rawHost.startsWith('[') && url.hostname === '[::1]'
    if (!localhost && !ipv4 && !ipv6) throw invalid('For a local service use localhost, a literal 127.0.0.1 address, or [::1]. Remote services require HTTPS.')
  }
  return url.href
}

export function validateCompatibleChatConfiguration(value: unknown): CompatibleChatConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid('Review the configured chat endpoint, model, and vision capability.')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(key => !['endpoint', 'model', 'vision'].includes(key))) throw invalid('Unsupported compatible-chat configuration field.')
  if (typeof data.model !== 'string' || !/^[A-Za-z0-9@/][A-Za-z0-9._:/@+\-]{0,127}$/.test(data.model)) throw invalid('Enter an explicit model ID of at most 128 characters for the configured chat service.')
  if (typeof data.vision !== 'boolean') throw invalid('Explicitly declare whether this endpoint and model support image input.')
  return { endpoint: normalizeCompatibleChatEndpoint(data.endpoint), model: data.model, vision: data.vision }
}

function imagePart(part: InputContent, configuration: CompatibleChatConfiguration, counts: { images: number; bytes: number }): unknown {
  if (part.type === 'input_text') return { type: 'text', text: part.text }
  if (part.type !== 'input_image' || !configuration.vision) throw new InferenceError('unsupported_capability', 'Image input is disabled for this chat service. Explicitly enable its tested vision capability or deselect the screenshots.')
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url)
  if (!match || match[2].length % 4 !== 0 || match[2].length > Math.ceil(COMPATIBLE_CHAT_LIMITS.imageBytes / 3) * 4) throw invalid('Use a selected PNG, JPEG, or WebP image of at most 8 MB.')
  const bytes = Buffer.from(match[2], 'base64')
  const signature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  counts.images++; counts.bytes += bytes.length
  if (!signature || bytes.length > COMPATIBLE_CHAT_LIMITS.imageBytes || counts.images > COMPATIBLE_CHAT_LIMITS.images || counts.bytes > COMPATIBLE_CHAT_LIMITS.totalImageBytes) throw invalid('Select at most four valid images, up to 8 MB each and 20 MB in total.')
  return { type: 'image_url', image_url: { url: part.image_url, detail: 'auto' } }
}

/** Converts the already-consented prompt without adding history, images, tools, or background sources. */
export function compatibleChatBody(prompt: CompiledPrompt, configuration: CompatibleChatConfiguration): string {
  if (!prompt || typeof prompt.instructions !== 'string' || prompt.instructions.length > COMPATIBLE_CHAT_LIMITS.instructionsCharacters || !Array.isArray(prompt.input) || !prompt.input.length || prompt.input.length + 1 > COMPATIBLE_CHAT_LIMITS.messages) throw invalid('The compiled chat request exceeds the configured input limits.')
  if (!Number.isSafeInteger(prompt.maxOutputTokens) || prompt.maxOutputTokens < 1 || prompt.maxOutputTokens > COMPATIBLE_CHAT_LIMITS.outputTokens) throw invalid('Choose a supported output-token limit.')
  let characters = prompt.instructions.length
  const counts = { images: 0, bytes: 0 }
  const messages = [{ role: 'system', content: prompt.instructions } as { role: string; content: unknown }, ...prompt.input.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role)) throw invalid('The compiled request contains an unsupported message role.')
    let content: unknown
    if (typeof message.content === 'string') { characters += message.content.length; content = message.content }
    else {
      if (!Array.isArray(message.content) || message.content.length > COMPATIBLE_CHAT_LIMITS.images + 1) throw invalid('The compiled request contains too many content parts.')
      content = message.content.map(part => {
        if (!part || (part.type !== 'input_text' && part.type !== 'input_image')) throw invalid('The compiled request contains an unsupported content part.')
        if (part.type === 'input_text') { if (typeof part.text !== 'string') throw invalid('The compiled request contains invalid text.'); characters += part.text.length }
        return imagePart(part, configuration, counts)
      })
    }
    return { role: message.role, content }
  })]
  if (characters > COMPATIBLE_CHAT_LIMITS.textCharacters) throw invalid('The selected text context exceeds 256,000 characters. Reduce the request context.')
  const body = JSON.stringify({ model: configuration.model, messages, stream: true, n: 1, max_tokens: prompt.maxOutputTokens })
  if (Buffer.byteLength(body, 'utf8') > COMPATIBLE_CHAT_LIMITS.requestBytes) throw invalid('The selected chat request exceeds 32 MB. Reduce the attachments or context.')
  return body
}

interface StreamEvent { event: string; data: string }
class EventDecoder {
  private buffer = ''
  private data: string[] = []
  private event = ''
  private size = 0
  push(chunk: string, final = false): StreamEvent[] {
    this.buffer += chunk
    const events: StreamEvent[] = []
    const line = (value: string) => {
      if (value.length > COMPATIBLE_CHAT_LIMITS.eventCharacters) throw malformed()
      if (!value) { if (this.data.length) events.push({ event: this.event, data: this.data.join('\n') }); this.data = []; this.event = ''; this.size = 0; return }
      if (value.startsWith(':')) return
      const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon)
      let text = colon < 0 ? '' : value.slice(colon + 1); if (text.startsWith(' ')) text = text.slice(1)
      if (field === 'data') { this.size += text.length + 1; if (this.size > COMPATIBLE_CHAT_LIMITS.eventCharacters) throw malformed(); this.data.push(text) }
      else if (field === 'event') { if (text.length > 100) throw malformed(); this.event = text }
    }
    while (true) {
      const index = this.buffer.search(/[\r\n]/)
      if (index < 0 || (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1)) break
      const width = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1
      line(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index + width)
    }
    if (this.buffer.length > COMPATIBLE_CHAT_LIMITS.eventCharacters) throw malformed()
    if (final) { if (this.buffer) line(this.buffer); this.buffer = ''; line('') }
    return events
  }
}

function providerError(status?: number, body?: unknown): InferenceError {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const detail = data.error && typeof data.error === 'object' && !Array.isArray(data.error) ? data.error as Record<string, unknown> : data
  const code = typeof detail.code === 'string' ? detail.code : typeof detail.type === 'string' ? detail.type : ''
  if (status === 401 || ['invalid_api_key', 'authentication_error'].includes(code)) return new InferenceError('invalid_credentials', 'The configured chat service rejected its separate credential. Replace that service credential in Settings.')
  if (status === 403 || code === 'permission_denied') return new InferenceError('permission_denied', 'The configured chat service denied access. Check that service credential and model permissions.')
  if (['insufficient_quota', 'quota_exceeded'].includes(code)) return new InferenceError('quota_exhausted', 'The configured chat service reports exhausted quota. Review its account limits, then retry explicitly.')
  if (status === 429 || code === 'rate_limit_exceeded') return new InferenceError('rate_limited', 'The configured chat service is rate limiting this request. Wait, then retry explicitly.')
  if (status === 404 || ['model_not_found', 'unsupported_model', 'unsupported_value'].includes(code)) return new InferenceError('unsupported_capability', 'The configured endpoint or model is unavailable. Check the exact Chat Completions URL and model ID.')
  if (status === 400 || status === 413 || code === 'invalid_request_error') return invalid('The configured chat service rejected the request. Check its declared input capabilities and limits.')
  if (status && status >= 500) return new InferenceError('offline', 'The configured chat service is unavailable. Partial output is retained; retry explicitly.')
  return malformed()
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled())
    if (signal.aborted) { void promise.catch(() => {}); reject(signal.reason ?? cancelled()); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
async function errorBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) return undefined
  const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0
  try {
    while (true) { const chunk = await abortable(reader.read(), signal); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 32_768) return undefined; text += decoder.decode(chunk.value, { stream: true }) }
    try { return JSON.parse(text + decoder.decode()) } catch { return undefined }
  } catch { if (signal.aborted) throw signal.reason; return undefined }
  finally { void reader.cancel().catch(() => {}) }
}

/** One explicitly configured request, without credential reuse, redirects, fallback, or automatic retry. */
export async function generateCompatibleAnswer(prompt: CompiledPrompt, value: CompatibleChatConfiguration, options: CompatibleChatOptions): Promise<AnswerResult> {
  if (options.signal.aborted) throw cancelled()
  const configuration = validateCompatibleChatConfiguration(value), body = compatibleChatBody(prompt, configuration)
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' })
  if (options.credential) {
    if (normalizeCompatibleChatEndpoint(options.credential.endpoint) !== configuration.endpoint) throw new InferenceError('invalid_credentials', 'This chat credential belongs to another endpoint. Enter a separate credential for the selected destination.')
    const key = options.credential.apiKey
    if (typeof key !== 'string' || !key || key.length > 1_024 || /[^\x21-\x7E]/.test(key)) throw new InferenceError('invalid_credentials', 'Enter a valid separate credential for the configured chat service.')
    headers.set('Authorization', `Bearer ${key}`)
  }
  const limits = { connectMs: 15_000, firstTokenMs: 30_000, inactivityMs: 20_000, totalMs: 120_000, ...options.deadlines }
  if (Object.values(limits).some(ms => !Number.isSafeInteger(ms) || ms < 1 || ms > 600_000)) throw invalid('Chat request deadlines must be positive whole milliseconds, up to ten minutes.')
  const controller = new AbortController(), timers = new Set<ReturnType<typeof setTimeout>>()
  let abortError: InferenceError | undefined
  const abort = (error: InferenceError) => { if (!controller.signal.aborted) { abortError = error; controller.abort(error) } }
  const callerAbort = () => abort(cancelled())
  options.signal.addEventListener('abort', callerAbort, { once: true }); if (options.signal.aborted) callerAbort()
  const timeout = (ms: number, text: string) => { const timer = setTimeout(() => abort(new InferenceError('timeout', text)), ms); timers.add(timer); return timer }
  const clear = (timer?: ReturnType<typeof setTimeout>) => { if (timer) { clearTimeout(timer); timers.delete(timer) } }
  timeout(limits.totalMs, 'The configured chat request exceeded its time limit. Partial output is retained; retry explicitly.')
  const connectionTimer = timeout(limits.connectMs, 'Connecting to the configured chat service timed out. Check its address and availability.')
  let firstTimer: ReturnType<typeof setTimeout> | undefined, inactivityTimer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, responseBody: ReadableStream<Uint8Array> | null | undefined
  let text = '', finished = false, done = false, id: string | undefined, model: string | undefined, events = 0, bytes = 0, inputTokens: number | undefined, outputTokens: number | undefined
  const emit = (delta: string) => {
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (text.length + delta.length > COMPATIBLE_CHAT_LIMITS.outputCharacters) throw malformed()
    text += delta; clear(firstTimer); clear(inactivityTimer)
    inactivityTimer = timeout(limits.inactivityMs, 'The configured chat service stopped sending answer text. Partial output is retained; retry explicitly.')
    options.onDelta(delta)
  }
  const count = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed()
    return value
  }
  const process = (event: StreamEvent) => {
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (++events > COMPATIBLE_CHAT_LIMITS.events || done) throw malformed()
    if (event.data.trim() === '[DONE]') { if (!finished) throw malformed(); done = true; return }
    let chunk: Record<string, unknown>
    try { chunk = JSON.parse(event.data) } catch { throw malformed() }
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw malformed()
    if (event.event === 'error' || chunk.error) throw providerError(undefined, chunk)
    if (chunk.object !== undefined && chunk.object !== 'chat.completion.chunk') throw malformed()
    for (const field of ['id', 'model'] as const) {
      const metadata = chunk[field]
      if (metadata === undefined) continue
      if (typeof metadata !== 'string' || !metadata || metadata.length > 128 || /[\u0000-\u001F\u007F]/.test(metadata)) throw malformed()
      if (field === 'id') { if (id !== undefined && id !== metadata) throw malformed(); id = metadata }
      else { if (model !== undefined && model !== metadata) throw malformed(); model = metadata }
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (typeof chunk.usage !== 'object' || Array.isArray(chunk.usage)) throw malformed()
      const usage = chunk.usage as Record<string, unknown>
      const input = count(usage.prompt_tokens), output = count(usage.completion_tokens)
      if ((inputTokens !== undefined && input !== undefined && inputTokens !== input) || (outputTokens !== undefined && output !== undefined && outputTokens !== output)) throw malformed()
      inputTokens = input ?? inputTokens; outputTokens = output ?? outputTokens
    }
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw malformed()
    if (!chunk.choices.length) { if (!chunk.usage) throw malformed(); return }
    const choice = chunk.choices[0]
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) throw malformed()
    if (finished) throw malformed()
    const delta = choice.delta as Record<string, unknown>
    if (delta.role !== undefined && delta.role !== 'assistant') throw malformed()
    if (delta.tool_calls !== undefined || delta.function_call !== undefined) throw new InferenceError('unsupported_capability', 'The configured chat service returned tool calls. This assistant accepts text and declared image input only; choose a compatible chat model.')
    if ((delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') || (delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== 'string')) throw malformed()
    const content = typeof delta.content === 'string' ? delta.content : '', refusal = typeof delta.refusal === 'string' ? delta.refusal : ''
    if (content && refusal) throw malformed()
    if (content || refusal) emit(content || refusal)
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (choice.finish_reason === 'length') throw new InferenceError('malformed_response', 'The configured chat service cut the answer short at its token limit. Partial output is retained; narrow the request and retry explicitly.')
      if (choice.finish_reason === 'content_filter') throw new InferenceError('permission_denied', 'The configured chat service stopped the answer under its content policy. Review the request before retrying.')
      if (choice.finish_reason !== 'stop') throw malformed()
      finished = true
    }
  }
  try {
    const response = await abortable((options.transport?.fetch ?? globalThis.fetch)(configuration.endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' }), controller.signal)
    responseBody = response.body
    clear(connectionTimer)
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw invalid('The configured chat endpoint redirected the request. Enter the service’s direct Chat Completions URL; redirects are blocked to protect credentials and context.')
    if (!response.ok) {
      const errorTimer = timeout(Math.min(limits.inactivityMs, 5_000), 'The configured chat service did not finish its error response. Check its availability before retrying.')
      const detail = await errorBody(response, controller.signal); clear(errorTimer); throw providerError(response.status, detail)
    }
    if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw malformed()
    firstTimer = timeout(limits.firstTokenMs, 'The configured chat service did not start an answer in time. Review its model and availability, then retry explicitly.')
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true }), parser = new EventDecoder()
    while (!done) {
      const chunk = await abortable(reader.read(), controller.signal)
      if (chunk.value) { bytes += chunk.value.byteLength; if (bytes > COMPATIBLE_CHAT_LIMITS.streamBytes) throw malformed() }
      let decoded: string
      try { decoded = decoder.decode(chunk.value, { stream: !chunk.done }) } catch { throw malformed() }
      for (const event of parser.push(decoded, chunk.done)) process(event)
      if (chunk.done) break
    }
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (!done || !finished || !text.trim()) throw malformed()
    return { text, model: model ?? configuration.model, inputTokens, outputTokens }
  } catch (error) {
    if (controller.signal.aborted) throw abortError ?? cancelled()
    if (error instanceof InferenceError) throw error
    if (error instanceof TypeError) throw new InferenceError('offline', 'Could not reach the configured chat service. Check its address and availability, then retry explicitly.')
    throw malformed()
  } finally {
    for (const timer of timers) clearTimeout(timer)
    options.signal.removeEventListener('abort', callerAbort)
    controller.abort()
    if (reader) void reader.cancel().catch(() => {})
    else void responseBody?.cancel().catch(() => {})
  }
}
