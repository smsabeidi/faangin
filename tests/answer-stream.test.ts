import assert from 'node:assert/strict'
import test from 'node:test'
import { AnswerStreamBatcher, type AnswerStreamScheduler, type AnswerStreamUpdate } from '../src/renderer/src/answer-stream'
import type { Answer, Session } from '../src/shared/types'

function answer(requestId = 'first', patch: Partial<Answer> = {}): Answer {
  return { id: `answer-${requestId}`, requestId, sessionId: 'session', action: 'ask', prompt: 'Question', text: '', model: 'fixture', status: 'streaming', createdAt: 1, ...patch }
}
function session(answers: Answer[] = [answer()], patch: Partial<Session> = {}): Session {
  return { id: 'session', title: 'Fixture', mode: 'interview', status: 'idle', createdAt: 1, updatedAt: 1, notes: '', transcript: [], answers, attachments: [], contextEpoch: 0, ...patch }
}

class Scheduler implements AnswerStreamScheduler {
  now = 0
  nextId = 1
  frames = new Map<number, () => void>()
  timers = new Map<number, { callback: () => void; due: number }>()
  requestFrame = (callback: () => void) => { const id = this.nextId++; this.frames.set(id, callback); return id }
  cancelFrame = (handle: number) => { this.frames.delete(handle) }
  setTimer = (callback: () => void, delayMs: number) => { const id = this.nextId++; this.timers.set(id, { callback, due: this.now + delayMs }); return id }
  clearTimer = (handle: number) => { this.timers.delete(handle) }
  frame() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback()) }
  advance(milliseconds: number) { this.now += milliseconds; for (const [id, timer] of [...this.timers]) if (timer.due <= this.now) { this.timers.delete(id); timer.callback() } }
}

function fixture(withFrames = true) {
  const scheduler = new Scheduler()
  const publications: Array<{ updates: AnswerStreamUpdate[]; generation: number }> = []
  const schedule: AnswerStreamScheduler = withFrames ? scheduler : { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer }
  const streams = new AnswerStreamBatcher(schedule, (updates, generation) => publications.push({ updates, generation }))
  streams.reconcile(session())
  const delta = (text: string, requestId = 'first', sessionId = 'session', firstTokenMs?: number) => streams.delta({ sessionId, requestId, delta: text, firstTokenMs })
  return { scheduler, publications, streams, delta }
}

test('first nonempty text publishes immediately without waiting for a render frame', () => {
  const { scheduler, publications, delta } = fixture()
  delta('', 'first', 'session', 0)
  assert.equal(publications.length, 0)
  delta('A', 'first', 'session', 0)
  assert.equal(publications.length, 1)
  assert.equal(publications[0].updates[0].text, 'A')
  assert.equal(publications[0].updates[0].firstTokenMs, 0)
  assert.equal(scheduler.frames.size, 0)
  assert.equal(scheduler.timers.size, 0)
})

test('a large token burst produces one frame update with every character in order', () => {
  const { scheduler, publications, delta } = fixture()
  const chunks = Array.from({ length: 500 }, (_, index) => ` ${index}😀`)
  delta('Start')
  for (const chunk of chunks) delta(chunk)
  assert.equal(publications.length, 1)
  assert.equal(scheduler.frames.size, 1)
  assert.equal(scheduler.timers.size, 1)
  scheduler.frame()
  assert.equal(publications.length, 2)
  assert.equal(publications[1].updates[0].text, `Start${chunks.join('')}`)
  assert.equal(scheduler.timers.size, 0)
})

test('leading whitespace survives a stale snapshot and the first visible word publishes immediately', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta(' \n', 'first', 'session', 1)
  delta('\t', 'first', 'session', 2)
  assert.equal(publications.length, 0)
  assert.equal(scheduler.frames.size, 0)
  assert.equal(scheduler.timers.size, 0)
  assert.equal(streams.reconcile(session())?.answers[0].text, ' \n\t')
  delta('Answer', 'first', 'session', 21)
  assert.equal(publications.length, 1)
  assert.equal(publications[0].updates[0].text, ' \n\tAnswer')
  assert.equal(publications[0].updates[0].firstTokenMs, 21)
  assert.equal(scheduler.frames.size, 0)
  delta(' follows')
  scheduler.frame()
  assert.equal(publications.at(-1)?.updates[0].text, ' \n\tAnswer follows')

  streams.reconcile(session([], { contextEpoch: 1 }))
  streams.start(answer('second', { text: '\n  ' }))
  delta('Visible', 'second', 'session', 7)
  assert.equal(publications.at(-1)?.updates[0].text, '\n  Visible')
  assert.equal(publications.at(-1)?.updates[0].firstTokenMs, 7)
  assert.equal(scheduler.frames.size, 0)
})

