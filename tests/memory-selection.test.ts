import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareMemorySelection } from '../src/main/memory-selection'
import { editMemorySnippet, memoryCandidates, selectMemoryCandidates } from '../src/main/context-memory'
import type { Session } from '../src/shared/types'

function saved(id: string, notes: string): Session { return { id, title: `Saved ${id}`, mode: 'meeting', status: 'ended', createdAt: 1, updatedAt: 10, contextEpoch: 0, notes, transcript: [], answers: [], attachments: [], persistent: true } }
const search = (sessions: Session[], query = '') => memoryCandidates({ currentSessionId: 'current', sessions, query })
const lookup = (sessions: Session[]) => (id: string) => { const session = sessions.find(item => item.id === id); if (!session) throw new Error('Unavailable'); return session }

test('selecting a query preview retains the exact approved late excerpt and verifies its source', () => {
  const session = saved('prior', `${'Earlier detail '.repeat(400)}APPROVED_TOPIC important decision.${' later detail'.repeat(400)}`)
  const displayed = search([session], 'APPROVED_TOPIC'), before = structuredClone(displayed)
  const selected = prepareMemorySelection('current', [displayed[0].id], [], displayed, lookup([session]))
  assert.equal(selected[0].text, displayed[0].text); assert(selected[0].excerptStart > 0)
  assert(selected[0].text.includes('APPROVED_TOPIC')); assert.deepEqual(displayed, before)
  assert.throws(() => prepareMemorySelection('current', [displayed[0].id], [], displayed, lookup([{ ...session, notes: 'Changed notes', updatedAt: 11 }])), /reselect/)
})

test('removing stale context is allowed and retained user edits are never replaced by a refreshed preview', () => {
  const sessions = [saved('prior', 'Approved note.'), saved('new', 'Another approved note.')], displayed = search(sessions)
  let prior = selectMemoryCandidates('current', [displayed[0].id], displayed)
  prior = editMemorySnippet('current', prior, prior[0].id, 'My explicit edited context.')
  const newCandidate = displayed.find(item => item.id !== prior[0].id)!
  const selected = prepareMemorySelection('current', [prior[0].id, newCandidate.id], prior, displayed, lookup(sessions))
  assert.equal(selected[0].text, prior[0].text); assert.equal(selected[0].edited, true)
  assert.deepEqual(prepareMemorySelection('current', [], prior, [], () => { throw new Error('Stale source must not block removal') }), [])
  const retained = prepareMemorySelection('current', [prior[0].id], prior, [], () => { throw new Error('Retained source is rechecked at dispatch') })
  retained[0].text = 'Caller edit'; assert.equal(prior[0].text, 'My explicit edited context.')
})

test('selection budgets apply to retained edits, both shortened and enlarged, before accepting additions', () => {
  const sessions = [saved('one', 'a'.repeat(2_000)), saved('two', 'b'.repeat(2_000)), saved('three', 'c'.repeat(2_000)), saved('four', 'd'.repeat(2_000))], displayed = search(sessions)
  let prior = selectMemoryCandidates('current', displayed.slice(0, 3).map(item => item.id), displayed)
  for (const snippet of prior) prior = editMemorySnippet('current', prior, snippet.id, 'Brief retained edit.')
  assert.equal(prepareMemorySelection('current', displayed.map(item => item.id), prior, displayed, lookup(sessions)).length, 4)
  const short = [saved('x', 'Short'), saved('y', 'Short'), saved('z', 'Short'), saved('w', 'Short')], preview = search(short)
  let enlarged = selectMemoryCandidates('current', preview.slice(0, 3).map(item => item.id), preview)
  for (const snippet of enlarged) enlarged = editMemorySnippet('current', enlarged, snippet.id, 'E'.repeat(2_000))
  assert.throws(() => prepareMemorySelection('current', preview.map(item => item.id), enlarged, preview, lookup(short)), /6,000/)
})

test('forged text, attribution, ambiguous identities and RAM-only sources cannot enter new context', () => {
  const session = saved('prior', 'Saved reference.'), displayed = search([session]), item = displayed[0]
  for (const patch of [{ text: 'Unapproved text' }, { sessionTitle: 'Forged title' }, { sessionMode: 'interview' }, { truncated: true }, { label: 'Invented source' }]) assert.throws(() => prepareMemorySelection('current', [item.id], [], [{ ...item, ...patch } as typeof item], lookup([session])))
  assert.throws(() => prepareMemorySelection('current', [item.id], [], [item, item], lookup([session])), /ambiguous/)
  assert.throws(() => prepareMemorySelection('current', [item.id, item.id], [], displayed, lookup([session])), /distinct/)
  assert.throws(() => prepareMemorySelection('current', [item.id], [], displayed, lookup([{ ...session, persistent: false }])), /reselect/)
  assert.throws(() => prepareMemorySelection('current', [item.id], [], displayed, lookup([{ ...session, deletedAt: 12 }])), /reselect/)
  assert.throws(() => prepareMemorySelection('prior', [item.id], [], displayed, lookup([session])), /different/)
})
