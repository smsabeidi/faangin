import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { generateAnswer, generateCompiledAnswer, verifyKey, createLiveTranscriber, InferenceError, type InferenceTransport } from '../src/main/inference'
import { compilePrompt } from '../src/main/prompts'
import { DEFAULT_SETTINGS, type Session } from '../src/shared/types'

const FAKE_KEY = 'fixture-key-never-a-real-secret'
const current: Session = { id: 'session-1', title: 'Fixture', mode: 'meeting', status: 'idle', createdAt: 1, updatedAt: 2, notes: '', transcript: [], answers: [], attachments: [], contextEpoch: 0 }
const input = { action: 'ask' as const, prompt: 'Describe the next step', settings: DEFAULT_SETTINGS, session: current, attachments: [] }
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\r\n\r\n`
const completed = (text: string) => ({ type: 'response.completed', response: { status: 'completed', model: 'gpt-4.1-mini', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 123, output_tokens: 8 } } })
function mockStream(chunks: Uint8Array[], onCancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close() },
    cancel() { onCancel?.() }
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}
async function httpFixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  return { transport: { fetch: ((target, init) => fetch(`${url}${new URL(String(target)).pathname}`, init)) as typeof fetch }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
async function socketFixture(onEvent?: (event: Record<string, unknown>, socket: WebSocket) => void, autoReady = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  const events: Record<string, unknown>[] = []
  let client: WebSocket | undefined
  let resolveConnected!: (socket: WebSocket) => void
  const connected = new Promise<WebSocket>(resolve => { resolveConnected = resolve })
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`)
    resolveConnected(socket)
    socket.on('message', raw => {
      const value = JSON.parse(raw.toString()); events.push(value)
      if (autoReady && value.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated', session: value.session }))
      onEvent?.(value, socket)
    })
  })
  const transport: InferenceTransport = { createWebSocket: (url, config) => { assert.equal(url, 'wss://api.openai.com/v1/realtime?intent=transcription'); client = new WebSocket(`ws://127.0.0.1:${address.port}`, config); return client } }
  return { events, connected, transport, get client() { return client! }, close: async () => { for (const socket of server.clients) socket.terminate(); client?.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
function liveOptions(transport: InferenceTransport, changes: Partial<Parameters<typeof createLiveTranscriber>[0]> = {}) {
  return { apiKey: FAKE_KEY, model: 'gpt-live-transcribe', language: 'en', channel: 'microphone' as const, onPartial() {}, onFinal() {}, onError() {}, transport, deadlines: { connectMs: 1_000, finalizeMs: 100, closeMs: 100 }, ...changes }
}
const nextTick = () => new Promise<void>(resolve => setTimeout(resolve, 15))

test('small connection probe caps output before dispatch and invalid caps make no request', async () => {
  let calls = 0
  const options = { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async (_url: unknown, init: RequestInit | undefined) => {
    calls++; assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 16)
    return mockStream([Buffer.from(event(completed('OK')))])
  }) as typeof fetch } }
  assert.equal((await generateAnswer(input, { ...options, maxOutputTokens: 16 })).text, 'OK')
  for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, 100_000]) await assert.rejects(generateAnswer(input, { ...options, maxOutputTokens }), (error: unknown) => error instanceof InferenceError && error.code === 'invalid_input')
  assert.equal(calls, 1)
})

test('admitted OpenAI requests reuse the exact compiled context and never mutate its output budget', async () => {
  const request = { ...input, prompt: 'ADMITTED_REQUEST', settings: { ...DEFAULT_SETTINGS } }
  const compiled = compilePrompt(request), snapshot = JSON.stringify(compiled)
  request.prompt = 'LATER_UNADMITTED_REQUEST'; request.settings.profile = 'LATER_UNADMITTED_PROFILE'
  let calls = 0
  const result = await generateCompiledAnswer(compiled, DEFAULT_SETTINGS.fastModel, {
    apiKey: FAKE_KEY, signal: new AbortController().signal, maxOutputTokens: 16, onDelta() {},
    transport: { fetch: (async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.instructions, compiled.instructions); assert.deepEqual(body.input, compiled.input)
      assert(JSON.stringify(body.input).includes('ADMITTED_REQUEST')); assert(!JSON.stringify(body).includes('LATER_UNADMITTED'))
      assert.equal(body.max_output_tokens, 16); assert.equal(body.stream, true); assert.equal(body.store, false)
      return mockStream([Buffer.from(event(completed('OK')))])
    }) as typeof fetch }
  })
  assert.equal(calls, 1); assert.equal(result.text, 'OK'); assert.equal(JSON.stringify(compiled), snapshot)
})

