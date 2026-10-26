import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingDesktopOperations, settledRequestDraft } from '../src/renderer/src/pending-operations'

const owner = { sessionId: 'interview', contextEpoch: 1 }

test('a concurrent operation finishing cannot unlock manual answers during a question flush', () => {
  const operations = new PendingDesktopOperations()
  const settings = operations.begin('Updating live suggestions')
  const question = operations.begin('Sending request')
  assert.equal(operations.finish(settings), 'Sending request')
  assert.equal(operations.finish(question), '')
})

test('stop while capture starts retains the pending operation even if completions reverse', () => {
  const operations = new PendingDesktopOperations()
  const start = operations.begin('Starting capture')
  const stop = operations.begin('Stopping capture')
  assert.equal(operations.finish(stop), 'Starting capture')
  assert.equal(operations.finish(start), '')
  assert.equal(operations.finish(stop), '')
})

test('a transcription flush timeout retains the submitted question and any newer edits', () => {
  assert.equal(settledRequestDraft('Why BFS instead of DFS?', 'Why BFS instead of DFS?', false, owner, owner), 'Why BFS instead of DFS?')
  assert.equal(settledRequestDraft('What about weighted edges?', 'Why BFS instead of DFS?', false, owner, owner), 'What about weighted edges?')
  assert.equal(settledRequestDraft('', 'Why BFS instead of DFS?', false, owner, owner), 'Why BFS instead of DFS?')
})

test('successful submission clears only the submitted draft in the same interview context', () => {
  assert.equal(settledRequestDraft(' Why BFS? ', 'Why BFS?', true, owner, owner), '')
  assert.equal(settledRequestDraft('And what is the complexity?', 'Why BFS?', true, owner, owner), 'And what is the complexity?')
  assert.equal(settledRequestDraft('Why BFS?', 'Why BFS?', true, owner, { ...owner, contextEpoch: 2 }), 'Why BFS?')
})

test('a failed request never restores an old question after a session switch or reset', () => {
  for (const currentOwner of [null, { sessionId: 'different', contextEpoch: 1 }, { ...owner, contextEpoch: 2 }]) {
    assert.equal(settledRequestDraft('', 'Old question', false, owner, currentOwner), '')
  }
})