test('whitespace-only delivery can finish or fail with canonical empty text', () => {
  for (const status of ['complete', 'failed'] as const) {
    const { scheduler, publications, streams, delta } = fixture()
    delta(' \n\t')
    const final = answer('first', { status, text: '', error: status === 'failed' ? 'Fixture failure' : undefined })
    assert.deepEqual(streams.complete(final), final)
    assert.deepEqual(streams.reconcile(session())?.answers[0], final)
    assert.equal(publications.length, 0)
    assert.equal(scheduler.frames.size, 0)
    assert.equal(scheduler.timers.size, 0)
  }
})

test('a stalled background frame has a 32 ms fallback and cancels the frame', () => {
  const { scheduler, publications, delta } = fixture()
  delta('A'); delta('B')
  scheduler.advance(31)
  assert.equal(publications.length, 1)
  scheduler.advance(1)
  assert.equal(publications.length, 2)
  assert.equal(publications[1].updates[0].text, 'AB')
  assert.equal(scheduler.frames.size, 0)
  scheduler.frame()
  assert.equal(publications.length, 2)
})

test('timer-only rendering also preserves the immediate first token', () => {
  const { scheduler, publications, delta } = fixture(false)
  delta('A'); delta('B')
  assert.equal(publications.length, 1)
  scheduler.advance(32)
  assert.equal(publications[1].updates[0].text, 'AB')
})

test('a cancelled fallback callback cannot publish twice after a frame', () => {
  const { scheduler, publications, delta } = fixture()
  delta('A'); delta('B')
  const staleTimer = [...scheduler.timers.values()][0].callback
  scheduler.frame()
  staleTimer()
  assert.equal(publications.length, 2)
  delta('C')
  staleTimer()
  assert.equal(publications.length, 2)
  scheduler.frame()
  assert.equal(publications[2].updates[0].text, 'ABC')
})

test('concurrent requests share a frame without mixing text or first-token timings', () => {
  const { scheduler, publications, streams, delta } = fixture()
  streams.reconcile(session([answer('first'), answer('second')]))
  delta('A', 'first', 'session', 10)
  delta('1', 'second', 'session', 20)
  delta('B'); delta('2', 'second'); delta('C'); delta('3', 'second')
  assert.equal(publications.length, 2)
  scheduler.frame()
  assert.deepEqual(publications[2].updates.map(update => [update.requestId, update.text, update.firstTokenMs]), [['first', 'ABC', 10], ['second', '123', 20]])
})

test('canonical completion replaces all queued partial text and suppresses late deltas', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta('Long'); delta(' partial')
  const staleFrame = [...scheduler.frames.values()][0]
  const final = answer('first', { text: 'Final', status: 'complete', totalMs: 100, firstTokenMs: 5 })
  assert.deepEqual(streams.complete(final), final)
  delta(' ignored')
  staleFrame(); scheduler.advance(32)
  assert.equal(publications.length, 1)
  assert.equal(streams.reconcile(session())?.answers[0].text, 'Final')
  assert.equal(streams.reconcile(session())?.answers[0].status, 'complete')
  assert.equal(streams.complete(final), null)
})

test('failure and provider cancellation retain their authoritative partial answer', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const { scheduler, streams, delta } = fixture()
    delta('A'); delta('B')
    const final = answer('first', { text: 'AB', status, error: status === 'failed' ? 'Fixture failure' : undefined })
    assert.deepEqual(streams.complete(final), final)
    assert.deepEqual(streams.reconcile(session())?.answers[0], final)
    assert.equal(scheduler.frames.size, 0)
    assert.equal(scheduler.timers.size, 0)
  }
})

test('completion of one request leaves another pending request scheduled', () => {
  const { scheduler, publications, streams, delta } = fixture()
  streams.reconcile(session([answer('first'), answer('second')]))
  delta('A'); delta('B'); delta('1', 'second'); delta('2', 'second')
  streams.complete(answer('first', { text: 'AB', status: 'complete' }))
  assert.equal(scheduler.frames.size, 1)
  scheduler.frame()
  assert.deepEqual(publications.at(-1)?.updates.map(update => [update.requestId, update.text]), [['second', '12']])
})

test('state refresh includes unpublished text and does not duplicate it on the next delta', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta('A'); delta('B')
  const oldFrame = [...scheduler.frames.values()][0]
  const fresh = streams.reconcile(session([answer('first', { text: 'A' })]))
  assert.equal(fresh?.answers[0].text, 'AB')
  oldFrame()
  assert.equal(publications.length, 1)
  delta('C'); scheduler.frame()
  assert.equal(publications.at(-1)?.updates[0].text, 'ABC')
})

test('narrow admission and delta survive an older full snapshot with no answer', () => {
  const { scheduler, streams, delta } = fixture()
  streams.reconcile(session([]))
  const admitted = answer('second')
  assert.deepEqual(streams.start(admitted), admitted)
  delta('A', 'second'); delta('B', 'second')
  const fresh = streams.reconcile(session([]))
  assert.equal(fresh?.answers.find(item => item.requestId === 'second')?.text, 'AB')
  assert.equal(scheduler.frames.size, 0)
  const finished = answer('second', { text: 'AB', status: 'complete' })
  assert.deepEqual(streams.complete(finished), finished)
  assert.equal(streams.reconcile(session([]))?.answers.find(item => item.requestId === 'second')?.status, 'complete')
})