test('compiled requests retain image-model checks, output caps and pre-dispatch cancellation', async () => {
  const image = { id: 'selected-image', sessionId: current.id, name: 'problem.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1, createdAt: 1 }
  const compiled = compilePrompt({ ...input, attachments: [image] })
  let calls = 0
  const options = { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async () => { calls++; return mockStream([Buffer.from(event(completed('OK')))]) }) as typeof fetch } }
  await assert.rejects(generateCompiledAnswer(compiled, 'text-only-fixture', options), (error: unknown) => error instanceof InferenceError && error.code === 'unsupported_capability')
  await assert.rejects(generateCompiledAnswer(compiled, DEFAULT_SETTINGS.fastModel, { ...options, maxOutputTokens: compiled.maxOutputTokens + 1 }), (error: unknown) => error instanceof InferenceError && error.code === 'invalid_input')
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(generateCompiledAnswer(compiled, DEFAULT_SETTINGS.fastModel, { ...options, signal: cancelled.signal }), (error: unknown) => error instanceof InferenceError && error.code === 'cancelled')
  assert.equal(calls, 0)
})

test('Stop finalizes accepted speech once, including quiet speech, while silence is not committed', async () => {
  for (const amplitude of [0, 200, 1_500]) {
    const fixture = await socketFixture((value, socket) => {
      if (value.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'last-question' }))
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-question', transcript: 'Why BFS instead of DFS?' }))
      }
    }); const incomplete: string[] = [], finals: string[] = []
    try {
      const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onIncomplete: message => incomplete.push(message), onFinal: (_id, text) => finals.push(text) }))
      const frame = Buffer.alloc(4_800)
      for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(amplitude, i)
      transcriber.write(frame)
      const stopping = transcriber.stop()
      assert.strictEqual(transcriber.stop(), stopping)
      transcriber.write(frame); transcriber.commit()
      await stopping
      assert.equal(incomplete.length, 0)
      assert.deepEqual(finals, amplitude ? ['Why BFS instead of DFS?'] : [])
      assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.commit').length, amplitude ? 1 : 0)
      assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.append').length, 1)
    } finally { await fixture.close() }
  }
})

test('manual reply flush waits for the current question and keeps listening for later questions', async () => {
  let count = 0
  const fixture = await socketFixture((value, socket) => {
    if (value.type !== 'input_audio_buffer.commit') return
    const item_id = `question-${++count}`
    socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id }))
    setTimeout(() => socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: `Final ${item_id}` })), 20)
  })
  const finals: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onFinal: (_id, text) => finals.push(text) }))
    const frame = Buffer.alloc(4_800)
    for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(200, i)
    transcriber.write(frame)
    const flushing = transcriber.flush()
    assert.deepEqual(finals, [])
    await flushing
    assert.deepEqual(finals, ['Final question-1'])
    transcriber.write(frame)
    await transcriber.flush()
    assert.deepEqual(finals, ['Final question-1', 'Final question-2'])
    await transcriber.stop()
    assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.commit').length, 2)
  } finally { await fixture.close() }
})

test('manual reply flush has a bounded timeout and stop cancels a pending preparation', async () => {
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'pending' }))
  })
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { deadlines: { connectMs: 1_000, flushMs: 20, finalizeMs: 20, closeMs: 100 } }))
    transcriber.write(new Uint8Array(4_800)); transcriber.commit()
    await assert.rejects(transcriber.flush(), (error: unknown) => error instanceof InferenceError && error.code === 'timeout')
    const flushing = assert.rejects(transcriber.flush(), (error: unknown) => error instanceof InferenceError && error.code === 'cancelled')
    await transcriber.stop(); await flushing
  } finally { await fixture.close() }
})

