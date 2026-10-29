import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePrompt } from '../src/main/prompts'
import { generateCompiledAnswer } from '../src/main/inference'
import { answerReasoning } from '../src/main/model-capabilities'
import { compatibleChatBody } from '../src/main/compatible-chat'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Action, type Session } from '../src/shared/types'

function session(): Session {
  return { id: 'reasoning', title: 'Synthetic design', mode: 'interview', status: 'idle', notes: '', createdAt: 0, updatedAt: 0, contextEpoch: 0, transcript: [{ id: 'question', sessionId: 'reasoning', channel: 'system', text: 'What would you change?', timestamp: 1 }], answers: [], attachments: [], interview: { ...DEFAULT_INTERVIEW_CONTEXT, round: 'system-design', problem: 'Design a bounded background processing service.' } }
}

test('full design receives a single-pass reasoning hint while focused replies retain their latency policy', async () => {
  for (const [action, effort] of [['design', 'low'], ['ask', 'none'], ['reply', 'none'], ['solve', 'none']] as const) {
    const prompt = compilePrompt({ action: action as Action, prompt: 'Explain the request.', settings: DEFAULT_SETTINGS, session: session(), attachments: [] })
    assert.equal(prompt.reasoningEffort, action === 'design' ? 'low' : undefined)
    let calls = 0
    const result = await generateCompiledAnswer(prompt, 'gpt-6-luna', {
      apiKey: 'fixture-only-not-a-real-key', signal: new AbortController().signal, onDelta() {},
      transport: { fetch: (async (_url, init) => {
        calls++
        const body = JSON.parse(String(init?.body))
        assert.deepEqual(body.reasoning, { effort })
        assert.equal(body.max_output_tokens, prompt.maxOutputTokens)
        assert.equal(body.store, false)
        const completed = { type: 'response.completed', response: { status: 'completed', model: 'gpt-6-luna', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Use bounded workers.' }] }] } }
        return new Response(`data: ${JSON.stringify(completed)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      }) as typeof fetch }
    })
    assert.equal(result.text, 'Use bounded workers.')
    assert.equal(calls, 1, 'reasoning is part of the admitted generation, not another model request')
  }
})

test('design reasoning is specific to supported Luna requests and does not alter other providers', () => {
  assert.deepEqual(answerReasoning('gpt-6-luna', 'low'), { reasoning: { effort: 'low' } })
  assert.deepEqual(answerReasoning('gpt-4.1', 'low'), {})
  assert.deepEqual(answerReasoning('custom-model', 'low'), {})
  assert.deepEqual(answerReasoning('gpt-6-sol', 'low'), { reasoning: { effort: 'none' } })
  assert.deepEqual(answerReasoning('gpt-6.1-sol', 'none'), { reasoning: { effort: 'low' } })
  const prompt = compilePrompt({ action: 'design', prompt: 'Explain this architecture.', settings: DEFAULT_SETTINGS, session: session(), attachments: [] })
  const body = JSON.parse(compatibleChatBody(prompt, { endpoint: 'http://127.0.0.1:11434/v1', model: 'explicit-local-model', vision: false }))
  assert.equal(body.model, 'explicit-local-model')
  assert.equal('reasoning' in body, false)
  assert.equal('reasoning_effort' in body, false)
})
