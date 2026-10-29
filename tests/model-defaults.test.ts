import assert from 'node:assert/strict'
import test from 'node:test'
import { generateAnswer } from '../src/main/inference'
import { answerReasoning, supportsImageInput } from '../src/main/model-capabilities'
import { Repository } from '../src/main/repository'
import { DEFAULT_SETTINGS, type Session } from '../src/shared/types'

test('new workspaces use the evaluated Fast default with image support and immediate reasoning', () => {
  const repo = new Repository(':memory:')
  try {
    assert.equal(repo.settings().fastModel, 'gpt-6-luna')
    assert.equal(supportsImageInput(repo.settings().fastModel), true)
    assert.deepEqual(answerReasoning(repo.settings().fastModel), { reasoning: { effort: 'none' } })
    assert.equal(repo.settings().smartModel, 'gpt-6.1-sol')
    assert.equal(supportsImageInput(repo.settings().smartModel), true)
    assert.deepEqual(answerReasoning(repo.settings().smartModel), { reasoning: { effort: 'low' } })
    assert.equal(repo.settings().smartMode, false)
  } finally { repo.close() }
})

test('reading settings preserves saved legacy and custom models and compatible-provider choices', () => {
  for (const fastModel of ['gpt-4.1-mini', 'custom-fast-model']) {
    const repo = new Repository(':memory:')
    try {
      const saved = { ...DEFAULT_SETTINGS, fastModel, smartModel: 'custom-smart-model', smartMode: true, chatProvider: 'compatible' as const, compatibleChatEndpoint: 'http://127.0.0.1:11434/v1', compatibleChatModel: 'local-fast', compatibleChatSmartModel: 'local-smart' }
      repo.saveSettings(saved)
      assert.deepEqual(repo.settings(), saved)
    } finally { repo.close() }
  }
})

test('per-request Fast and Smart selection honors defaults, saved choices and explicit overrides without fallback', async () => {
  const session: Session = { id: 'routing', title: 'Synthetic routing', mode: 'interview', status: 'idle', notes: '', createdAt: 0, updatedAt: 0, contextEpoch: 0, transcript: [], answers: [], attachments: [] }
  for (const choice of [
    { settings: DEFAULT_SETTINGS, smart: undefined, expected: DEFAULT_SETTINGS.fastModel },
    { settings: { ...DEFAULT_SETTINGS, fastModel: 'saved-fast', smartModel: 'saved-smart' }, smart: true, expected: 'saved-smart' },
    { settings: { ...DEFAULT_SETTINGS, fastModel: 'saved-fast', smartModel: 'saved-smart', smartMode: true }, smart: undefined, expected: 'saved-smart' },
    { settings: { ...DEFAULT_SETTINGS, fastModel: 'saved-fast', smartModel: 'saved-smart', smartMode: true }, smart: false, expected: 'saved-fast' },
  ]) {
    let requests = 0
    const result = await generateAnswer({ action: 'ask', prompt: 'Explain a hash collision.', settings: choice.settings, smart: choice.smart, session, attachments: [] }, {
      apiKey: 'fixture-only-never-a-real-key', signal: new AbortController().signal, onDelta() {},
      transport: { fetch: (async (_url, init) => {
        requests++
        const body = JSON.parse(String(init?.body))
        assert.equal(body.model, choice.expected)
        assert.deepEqual(body.reasoning, 'reasoning' in answerReasoning(choice.expected) ? answerReasoning(choice.expected).reasoning : undefined)
        const completed = { type: 'response.completed', response: { status: 'completed', model: choice.expected, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Two keys can share a hash value.' }] }] } }
        return new Response(`data: ${JSON.stringify(completed)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      }) as typeof fetch }
    })
    assert.equal(requests, 1); assert.equal(result.model, choice.expected)
  }
})
