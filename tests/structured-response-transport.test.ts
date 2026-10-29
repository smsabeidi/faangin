import assert from 'node:assert/strict'
import test from 'node:test'
import { compatibleChatBody, generateCompatibleAnswer } from '../src/main/compatible-chat'
import { generateCompiledAnswer, InferenceError, type GenerationOptions } from '../src/main/inference'
import { compilePrompt, type CompiledPrompt } from '../src/main/prompts'
import { createInterviewResponseDecoder, STRUCTURED_INTERVIEW_FORMAT } from '../src/main/structured-interview-response'
import { DEFAULT_SETTINGS, type Session } from '../src/shared/types'

const FAKE_KEY = 'fixture-only-never-a-real-key'
const source: CompiledPrompt = {
  instructions: 'Assess the supplied finalized question and answer using the admitted interview reply protocol.',
  input: [{ role: 'user', content: [{ type: 'input_text', text: '{"liveReplyTarget":"question","transcript":[{"id":"question","text":"Why BFS?"}]}' }] }],
  maxOutputTokens: 2_048,
  sources: { transcriptIds: ['question'], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, provisional: false }
}
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\r\n\r\n`
const completed = (text: string, model = 'gpt-6-luna') => ({ type: 'response.completed', response: { status: 'completed', model, output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 11, output_tokens: 7 } } })
const stream = (text: string, model?: string): Response => new Response(event(completed(text, model)), { headers: { 'Content-Type': 'text/event-stream' } })
const options = (fetch: typeof globalThis.fetch, changes: Partial<GenerationOptions> = {}): GenerationOptions => ({ apiKey: FAKE_KEY, signal: new AbortController().signal, onDelta() {}, transport: { fetch }, ...changes })

test('structured interview requests send the strict ordered schema once without mutating sources or output budgets', async () => {
  const prompt: CompiledPrompt = { ...source, responseProtocol: 'json' }
  const snapshot = JSON.stringify(prompt)
  const answer = JSON.stringify({ disposition: 'assist', answer: 'BFS explores by distance.' })
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) for (const maxOutputTokens of [undefined, 600]) {
    let calls = 0
    const deltas: string[] = []
    const result = await generateCompiledAnswer(prompt, model, options((async (url, init) => {
      calls++
      assert.equal(String(url), 'https://api.openai.com/v1/responses')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, model)
      assert.equal(body.instructions, prompt.instructions)
      assert.deepEqual(body.input, prompt.input)
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      assert.equal(body.max_output_tokens, maxOutputTokens ?? prompt.maxOutputTokens)
      assert.deepEqual(body.text, { format: STRUCTURED_INTERVIEW_FORMAT })
      assert.equal(body.text.format.type, 'json_schema')
      assert.equal(body.text.format.name, 'interview_reply')
      assert.equal(body.text.format.strict, true)
      assert.equal(body.text.format.schema.additionalProperties, false)
      assert.deepEqual(Object.keys(body.text.format.schema.properties), ['disposition', 'answer'])
      assert.deepEqual(body.text.format.schema.required, ['disposition', 'answer'])
      assert.deepEqual(body.text.format.schema.properties.disposition, { type: 'string', enum: ['assist', 'wait'] })
      assert.deepEqual(body.text.format.schema.properties.answer, { type: 'string' })
      assert.equal(body.response_format, undefined)
      return stream(answer, model)
    }) as typeof fetch, { maxOutputTokens, onDelta(delta) { deltas.push(delta) } }))
    assert.equal(calls, 1)
    assert.equal(result.text, answer)
    assert.equal(deltas.join(''), answer)
    assert.equal(result.model, model)
    assert.equal(result.inputTokens, 11)
    assert.equal(result.outputTokens, 7)
    assert.equal(JSON.stringify(prompt), snapshot)
  }
})

test('legacy framed prompts and ordinary supported-model requests do not acquire a JSON schema', async () => {
  for (const model of ['gpt-4.1-mini', 'custom-fast-model', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']) {
    let calls = 0
    const answer = 'ASSIST\nBFS explores by distance.'
    const result = await generateCompiledAnswer(source, model, options((async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.text, undefined)
      assert.equal(body.response_format, undefined)
      assert.equal(body.store, false)
      assert.equal(body.max_output_tokens, source.maxOutputTokens)
      return stream(answer, model)
    }) as typeof fetch))
    assert.equal(result.text, answer)
    assert.equal(calls, 1)
  }
})

test('an unsupported structured model and invalid caps reject before dispatch without a fallback', async () => {
  const prompt: CompiledPrompt = { ...source, responseProtocol: 'json' }
  let calls = 0
  const configuration = options((async () => { calls++; return stream('should never be requested') }) as typeof fetch)
  for (const model of ['gpt-4.1-mini', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna-2026-10-28', 'gpt-6.1-sol-custom', 'custom-fast-model']) {
    await assert.rejects(generateCompiledAnswer(prompt, model, configuration), error => error instanceof InferenceError && error.code === 'unsupported_capability')
  }
  await assert.rejects(generateCompiledAnswer(prompt, 'gpt-6-luna', { ...configuration, maxOutputTokens: prompt.maxOutputTokens + 1 }), error => error instanceof InferenceError && error.code === 'invalid_input')
  const cancellation = new AbortController(); cancellation.abort()
  await assert.rejects(generateCompiledAnswer(prompt, 'gpt-6-luna', { ...configuration, signal: cancellation.signal }), error => error instanceof InferenceError && error.code === 'cancelled')
  assert.equal(calls, 0)
})

test('structured provider rejection remains one safe failure without retrying a free-form request', async () => {
  let calls = 0
  await assert.rejects(generateCompiledAnswer({ ...source, responseProtocol: 'json' }, 'gpt-6-luna', options((async (_url, init) => {
    calls++
    assert.deepEqual(JSON.parse(String(init?.body)).text, { format: STRUCTURED_INTERVIEW_FORMAT })
    return new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'PRIVATE_SCHEMA_ERROR' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)), error => error instanceof InferenceError && error.code === 'invalid_input' && !error.message.includes('PRIVATE_SCHEMA_ERROR'))
  assert.equal(calls, 1)
})

test('structured answer text is decoded from deltas before the provider completion event', async () => {
  const prompt: CompiledPrompt = { ...source, responseProtocol: 'json' }
  const decoder = createInterviewResponseDecoder(prompt.responseProtocol)
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let firstBody!: () => void
  const bodyArrived = new Promise<void>(resolve => { firstBody = resolve })
  let calls = 0, settled = false, visible = ''
  const partial = '{"disposition":"assist","answer":"BFS explores by distance.'
  const ending = ' Track visited nodes."}'
  const pending = generateCompiledAnswer(prompt, 'gpt-6-luna', options((async () => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(Buffer.from(event({ type: 'response.output_text.delta', delta: partial }))) } }), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch, { deadlines: { totalMs: 2_000 }, onDelta(delta) { visible += decoder.push(delta); if (visible) firstBody() } })).finally(() => { settled = true })
  try {
    await Promise.race([bodyArrived, pending])
    assert.equal(settled, false)
    assert.equal(visible, 'BFS explores by distance.')
    assert.equal(decoder.disposition, 'assist')
    assert.equal(calls, 1)
    controller.enqueue(Buffer.from(event({ type: 'response.output_text.delta', delta: ending })))
    controller.enqueue(Buffer.from(event(completed(partial + ending))))
    controller.close()
    const result = await pending
    assert.equal(result.text, partial + ending)
    assert.equal(visible, 'BFS explores by distance. Track visited nodes.')
    assert.equal(decoder.finish(), 'assist')
  } finally { controller?.error(new Error('Local structured stream fixture closed.')); await pending.catch(() => {}) }
})

test('a structured wait reaches completion without emitting metadata or an answer body', async () => {
  const decoder = createInterviewResponseDecoder('json')
  const answer = JSON.stringify({ disposition: 'wait', answer: '' })
  let calls = 0, visible = ''
  const result = await generateCompiledAnswer({ ...source, responseProtocol: 'json' }, 'gpt-6.1-sol', options((async () => {
    calls++
    const deltas = [...answer].map(delta => event({ type: 'response.output_text.delta', delta })).join('')
    return new Response(deltas + event(completed(answer, 'gpt-6.1-sol')), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch, { onDelta(delta) { visible += decoder.push(delta) } }))
  assert.equal(calls, 1)
  assert.equal(result.text, answer)
  assert.equal(visible, '')
  assert.equal(decoder.finish(), 'wait')
})

test('automatic compatible requests preserve framed instructions and the Chat Completions body', async () => {
  const session: Session = { id: 'compatible-interview', title: 'Interview', mode: 'interview', status: 'recording', createdAt: 0, updatedAt: 1, notes: '', transcript: [{ id: 'question', sessionId: 'compatible-interview', channel: 'system', text: 'Why use BFS?', timestamp: 1 }], answers: [], attachments: [], contextEpoch: 0 }
  const configuration = { endpoint: 'http://127.0.0.1:12345/v1/chat/completions', model: 'local/model:latest', vision: false }
  const settings = { ...DEFAULT_SETTINGS, chatProvider: 'compatible' as const, compatibleChatEndpoint: configuration.endpoint, compatibleChatModel: configuration.model }
  const prompt = compilePrompt({ action: 'reply', settings, session, attachments: [], replyTarget: 'question', automatic: { source: 'system', channels: ['system'] } })
  assert.equal(prompt.responseProtocol, undefined)
  assert.match(prompt.instructions, /ASSIST followed immediately by the newline character/)
  const expected = JSON.parse(compatibleChatBody(prompt, configuration))
  assert.equal(expected.text, undefined)
  assert.equal(expected.response_format, undefined)
  assert.equal(expected.max_tokens, prompt.maxOutputTokens)
  let calls = 0
  const answer = 'ASSIST\nBFS explores by distance.'
  const result = await generateCompatibleAnswer(prompt, configuration, {
    signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async (_url, init) => {
      calls++
      assert.deepEqual(JSON.parse(String(init?.body)), expected)
      const id = 'compatible-fixture'
      return new Response(event({ id, model: configuration.model, choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] }) + event({ id, model: configuration.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch }
  })
  assert.equal(calls, 1)
  assert.equal(result.text, answer)
})
