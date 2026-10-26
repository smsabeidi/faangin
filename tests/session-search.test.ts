import assert from 'node:assert/strict'
import test from 'node:test'
import { Repository } from '../src/main/repository'
import { DEFAULT_INTERVIEW_CONTEXT } from '../src/shared/types'
import { sessionDateFilter } from '../src/renderer/src/session-dates'
import { sessionListFilter } from '../src/main/validation'

test('search finds bounded literal words across answers and brief fields for saved and RAM sessions', () => {
  const repo = new Repository(':memory:')
  try {
    for (const persistent of [true, false]) {
      repo.setHistoryEnabled(persistent)
      const session = repo.create('interview')
      repo.update(session.id, { title: 'Ownership practice', interview: { ...DEFAULT_INTERVIEW_CONTEXT, company: 'Example Corp', problem: 'Handle value_token at a literal 10% boundary.' } })
      repo.saveAnswer({ id: `answer-${persistent}`, requestId: `request-${persistent}`, sessionId: session.id, action: 'solve', prompt: 'Find pair indices', text: 'Hash_map offers a linear solution.', model: 'fixture', status: 'complete', createdAt: 1 })
      for (const query of ['ownership hash_map', 'Example 10%', 'pair indices', 'value_token']) assert(repo.list(query).some(item => item.id === session.id), query)
      assert(!repo.list('hash%map').some(item => item.id === session.id)); assert(!repo.list('value_token missing').some(item => item.id === session.id))
      repo.trash(session.id); assert(!repo.list('hash_map').some(item => item.id === session.id)); assert(repo.list('hash_map', true).some(item => item.id === session.id))
    }
    assert.throws(() => repo.list('x'.repeat(501)), /500/)
  } finally { repo.close() }
})

test('database date and mode filters are applied before the result cap and share RAM behavior', () => {
  const repo = new Repository(':memory:')
  try {
    for (const persistent of [true, false]) {
      repo.setHistoryEnabled(persistent); const session = repo.create('interview'), stamp = repo.get(session.id).updatedAt
      assert(repo.list('', false, { updatedFrom: stamp, updatedBefore: stamp + 1, mode: 'interview' }).some(item => item.id === session.id))
      assert(!repo.list('', false, { updatedBefore: stamp }).some(item => item.id === session.id))
      assert(!repo.list('', false, { updatedFrom: stamp + 1 }).some(item => item.id === session.id))
      assert(!repo.list('', false, { mode: 'meeting' }).some(item => item.id === session.id))
    }
    assert.throws(() => sessionListFilter({ updatedFrom: 5, updatedBefore: 5 }), /end date/)
    for (const value of [{ updatedFrom: NaN }, { updatedBefore: -1 }, { updatedFrom: 1.5 }, { mode: 'unsupported' }, { includeDeleted: true }]) assert.throws(() => sessionListFilter(value))
  } finally { repo.close() }
})

test('calendar bounds include the complete chosen local day across daylight-saving changes', () => {
  const original = process.env.TZ; process.env.TZ = 'America/New_York'
  try {
    const spring = sessionDateFilter('2026-03-08', '2026-03-08'), autumn = sessionDateFilter('2026-11-01', '2026-11-01')
    assert.equal(spring.updatedBefore! - spring.updatedFrom!, 23 * 60 * 60 * 1000)
    assert.equal(autumn.updatedBefore! - autumn.updatedFrom!, 25 * 60 * 60 * 1000)
    assert.deepEqual(sessionDateFilter('', ''), {})
    for (const [from, to] of [['2026-02-30', ''], ['invalid', ''], ['2026-10-13', '2026-10-12'], ['1969-12-31', '']]) assert.throws(() => sessionDateFilter(from, to))
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original }
})
