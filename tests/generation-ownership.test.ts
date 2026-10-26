import test from 'node:test'
import assert from 'node:assert/strict'
import { manualGenerationBlocked } from '../src/renderer/src/generation-ownership'
import { composerShortcutRequest } from '../src/renderer/src/composer-request'
import type { Answer } from '../src/shared/types'

type Activity = Pick<Answer, 'status' | 'origin'>
const automatic: Activity = { status: 'streaming', origin: 'automatic' }
const manual: Activity = { status: 'streaming', origin: 'manual' }
function request(answers: Activity[], solve = false) {
  return composerShortcutRequest({ prompt: '', solve, working: manualGenerationBlocked(answers), busy: false, registeredShortcut: false })
}

test('a local manual shortcut can preempt an automatic stream with existing context', () => {
  assert.deepEqual(request([automatic]), { action: 'assist', prompt: '' })
  assert.deepEqual(request([automatic], true), { action: 'solve', prompt: '' })
  assert.equal(automatic.status, 'streaming', 'routing does not locally mark the existing stream complete or cancelled')
})

test('manual and legacy streaming answers still prevent duplicate manual generation', () => {
  assert.equal(request([manual]), null)
  assert.equal(request([{ status: 'streaming' }]), null)
  assert.equal(request([automatic, manual]), null)
})

test('a pending desktop operation blocks preemption until its result arrives', () => {
  assert.equal(manualGenerationBlocked([automatic], true), true)
  assert.equal(manualGenerationBlocked([], true), true)
  assert.equal(manualGenerationBlocked([automatic], false), false)
})

test('completed, cancelled and failed answers do not own the manual generation slot', () => {
  const terminal = (['complete', 'cancelled', 'failed'] as const).map(status => ({ status, origin: 'manual' as const }))
  assert.deepEqual(request(terminal), { action: 'assist', prompt: '' })
})