test('reset retires admission, scheduled callbacks and completion from the old context', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta('Old'); delta(' answer')
  const oldFrame = [...scheduler.frames.values()][0]
  const generation = publications[0].generation
  streams.reconcile(session([], { contextEpoch: 1 }))
  assert.equal(streams.isCurrent(generation), false)
  oldFrame(); delta(' stale')
  assert.equal(streams.complete(answer('first', { text: 'Old answer', status: 'complete' })), null)
  assert.equal(publications.length, 1)
  const next = answer('new')
  streams.start(next)
  delta('New', 'new')
  assert.equal(publications.at(-1)?.updates[0].contextEpoch, 1)
  assert.equal(publications.at(-1)?.updates[0].text, 'New')
})

test('switching sessions ignores foreign deltas and can resume from the canonical snapshot', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta('Old'); delta(' session')
  const oldFrame = [...scheduler.frames.values()][0]
  streams.reconcile(session([answer('next', { sessionId: 'other' })], { id: 'other' }))
  oldFrame(); delta(' stale')
  assert.equal(streams.start(answer('foreign')), null)
  assert.equal(publications.length, 1)
  delta('Other', 'next', 'other')
  streams.reconcile(session([answer('first', { text: 'Old session' })]))
  delta(' resumed'); scheduler.frame()
  assert.equal(publications.at(-1)?.updates[0].text, 'Old session resumed')
})

test('local cancellation flushes buffered text and remains cancelled through stale refreshes', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta('A'); delta('B')
  assert.deepEqual(streams.cancel('first'), answer('first', { text: 'AB', status: 'cancelled', firstTokenMs: undefined }))
  delta('C'); scheduler.frame(); scheduler.advance(32)
  assert.equal(publications.length, 1)
  assert.equal(streams.reconcile(session())?.answers[0].text, 'AB')
  assert.equal(streams.reconcile(session())?.answers[0].status, 'cancelled')
  const final = answer('first', { text: 'AB', status: 'cancelled', totalMs: 12 })
  assert.deepEqual(streams.complete(final), final)
})

test('unknown requests, foreign completions and duplicate admission cannot reopen a terminal answer', () => {
  const { publications, streams, delta } = fixture()
  delta('ignored', 'unknown')
  delta('ignored', 'first', 'other')
  assert.equal(streams.complete(answer('unknown', { status: 'complete' })), null)
  assert.equal(streams.complete(answer('first', { sessionId: 'other', status: 'complete' })), null)
  const final = answer('first', { status: 'complete', text: 'Done' })
  streams.complete(final)
  assert.equal(streams.start(answer()), null)
  delta(' ignored')
  assert.equal(publications.length, 0)
})

test('disposal suppresses queued callbacks and future calls, including a fresh setup instance', () => {
  const { scheduler, publications, streams, delta } = fixture()
  delta('A'); delta('B')
  const staleFrame = [...scheduler.frames.values()][0]
  const staleTimer = [...scheduler.timers.values()][0].callback
  streams.dispose()
  assert.equal(streams.isCurrent(publications[0].generation), false)
  assert.equal(scheduler.frames.size, 0)
  assert.equal(scheduler.timers.size, 0)
  streams.reconcile(session()); delta('C'); staleFrame(); staleTimer()
  assert.equal(streams.start(answer()), null)
  assert.equal(streams.cancel('first'), null)
  assert.equal(streams.complete(answer('first', { status: 'complete' })), null)
  assert.equal(publications.length, 1)
  const fresh = fixture()
  fresh.delta('New mount')
  assert.equal(fresh.publications[0].updates[0].text, 'New mount')
})

test('an interrupted response stays terminal with its partial code and metadata through late delivery', () => {
  const { scheduler, streams, delta } = fixture()
  delta('```python\nqueue'); delta(' = deque([start])')
  const oldFrame = [...scheduler.frames.values()][0]
  const interrupted = answer('first', { status: 'cancelled', text: '```python\nqueue = deque([start])', interruption: { reason: 'new-question', transcriptId: 'new-question', at: 2 } })
  assert.deepEqual(streams.complete(interrupted), interrupted)
  delta('\nobsolete expansion')
  oldFrame(); scheduler.advance(32)
  assert.deepEqual(streams.reconcile(session())?.answers[0], interrupted)
  assert.equal(streams.complete(answer('first', { status: 'complete', text: 'Obsolete answer completed late' })), null)
  const updated = answer('latest', { text: '' })
  assert.deepEqual(streams.start(updated), updated)
  delta('New constraints change the approach.', 'latest')
  const answers = streams.reconcile(session([answer(), updated]))?.answers
  assert.deepEqual(answers?.[0], interrupted)
  assert.equal(answers?.[1].text, 'New constraints change the approach.')
})