test('provider error marks unfinished speech before a synchronous teardown callback', async () => {
  const fixture = await socketFixture((value, socket) => { if (value.type === 'input_audio_buffer.append') socket.send(JSON.stringify({ type: 'error', error: { code: 'insufficient_quota' } })) })
  const order: string[] = []; let cleanup: Promise<void> | undefined
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onIncomplete() { order.push('incomplete') }, onError() { order.push('error'); cleanup = transcriber.stop() } }))
    const frame = Buffer.alloc(4_800); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1_500, i)
    transcriber.write(frame); await nextTick(); await cleanup
    assert.deepEqual(order, ['incomplete', 'error'])
    assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.commit').length, 0)
  } finally { await fixture.close() }
})

test('unexpected peer close marks admitted speech incomplete before channel teardown', async () => {
  const fixture = await socketFixture((value, socket) => { if (value.type === 'input_audio_buffer.append') socket.terminate() })
  const order: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onIncomplete() { order.push('incomplete') }, onError() { order.push('error') } }))
    const frame = Buffer.alloc(4_800); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1_500, i)
    transcriber.write(frame); await nextTick(); await transcriber.stop()
    assert.deepEqual(order, ['incomplete', 'error'])
  } finally { await fixture.close() }
})

test('Responses parses every UTF-8 byte and CRLF split, multiline SSE, metadata and terminal usage', async () => {
  let body: Record<string, unknown> = {}; let requested = ''
  const legacyInput = { ...input, settings: { ...input.settings, fastModel: 'gpt-4.1-mini' } }
  const stream = ': comment\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"Hello 🌎"}\r\n\r\n' + event({ type: 'response.output_text.delta', delta: '!' }) + event(completed('Hello 🌎!'))
  const bytes = Buffer.from(stream)
  const deltas: string[] = []
  const result = await generateAnswer(legacyInput, { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta: delta => deltas.push(delta), transport: { fetch: (async (url, init) => {
    requested = String(url); body = JSON.parse(String(init?.body)); assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${FAKE_KEY}`)
    return mockStream(Array.from(bytes, value => Uint8Array.of(value)))
  }) as typeof fetch } })
  assert.equal(requested, 'https://api.openai.com/v1/responses')
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, legacyInput.settings.fastModel)
  assert.deepEqual(deltas, ['Hello 🌎', '!'])
  assert.deepEqual(result, { text: 'Hello 🌎!', model: 'gpt-4.1-mini', inputTokens: 123, outputTokens: 8 })
})

test('real local HTTP cancellation closes transport and drops late deltas', async () => {
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const fixture = await httpFixture((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(event({ type: 'response.output_text.delta', delta: 'partial' }))
    response.on('close', resolveClosed)
  })
  const controller = new AbortController(); const deltas: string[] = []
  try {
    await assert.rejects(generateAnswer(input, { apiKey: FAKE_KEY, signal: controller.signal, transport: fixture.transport, onDelta: delta => { deltas.push(delta); controller.abort() } }), (error: unknown) => error instanceof InferenceError && error.code === 'cancelled')
    await closed
    assert.deepEqual(deltas, ['partial'])
  } finally { await fixture.close() }
})

test('first-token timeout aborts the HTTP request instead of leaving it running', async () => {
  let observedAbort = false
  const transport: InferenceTransport = { fetch: (async (_url, init) => {
    init?.signal?.addEventListener('abort', () => { observedAbort = true })
    return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch }
  await assert.rejects(generateAnswer(input, { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport, deadlines: { firstTokenMs: 15 } }), (error: unknown) => error instanceof InferenceError && error.code === 'timeout')
  assert(observedAbort)
})

test('credential/quota/provider errors are safe, classified and never automatically retried', async () => {
  for (const [status, code, expected] of [[401, 'invalid_api_key', 'invalid_credentials'], [429, 'insufficient_quota', 'quota_exhausted'], [429, 'rate_limit_exceeded', 'rate_limited'], [404, 'model_not_found', 'unsupported_capability'], [503, 'server_error', 'offline']] as const) {
    let calls = 0
    await assert.rejects(generateAnswer(input, { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async () => { calls++; return Response.json({ error: { code, message: `${FAKE_KEY} PRIVATE_TRANSCRIPT` } }, { status }) }) as typeof fetch } }), (error: unknown) => {
      assert(error instanceof InferenceError); assert.equal(error.code, expected); assert(!error.message.includes(FAKE_KEY)); assert(!error.message.includes('PRIVATE_TRANSCRIPT')); return true
    })
    assert.equal(calls, 1)
  }
})

test('missing context, unselected problem image, pre-abort and invalid vision model cause no request', async () => {
  let calls = 0
  const options = { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async () => { calls++; throw new Error('should not request') }) as typeof fetch } }
  await assert.rejects(generateAnswer({ ...input, action: 'recap', prompt: '' }, options), (error: unknown) => error instanceof InferenceError && error.code === 'missing_context')
  await assert.rejects(generateAnswer({ ...input, action: 'solve', prompt: '' }, options), /problem screenshot/)
  await assert.rejects(generateAnswer(input, { ...options, signal: AbortSignal.abort() }), (error: unknown) => error instanceof InferenceError && error.code === 'cancelled')
  const attachment = { id: 'image', sessionId: current.id, name: 'problem.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1, createdAt: 1 }
  await assert.rejects(generateAnswer({ ...input, settings: { ...DEFAULT_SETTINGS, fastModel: 'unverified-model' }, attachments: [attachment] }, options), (error: unknown) => error instanceof InferenceError && error.code === 'unsupported_capability')
  assert.equal(calls, 0)
})

test('malformed, incomplete, missing-text and oversized streams fail with partial output retained', async () => {
  for (const stream of [event({ type: 'response.output_text.delta', delta: 'partial' }), 'data: {invalid}\n\n', event(completed('')), event({ type: 'response.output_text.delta', delta: 'x'.repeat(140_000) })]) {
    const deltas: string[] = []
    await assert.rejects(generateAnswer(input, { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta: delta => deltas.push(delta), transport: { fetch: (async () => mockStream([Buffer.from(stream)])) as typeof fetch } }), (error: unknown) => error instanceof InferenceError && error.code === 'malformed_response')
    if (stream.includes('partial')) assert.deepEqual(deltas, ['partial'])
  }
})

test('stream semantic error messages are redacted and body is cancelled', async () => {
  let cancelledBody = false
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(event({ type: 'error', code: 'insufficient_quota', message: FAKE_KEY }))) }, cancel() { cancelledBody = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
  await assert.rejects(generateAnswer(input, { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async () => response) as typeof fetch } }), (error: unknown) => error instanceof InferenceError && error.code === 'quota_exhausted' && !error.message.includes(FAKE_KEY))
  assert(cancelledBody)
})

test('connection verification checks model visibility with GET and makes no generation request', async () => {
  let path = ''; let method: string | undefined
  await verifyKey(FAKE_KEY, 'gpt-4.1-mini', { fetch: (async (url, init) => { path = String(url); method = init?.method; return Response.json({ id: 'gpt-4.1-mini' }) }) as typeof fetch })
  assert.equal(path, 'https://api.openai.com/v1/models/gpt-4.1-mini'); assert.equal(method, undefined)
})

test('Realtime uses current transcription schema, reconciles partials, and orders/deduplicates finals', async () => {
  let committed = 0
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `item-${++committed}`, previous_item_id: committed > 1 ? `item-${committed - 1}` : null }))
  })
  const partials: Array<[string, string]> = []; const finals: Array<[string, string]> = []; const errors: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onPartial: (id, text) => partials.push([id, text]), onFinal: (id, text) => finals.push([id, text]), onError: error => errors.push(error) }))
    const socket = await fixture.connected
    const sessionUpdate = fixture.events.find(value => value.type === 'session.update')!
    const session = sessionUpdate.session as { audio: { input: Record<string, unknown> } }
    assert.deepEqual(session.audio.input.format, { type: 'audio/pcm', rate: 24_000 })
    assert.deepEqual(session.audio.input.transcription, { model: 'gpt-live-transcribe', languages: ['en'], delay: 'low' })
    assert.equal(session.audio.input.turn_detection, null)
    transcriber.write(new Uint8Array(4_800)); transcriber.commit(); transcriber.write(new Uint8Array(4_800)); transcriber.commit()
    await nextTick()
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'Hello ' }))
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'world' }))
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-2', transcript: 'Second turn' }))
    await nextTick(); assert.deepEqual(finals, [])
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'Hello world.' }))
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'Duplicate must not publish' }))
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'late delta' }))
    await nextTick()
    assert.deepEqual(partials, [['item-1', 'Hello '], ['item-1', 'Hello world']])
    assert.deepEqual(finals, [['item-1', 'Hello world.'], ['item-2', 'Second turn']]); assert.deepEqual(errors, [])
    await transcriber.stop()
  } finally { await fixture.close() }
})

test('an empty speech final retires provisional text once and does not block the following turn', async () => {
  let committed = 0
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `item-${++committed}` }))
  })
  const partials = new Map<string, string>()
  const finals: Array<[string, string]> = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, {
      onPartial: (id, text) => partials.set(id, text),
      onFinal: (id, text) => { partials.delete(id); finals.push([id, text]) }
    }))
    const socket = await fixture.connected
    transcriber.write(new Uint8Array(4800)); transcriber.commit()
    transcriber.write(new Uint8Array(4800)); transcriber.commit()
    await nextTick()
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'Unconfirmed speech' }))
    await nextTick(); assert.equal(partials.get('item-1'), 'Unconfirmed speech')
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-2', transcript: 'Actual requirement' }))
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: '' }))
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'Late duplicate' }))
    await nextTick()
    assert.deepEqual([...partials], [])
    assert.deepEqual(finals, [['item-1', ''], ['item-2', 'Actual requirement']])
    await transcriber.stop()
  } finally { await fixture.close() }
})

test('provider finals retain utterance boundaries through reordered completion and a blank endpoint tail', async () => {
  let committed = 0
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `item-${++committed}` }))
  })
  const finals: Array<[string, string, boolean]> = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onFinal: (id, text, _at, complete) => finals.push([id, text, complete]) }))
    const socket = await fixture.connected
    transcriber.write(new Uint8Array(4_800)); transcriber.commit(false)
    transcriber.write(new Uint8Array(4_800)); transcriber.commit(true)
    await nextTick()
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-2', transcript: '' }))
    await nextTick(); assert.deepEqual(finals, [])
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'Do not remove the foo_v2 identifier or the 10 ms bound.' }))
    await nextTick()
    assert.deepEqual(finals, [['item-1', 'Do not remove the foo_v2 identifier or the 10 ms bound.', false], ['item-2', '', true]])
    await transcriber.stop()
  } finally { await fixture.close() }
})

test('an exact-boundary or silent endpoint completes its chunk without an empty provider commit or repeated transcript', async () => {
  for (const [timing, tailBytes] of [['pending', 0], ['published', 0], ['published', 960]] as const) {
    let committed = 0
    const fixture = await socketFixture((value, socket) => {
      if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `item-${++committed}` }))
    })
    const finals: boolean[] = [], endpoints: string[] = []
    try {
      const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, {
        onFinal: (_id, _text, _at, complete) => finals.push(complete), onUtteranceComplete: id => endpoints.push(id)
      }))
      const socket = await fixture.connected
      transcriber.write(new Uint8Array(4_800)); transcriber.commit(false); await nextTick()
      const finalize = () => socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'The answer is O(V + E).' }))
      if (timing === 'published') { finalize(); await nextTick() }
      if (tailBytes) transcriber.write(new Uint8Array(tailBytes))
      transcriber.commit(true); transcriber.commit(true)
      if (timing === 'pending') { finalize(); await nextTick() }
      await nextTick()
      assert.deepEqual(finals, [timing === 'pending'])
      assert.deepEqual(endpoints, timing === 'published' ? ['item-1'] : [])
      assert.equal(committed, 1, 'endpoint metadata must never send an empty or subminimum provider commit')
      await transcriber.stop()
    } finally { await fixture.close() }
  }
})

test('a subminimum audible correction cannot release a held finalized chunk', async () => {
  let committed = 0
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `item-${++committed}` }))
  })
  const endpoints: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onUtteranceComplete: id => endpoints.push(id) }))
    const socket = await fixture.connected
    transcriber.write(new Uint8Array(4_800)); transcriber.commit(false); await nextTick()
    socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'The value is zero.' }))
    await nextTick()
    const correction = new Int16Array(480).fill(4_000)
    transcriber.write(new Uint8Array(correction.buffer)); transcriber.commit(true)
    await nextTick(); assert.deepEqual(endpoints, []); assert.equal(committed, 1)
    await transcriber.stop()
  } finally { await fixture.close() }
})

test('Realtime stop blocks new dispatch, drains already committed final and closes socket', async () => {
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item-1' }))
      setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: 'Admitted final' })) }, 30)
    }
  })
  const finals: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onFinal: (_id, text) => finals.push(text) }))
    transcriber.write(new Uint8Array(4_800)); transcriber.commit()
    const stopping = transcriber.stop(); assert.strictEqual(transcriber.stop(), stopping)
    transcriber.write(new Uint8Array(4_800)); transcriber.commit()
    await stopping
    assert.deepEqual(finals, ['Admitted final'])
    assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.append').length, 1)
    assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.commit').length, 1)
    assert.equal(fixture.client.readyState, WebSocket.CLOSED)
  } finally { await fixture.close() }
})

test('Realtime quota errors terminate channel without replay or repeated dispatch', async () => {
  const fixture = await socketFixture(); const errors: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onError: error => errors.push(error) }))
    const socket = await fixture.connected
    socket.send(JSON.stringify({ type: 'error', error: { code: 'insufficient_quota', message: `${FAKE_KEY} PRIVATE_AUDIO_TEXT` } }))
    await nextTick()
    for (let i = 0; i < 5; i++) { transcriber.write(new Uint8Array(4_800)); transcriber.commit() }
    await transcriber.stop()
    assert.equal(errors.length, 1); assert.match(errors[0], /quota is exhausted/)
    assert(!errors[0].includes(FAKE_KEY)); assert(!errors[0].includes('PRIVATE_AUDIO_TEXT'))
    assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.append').length, 0)
  } finally { await fixture.close() }
})

test('Realtime overflow stops socket before accepting more than the bounded send credit', async () => {
  const fixture = await socketFixture(); const errors: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { onError: error => errors.push(error) }))
    Object.defineProperty(fixture.client, 'bufferedAmount', { get: () => 1_440_000 })
    transcriber.write(new Uint8Array(960)); transcriber.write(new Uint8Array(960))
    await nextTick(); await transcriber.stop()
    assert.equal(errors.length, 1); assert.match(errors[0], /cannot keep up/)
    assert.equal(fixture.events.filter(value => value.type === 'input_audio_buffer.append').length, 0)
  } finally { await fixture.close() }
})

test('Realtime finalization timeout is bounded and reports incompleteness', async () => {
  const fixture = await socketFixture((value, socket) => { if (value.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'never-final' })) })
  const errors: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { deadlines: { connectMs: 1_000, finalizeMs: 25, closeMs: 100 }, onError: error => errors.push(error) }))
    transcriber.write(new Uint8Array(4_800)); transcriber.commit()
    const before = Date.now(); await transcriber.stop()
    assert(Date.now() - before < 500); assert.equal(errors.length, 1); assert.match(errors[0], /incomplete/)
  } finally { await fixture.close() }
})

test('Realtime discards finals arriving during close after the finalization deadline', async () => {
  const fixture = await socketFixture((value, socket) => {
    if (value.type === 'input_audio_buffer.commit') {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'late-final' }))
      setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-final', transcript: 'Past the cutoff' })) }, 40)
    }
  })
  const finals: string[] = []
  try {
    const transcriber = await createLiveTranscriber(liveOptions(fixture.transport, { deadlines: { connectMs: 1_000, finalizeMs: 15, closeMs: 70 }, onFinal: (_id, text) => finals.push(text) }))
    // Simulate a peer that does not acknowledge the close handshake promptly.
    fixture.client.close = () => {}
    transcriber.write(new Uint8Array(4_800)); transcriber.commit()
    await transcriber.stop()
    assert.deepEqual(finals, [])
  } finally { await fixture.close() }
})

test('invalid UTF-8 in a provider stream is classified as malformed rather than offline', async () => {
  await assert.rejects(generateAnswer(input, { apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async () => mockStream([Uint8Array.of(255)])) as typeof fetch } }), (error: unknown) => error instanceof InferenceError && error.code === 'malformed_response')
})

test('Realtime admission cancellation terminates a pending connection before readiness', async () => {
  const fixture = await socketFixture(undefined, false)
  const controller = new AbortController()
  try {
    const pending = createLiveTranscriber(liveOptions(fixture.transport, { signal: controller.signal }))
    await fixture.connected
    controller.abort()
    await assert.rejects(pending, (error: unknown) => error instanceof InferenceError && error.code === 'cancelled')
    await nextTick()
    assert.equal(fixture.client.readyState, WebSocket.CLOSED)
  } finally { await fixture.close() }
})
