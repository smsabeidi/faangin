import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureFence } from '../src/capture/fence'
import { compilePrompt } from '../src/main/prompts'
import { Repository } from '../src/main/repository'
import { DEFAULT_SETTINGS, type AudioChannel } from '../src/shared/types'

test('opposite audio sources retain capture order when their finalized transcripts arrive in reverse order', () => {
  for (const firstChannel of ['system', 'microphone'] as const) {
    const repo = new Repository(':memory:')
    try {
      const session = repo.create('interview')
      const secondChannel: AudioChannel = firstChannel === 'system' ? 'microphone' : 'system'
      repo.transcript(session.id, secondChannel, 'Later answer: I will use a hash map.', 'answer', 2_000)
      repo.transcript(session.id, firstChannel, 'Earlier question: How would you solve Two Sum?', 'question', 1_000)
      const stored = repo.get(session.id)
      assert.deepEqual(stored.transcript.map(turn => [turn.id, turn.channel, turn.timestamp]), [['question', firstChannel, 1_000], ['answer', secondChannel, 2_000]])
      const compiled = compilePrompt({ action: 'solve', settings: DEFAULT_SETTINGS, session: stored, attachments: [] })
      assert.deepEqual(compiled.sources.transcriptIds, ['question', 'answer'])
      const content = compiled.input.at(-1)?.content
      assert(Array.isArray(content))
      const source = content.find(part => part.type === 'input_text')
      assert(source?.type === 'input_text')
      const data = JSON.parse(source.text) as { transcript: Array<{ text: string }> }
      assert(data.transcript[0].text.startsWith('Earlier question'))
      assert(data.transcript[1].text.startsWith('Later answer'))
    } finally { repo.close() }
  }
})

test('repeated stable transcript callbacks cannot overwrite the first capture timestamp, channel or text', () => {
  const repo = new Repository(':memory:')
  try {
    const session = repo.create('interview')
    const original = repo.transcript(session.id, 'system', 'Original interviewer question.', 'stable-item', 1_000)
    const duplicate = repo.transcript(session.id, 'microphone', 'Unexpected replacement text.', 'stable-item', 9_000)
    assert.deepEqual(duplicate, original)
    assert.deepEqual(repo.get(session.id).transcript, [original])
    const other = repo.create('interview')
    assert.throws(() => repo.transcript(other.id, 'system', 'Foreign callback.', 'stable-item', 10_000), /identity collision/)
    assert.deepEqual(repo.get(other.id).transcript, [])
    assert.deepEqual(repo.get(session.id).transcript, [original])
  } finally { repo.close() }
})

test('invalid capture timestamps are rejected without saving a turn, while valid integer boundaries are retained', () => {
  const repo = new Repository(':memory:')
  try {
    const session = repo.create('interview')
    for (const timestamp of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => repo.transcript(session.id, 'system', 'Invalid turn.', 'invalid', timestamp), /Invalid capture timestamp/)
      assert.deepEqual(repo.get(session.id).transcript, [])
    }
    const first = repo.transcript(session.id, 'system', 'At the valid lower boundary.', 'lower-bound', 0)
    const last = repo.transcript(session.id, 'microphone', 'At the valid upper boundary.', 'upper-bound', Number.MAX_SAFE_INTEGER)
    assert.equal(first.timestamp, 0)
    assert.equal(last.timestamp, Number.MAX_SAFE_INTEGER)
    assert.deepEqual(repo.get(session.id).transcript.map(turn => turn.timestamp), [0, Number.MAX_SAFE_INTEGER])
  } finally { repo.close() }
})

test('reset advances the repository context epoch so the capture fence rejects results for the old context', () => {
  const repo = new Repository(':memory:')
  try {
    const session = repo.create('interview'), fence = new CaptureFence()
    const generation = fence.begin(session.id, session.contextEpoch)
    repo.transcript(session.id, 'system', 'Old problem.', 'old-question', 1_000)
    const reset = repo.reset(session.id)
    assert.equal(reset.contextEpoch, session.contextEpoch + 1)
    assert.equal(fence.acceptsResult(generation, session.id, reset.contextEpoch), false)
    assert.deepEqual(reset.transcript, [])

    const nextGeneration = fence.begin(session.id, reset.contextEpoch)
    assert.equal(fence.acceptsResult(generation, session.id, reset.contextEpoch), false)
    assert.equal(fence.acceptsResult(nextGeneration, session.id, reset.contextEpoch), true)
    repo.transcript(session.id, 'system', 'New problem.', 'new-question', 2_000)
    assert.deepEqual(repo.get(session.id).transcript.map(turn => turn.id), ['new-question'])
  } finally { repo.close() }
})
