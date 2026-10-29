import assert from 'node:assert/strict'
import test from 'node:test'
import { composerShortcutRequest } from '../src/renderer/src/composer-request'

const idle = { solve: false, working: false, busy: false, registeredShortcut: false }

test('empty composer shortcut requests assistance from the existing conversation instead of requiring typed text', () => {
  assert.deepEqual(composerShortcutRequest({ ...idle, prompt: '' }), { action: 'assist', prompt: '' })
  assert.deepEqual(composerShortcutRequest({ ...idle, prompt: ' \n\t' }), { action: 'assist', prompt: '' })
})

test('typed composer text remains an explicit question while Shift requests a solution', () => {
  assert.deepEqual(composerShortcutRequest({ ...idle, prompt: ' Explain binary search. \n' }), { action: 'ask', prompt: 'Explain binary search.' })
  assert.deepEqual(composerShortcutRequest({ ...idle, solve: true, prompt: ' Solve this. ' }), { action: 'solve', prompt: 'Solve this.' })
  assert.deepEqual(composerShortcutRequest({ ...idle, solve: true, prompt: '' }), { action: 'solve', prompt: '' })
})

test('a native registered shortcut owns dispatch without a second local provider request', () => {
  for (const solve of [false, true]) for (const prompt of ['', 'A question']) {
    assert.equal(composerShortcutRequest({ ...idle, solve, prompt, registeredShortcut: true }), null)
  }
})

test('local shortcuts cannot dispatch another answer during generation or a pending desktop operation', () => {
  for (const solve of [false, true]) for (const prompt of ['', 'A question']) {
    assert.equal(composerShortcutRequest({ ...idle, solve, prompt, working: true }), null)
    assert.equal(composerShortcutRequest({ ...idle, solve, prompt, busy: true }), null)
  }
})
