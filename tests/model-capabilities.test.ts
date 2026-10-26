import test from 'node:test'
import assert from 'node:assert/strict'
import { answerReasoning, supportsImageInput } from '../src/main/model-capabilities'
import { transcriptionContext } from '../src/main/transcription-context'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Session } from '../src/shared/types'

test('modern models use supported low-latency reasoning without changing legacy requests', () => {
  assert.deepEqual(answerReasoning('gpt-6-luna'), { reasoning: { effort: 'none' } })
  assert.deepEqual(answerReasoning('gpt-6.1-sol'), { reasoning: { effort: 'low' } })
  for (const model of ['gpt-4.1-mini', 'unknown-text-model']) assert.deepEqual(answerReasoning(model), {})
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-4.1-2025-04-14']) assert.equal(supportsImageInput(model), true)
  for (const model of ['text-only-model', 'gpt-6-future-unknown', 'gpt-6.1-sol-injected']) assert.equal(supportsImageInput(model), false)
})

test('transcription vocabulary is bounded reference data without profile or invented speaker labels', () => {
  const session: Session = { id: 'test', title: 'Interview', mode: 'interview', status: 'idle', notes: 'PRIVATE_NOTES', createdAt: 0, updatedAt: 0, contextEpoch: 0, transcript: [], answers: [], attachments: [], interview: { ...DEFAULT_INTERVIEW_CONTEXT, problem: 'Find a shortest path with BFS.', constraints: 'Unweighted graph.' } }
  const configured = { ...DEFAULT_SETTINGS, profile: 'PRIVATE_PROFILE' }
  const context = transcriptionContext(session, configured, 'microphone')
  assert.match(context, /BFS/); assert.match(context, /Unweighted graph/)
  assert.match(context, /verbatim/); assert.match(context, /not a verified speaker/)
  assert(!context.includes('PRIVATE_NOTES')); assert(!context.includes('PRIVATE_PROFILE'))
  session.interview!.problem = 'x'.repeat(10_000)
  assert(transcriptionContext(session, DEFAULT_SETTINGS, 'system').length <= 2_500)
})
