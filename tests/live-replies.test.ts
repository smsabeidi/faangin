import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveReplyCoordinator, LIVE_REPLY_LIMITS, type LiveReplyCandidate, type LiveReplyClock, type LiveReplyLimits, type LiveReplyState } from '../src/main/live-replies'
import type { TranscriptTurn } from '../src/shared/types'
import { SOURCE_VAD_OPTIONS, VoiceActivity } from '../src/capture/vad'

class Clock implements LiveReplyClock {
  time = 0
  nextId = 1
  timers = new Map<number, { callback: () => void; due: number }>()
  now = () => this.time
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId++
    this.timers.set(id, { callback, due: this.time + delayMs })
    return id
  }
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number) }
  advance(milliseconds: number): void {
    const target = this.time + milliseconds
    for (let turns = 0; turns < 10_000; turns++) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
      if (!next) { this.time = target; return }
      this.time = next[1].due
      this.timers.delete(next[0]); next[1].callback()
    }
    throw new Error('Fixture clock did not settle.')
  }
}

function candidate(id = 'first', text = 'Explain how a hash table works.', patch: Partial<TranscriptTurn> = {}, generation = 1, epoch = 0): LiveReplyCandidate {
  return { turn: { id, text, sessionId: 'session', channel: 'system', timestamp: 1, ...patch }, generation, epoch }
}

function fixture(limits?: Partial<LiveReplyLimits>) {
  const clock = new Clock(), states: LiveReplyState[] = []
  const runs: Array<{ candidate: LiveReplyCandidate; signal: AbortSignal; at: number; resolve(): void; reject(): void }> = []
  const ownership = { enabled: true, busy: false, generation: 1, epoch: 0, sessionId: 'session', channel: 'system' }
  const coordinator = new LiveReplyCoordinator({ clock, limits: { coalesceMs: 350, minIntervalMs: 3_000, maxPerWindow: 6, windowMs: 60_000, busyPollMs: 250, ...limits }, hooks: {
    allowed: current => ownership.enabled && current.generation === ownership.generation && current.epoch === ownership.epoch && current.turn.sessionId === ownership.sessionId && current.turn.channel === ownership.channel,
    busy: () => ownership.busy,
    run: (current, signal) => new Promise<void>((resolve, reject) => { runs.push({ candidate: current, signal, at: clock.now(), resolve, reject: () => reject(new Error('Fixture provider failure')) }) }),
    onState: state => states.push(state),
  } })
  return { clock, coordinator, states, runs, ownership }
}

const settled = async () => { await Promise.resolve(); await Promise.resolve() }

test('automatic suggestions stay off until explicitly resumed', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.offer(candidate()); coordinator.defer(); clock.advance(100_000)
  assert.deepEqual(coordinator.snapshot(), { phase: 'off' })
  assert.equal(runs.length, 0); assert.equal(clock.timers.size, 0)
  coordinator.resume(); coordinator.offer(candidate()); clock.advance(349)
  assert.equal(runs.length, 0); clock.advance(1); assert.equal(runs.length, 1)
})

test('finalized statements, follow-ups and multilingual text need no question classifier', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  for (const [index, text] of ['I need to understand the trade-offs.', 'And the memory usage.', '请解释二分查找', '¿Cómo funciona?'].entries()) {
    coordinator.offer(candidate(`turn-${index}`, text)); clock.advance(index ? 3_000 : 350)
    assert.equal(runs.length, index + 1); assert.equal(runs[index].candidate.turn.text, text)
    runs[index].resolve(); await settled()
  }
})

test('only admitted finalized selected-source current-generation audio can become a target', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  coordinator.offer(candidate('partial', 'Unfinished speech', { provisional: true }))
  coordinator.offer(candidate('manual', 'Written context', { channel: 'manual' }))
  coordinator.offer(candidate('local', 'Candidate speaking', { channel: 'microphone' }))
  coordinator.offer(candidate('foreign', 'Foreign context', { sessionId: 'another' }))
  coordinator.offer(candidate('stale', 'Old capture', {}, 2))
  coordinator.offer(candidate('epoch', 'Old context', {}, 1, 1))
  clock.advance(100_000)
  assert.equal(runs.length, 0); assert.equal(clock.timers.size, 0)
})

test('microphone can be deliberately selected without guessing a speaker identity', () => {
  const { clock, coordinator, runs, ownership } = fixture()
  ownership.channel = 'microphone'; coordinator.resume()
  coordinator.offer(candidate('remote', 'Not selected'))
  coordinator.offer(candidate('room', 'Explain the result.', { channel: 'microphone' })); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.channel, 'microphone')
})

test('blank, punctuation and symbol-only finals do not create requests', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  for (const [index, text] of ['', ' \n\t ', '...?!', '— …。？！', '🙂 + ='].entries()) coordinator.offer(candidate(`empty-${index}`, text))
  clock.advance(60_000)
  assert.equal(runs.length, 0); assert.equal(clock.timers.size, 0)
  assert.equal(coordinator.snapshot().phase, 'listening')
})

test('offer freezes the pending turn against later caller mutation', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); const current = candidate()
  coordinator.offer(current); current.turn.text = 'CHANGED'; current.turn.channel = 'manual'; current.generation = 99
  clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.text, 'Explain how a hash table works.')
  assert.equal(runs[0].candidate.generation, 1)
})

test('adjacent final turns coalesce to the latest target with a fresh settle interval', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('one', 'Describe the algorithm.')); clock.advance(200)
  coordinator.offer(candidate('two', 'Include its time complexity.')); clock.advance(349)
  assert.equal(runs.length, 0); clock.advance(1)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'two'); assert.equal(runs[0].at, 550)
})

test('a delayed older final cannot replace a newer pending target', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  coordinator.offer(candidate('newer', 'Include its time complexity.', { timestamp: 2_000 }))
  clock.advance(200)
  coordinator.offer(candidate('older', 'Describe the algorithm.', { timestamp: 1_000 }))
  clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'newer')
})

test('a delayed older final cannot launch a stale response after a newer target was dispatched', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('newer', 'Explain the trade-off.', { timestamp: 2_000 })); clock.advance(350)
  runs[0].resolve(); await settled()
  coordinator.offer(candidate('older', 'Describe the approach.', { timestamp: 1_000 })); clock.advance(60_000)
  assert.equal(runs.length, 1); assert.equal(clock.timers.size, 0); assert.equal(coordinator.snapshot().phase, 'listening')
})

test('an older final can settle continuing speech without replacing the latest target', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('newer', 'Explain the trade-off.', { timestamp: 2_000 })); coordinator.defer()
  clock.advance(1_000); coordinator.offer(candidate('older', 'Earlier segment.', { timestamp: 1_000 })); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'newer')
})

test('invalid captured timestamps cannot schedule or release pending speech', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  for (const [index, timestamp] of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) coordinator.offer(candidate(`invalid-${index}`, 'Invalid timestamp.', { timestamp }))
  clock.advance(350); assert.equal(runs.length, 0)
  coordinator.offer(candidate('valid')); coordinator.defer()
  coordinator.offer(candidate('bad-final', '', { timestamp: NaN })); clock.advance(1_000)
  assert.equal(runs.length, 0); assert.match(coordinator.snapshot().reason!, /speech to finish/)
})

test('repeated stable final IDs neither duplicate requests nor extend coalescing', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate()); clock.advance(300)
  coordinator.offer(candidate()); clock.advance(50)
  assert.equal(runs.length, 1); assert.equal(runs[0].at, 350)
  coordinator.offer(candidate()); clock.advance(10_000)
  assert.equal(runs.length, 1); assert.equal(clock.timers.size, 0)
})

test('a selected-source partial holds a pending final until the continuing speech finalizes', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('first')); clock.advance(200); coordinator.defer()
  assert.equal(coordinator.snapshot().phase, 'waiting')
  assert.match(coordinator.snapshot().reason!, /speech to finish/)
  clock.advance(20_000); assert.equal(runs.length, 0); assert.equal(clock.timers.size, 0)
  coordinator.offer(candidate('continuation', 'With duplicate keys.')); clock.advance(349)
  assert.equal(runs.length, 0); clock.advance(1)
  assert.equal(runs[0].candidate.turn.id, 'continuation')
})

test('a six-second provider final cannot dispatch during continuing speech even before a new partial exists', () => {
  const { clock, coordinator, runs } = fixture({ coalesceMs: 120, minIntervalMs: 0 })
  coordinator.resume()
  let segment = 0
  const vad = new VoiceActivity(() => {}, complete => {
    segment++
    coordinator.offer({ ...candidate(`segment-${segment}`, complete ? 'Include the consistency trade-off.' : 'Explain how you would design this cache', { timestamp: segment }), utteranceComplete: complete })
  }, SOURCE_VAD_OPTIONS.system)
  const push = (level: number) => { clock.advance(20); vad.push(new ArrayBuffer(960), level) }
  for (let index = 0; index < 350; index++) push(.02)
  assert.equal(segment, 1)
  assert.equal(runs.length, 0, 'the first 6 s chunk remains held through the next second of speech')
  assert.match(coordinator.snapshot().reason!, /speech to finish/)
  for (let index = 0; index < 30; index++) push(0)
  assert.equal(segment, 2)
  clock.advance(119); assert.equal(runs.length, 0)
  clock.advance(1)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].candidate.turn.id, 'segment-2')
  assert.equal(runs[0].at, 7_720, '7 s speech + 600 ms silence endpoint + existing 120 ms coalescing')
})

test('a finalized blank endpoint releases a transport hold without discarding its meaningful target', () => {
  for (const text of ['', '…']) {
    const { clock, coordinator, runs } = fixture()
    coordinator.resume()
    coordinator.offer({ ...candidate('chunk', 'Explain why this invariant holds.', { timestamp: 100 }), utteranceComplete: false })
    clock.advance(20_000); assert.equal(runs.length, 0)
    coordinator.offer({ ...candidate('silence-tail', text, { timestamp: 200 }), utteranceComplete: true })
    clock.advance(350)
    assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'chunk')
  }
})

test('an earlier chunk boundary cannot release a newer provisional utterance', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  coordinator.defer(candidate('newer-partial', 'Actually, do not', { timestamp: 300, provisional: true }))
  coordinator.offer({ ...candidate('older-chunk', 'Use a hash table.', { timestamp: 100 }), utteranceComplete: false })
  coordinator.offer({ ...candidate('older-tail', '', { timestamp: 200 }), utteranceComplete: true })
  clock.advance(10_000); assert.equal(runs.length, 0)
  coordinator.offer({ ...candidate('newer-partial', 'Actually, do not use a hash table.', { timestamp: 300 }), utteranceComplete: true })
  clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.text, 'Actually, do not use a hash table.')
})

test('a metadata-only endpoint releases exactly its held finalized chunk and never newer or foreign speech', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  const chunk = { ...candidate('chunk', 'Why does the queue work?', { timestamp: 100 }), utteranceComplete: false }
  coordinator.offer(chunk)
  coordinator.completeUtterance({ ...chunk, generation: 2 })
  coordinator.completeUtterance(candidate('other', '', { timestamp: 200 }))
  clock.advance(1_000); assert.equal(runs.length, 0)
  coordinator.completeUtterance({ ...chunk, utteranceComplete: true }); clock.advance(350)
  assert.equal(runs.length, 1)
  coordinator.completeUtterance({ ...chunk, utteranceComplete: true }); clock.advance(10_000)
  assert.equal(runs.length, 1)

  const next = fixture(); next.coordinator.resume(); next.coordinator.offer(chunk)
  next.coordinator.defer(candidate('newer', 'No, I meant', { provisional: true, timestamp: 200 }))
  next.coordinator.completeUtterance({ ...chunk, utteranceComplete: true })
  next.clock.advance(10_000); assert.equal(next.runs.length, 0)
})

test('an empty continuing chunk can end through metadata while preserving earlier meaningful speech', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  coordinator.offer({ ...candidate('words', 'Explain the queue invariant.', { timestamp: 100 }), utteranceComplete: false })
  const empty = { ...candidate('empty-chunk', '', { timestamp: 200 }), utteranceComplete: false }
  coordinator.offer(empty); clock.advance(1_000); assert.equal(runs.length, 0)
  coordinator.completeUtterance({ ...empty, utteranceComplete: true }); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'words')
})

test('a missing endpoint stays held and reset discards it before the next conversation', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  coordinator.offer({ ...candidate('unfinished', 'The value is not', { timestamp: 100 }), utteranceComplete: false })
  clock.advance(60_000)
  assert.equal(runs.length, 0); assert.equal(clock.timers.size, 0)
  coordinator.reset(); coordinator.resume(); clock.advance(60_000)
  assert.equal(runs.length, 0)
  coordinator.offer(candidate('new', 'The value is not zero.', { timestamp: 200 })); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'new')
})

test('an empty or punctuation-only final releases a hold without replacing its target', () => {
  for (const text of ['', '…']) {
    const { clock, coordinator, runs } = fixture()
    coordinator.resume(); coordinator.offer(candidate('target')); coordinator.defer(); clock.advance(500)
    coordinator.offer(candidate('empty-final', text)); clock.advance(350)
    assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'target')
  }
})

test('remaining provisional speech can immediately re-defer an older final', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('target')); coordinator.defer()
  coordinator.offer(candidate('older', 'Previous segment.')); coordinator.defer(); clock.advance(1_000)
  assert.equal(runs.length, 0)
  coordinator.offer(candidate('last', 'Final requirement.')); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'last')
})

test('ownership is checked again immediately before dispatch to reject draining or revoked finals', () => {
  const { clock, coordinator, runs, ownership } = fixture()
  coordinator.resume(); coordinator.offer(candidate()); ownership.enabled = false; clock.advance(350)
  assert.equal(runs.length, 0); assert.equal(clock.timers.size, 0)
  assert.equal(coordinator.snapshot().phase, 'listening')
})

test('manual or external requests take priority and do not become coordinator-owned work', () => {
  const { clock, coordinator, runs, ownership } = fixture()
  coordinator.resume(); coordinator.offer(candidate()); ownership.busy = true; clock.advance(2_000)
  assert.equal(runs.length, 0); assert.equal(coordinator.snapshot().phase, 'waiting')
  ownership.busy = false; clock.advance(250)
  assert.equal(runs.length, 1)
})

test('a superseded suggestion retains transport ownership and only the latest replacement can run', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('running')); clock.advance(350)
  for (let index = 0; index < 100; index++) coordinator.offer(candidate(`pending-${index}`, `Additional requirement ${index}`))
  clock.advance(10_000)
  assert.equal(runs.length, 1); assert.equal(coordinator.snapshot().phase, 'waiting')
  assert.equal(runs[0].signal.aborted, true)
  assert.deepEqual(runs[0].signal.reason, { type: 'interview-interruption', reason: 'new-question', transcriptId: 'pending-0' })
  runs[0].resolve(); await settled(); clock.advance(0)
  assert.equal(runs.length, 2); assert.equal(runs[1].candidate.turn.id, 'pending-99')
})

test('success returns to listening and consecutive starts remain at least three seconds apart', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('first')); clock.advance(350)
  runs[0].resolve(); await settled(); assert.equal(coordinator.snapshot().phase, 'listening')
  coordinator.offer(candidate('next')); clock.advance(2_999)
  assert.match(coordinator.snapshot().reason!, /between live suggestions/)
  assert.equal(runs.length, 1); clock.advance(1)
  assert.equal(runs.length, 2); assert.equal(runs[1].at - runs[0].at, 3_000)
})

test('rolling-minute cost limit blocks a seventh start until the first start leaves its window', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume()
  for (let index = 0; index < 6; index++) {
    coordinator.offer(candidate(`run-${index}`)); clock.advance(index ? 3_000 : 350)
    assert.equal(runs.length, index + 1); runs[index].resolve(); await settled()
  }
  coordinator.offer(candidate('seventh')); clock.advance(44_999)
  assert.match(coordinator.snapshot().reason!, /request limit/)
  assert.equal(clock.now(), 60_349); assert.equal(runs.length, 6)
  clock.advance(1); assert.equal(runs.length, 7); assert.equal(runs[6].at, 60_350)
})

test('reset removes pending work and stale timer callbacks cannot dispatch after re-enable', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('old'))
  const stale = [...clock.timers.values()][0].callback
  coordinator.reset('Capture stopped.'); assert.deepEqual(coordinator.snapshot(), { phase: 'off', reason: 'Capture stopped.' })
  coordinator.resume(); coordinator.offer(candidate('new')); stale()
  assert.equal(runs.length, 0); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'new')
})

test('reset aborts only its own running signal and discards queued targets', async () => {
  const { clock, coordinator, runs } = fixture()
  const manual = new AbortController()
  coordinator.resume(); coordinator.offer(candidate('active')); clock.advance(350)
  coordinator.offer(candidate('pending')); coordinator.reset('Manual request.')
  assert.equal(runs[0].signal.aborted, true); assert.equal(manual.signal.aborted, false)
  runs[0].resolve(); await settled(); clock.advance(100_000)
  assert.equal(runs.length, 1); assert.equal(coordinator.snapshot().phase, 'off')
})

test('re-enable cannot overlap an aborted transport that has not yet settled', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('old')); clock.advance(350)
  coordinator.reset(); coordinator.resume(); coordinator.offer(candidate('new')); clock.advance(10_000)
  assert.equal(runs.length, 1)
  runs[0].reject(); await settled(); clock.advance(0)
  assert.equal(runs.length, 2); assert.equal(runs[1].candidate.turn.id, 'new')
  assert.equal(coordinator.snapshot().phase, 'generating')
})

test('provider failure pauses suggestions without retries or queued follow-up calls', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('failed')); clock.advance(350)
  runs[0].reject(); await settled()
  assert.equal(coordinator.snapshot().phase, 'paused'); assert.match(coordinator.snapshot().reason!, /failed/)
  coordinator.offer(candidate('another')); clock.advance(120_000)
  assert.equal(runs.length, 1); assert.equal(clock.timers.size, 0)
  coordinator.resume(); coordinator.offer(candidate('failed')); clock.advance(350)
  assert.equal(runs.length, 2)
})

test('new finalized constraints immediately abort the obsolete answer without overlapping its transport', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'Find the shortest unweighted path.', { timestamp: 1_000 })); clock.advance(350)
  coordinator.offer(candidate('weighted', 'Now the edges have different positive weights.', { timestamp: 2_000 }))
  assert.equal(runs[0].signal.aborted, true)
  assert.deepEqual(runs[0].signal.reason, { type: 'interview-interruption', reason: 'new-question', transcriptId: 'weighted' })
  clock.advance(5_000); assert.equal(runs.length, 1)
  // Some providers reject cancellation late. It is an intentional replacement, never a failure pause.
  runs[0].reject(); await settled(); clock.advance(0)
  assert.equal(runs.length, 2); assert.equal(runs[1].candidate.turn.id, 'weighted')
  assert.equal(coordinator.snapshot().phase, 'generating'); assert.equal(runs[1].signal.aborted, false)
})

test('continuing selected-source speech stops obsolete output but waits for its final before another request', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'Explain BFS.', { timestamp: 1_000 })); clock.advance(350)
  coordinator.defer(candidate('continuing', 'What if the graph', { timestamp: 2_000, provisional: true }))
  assert.deepEqual(runs[0].signal.reason, { type: 'interview-interruption', reason: 'new-speech', transcriptId: 'continuing' })
  assert.equal(coordinator.snapshot().phase, 'waiting'); assert.match(coordinator.snapshot().reason!, /speech to finish/)
  runs[0].reject(); await settled(); clock.advance(20_000)
  assert.equal(runs.length, 1); assert.equal(clock.timers.size, 0)
  assert.match(coordinator.snapshot().reason!, /speech to finish/)
  coordinator.offer(candidate('continuing', 'What if the graph is weighted?', { timestamp: 2_000 })); clock.advance(349)
  assert.equal(runs.length, 1); clock.advance(1)
  assert.equal(runs.length, 2); assert.equal(runs[1].candidate.turn.text, 'What if the graph is weighted?')
})

test('unselected, empty, duplicated, stale, revoked and foreign partials cannot interrupt an active answer', () => {
  const { clock, coordinator, runs, ownership } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'Explain BFS.', { timestamp: 2_000 })); clock.advance(350)
  for (const current of [
    candidate('local', 'Candidate voice', { channel: 'microphone', timestamp: 3_000, provisional: true }),
    candidate('blank', ' \n ', { timestamp: 3_000, provisional: true }),
    candidate('symbols', '…?!', { timestamp: 3_000, provisional: true }),
    candidate('original', 'A duplicate callback with changed text.', { timestamp: 3_000, provisional: true }),
    candidate('same-words', ' explain   bfs. ', { timestamp: 3_000, provisional: true }),
    candidate('old', 'Delayed older speech.', { timestamp: 1_000, provisional: true }),
    candidate('foreign', 'Another session.', { sessionId: 'other', timestamp: 3_000, provisional: true }),
    candidate('generation', 'Another capture.', { timestamp: 3_000, provisional: true }, 2),
    candidate('epoch', 'Another context.', { timestamp: 3_000, provisional: true }, 1, 1),
  ]) coordinator.defer(current)
  ownership.enabled = false
  coordinator.defer(candidate('revoked', 'Consent was disabled.', { timestamp: 4_000, provisional: true }))
  coordinator.offer(candidate('revoked-final', 'Consent was disabled.', { timestamp: 4_000 }))
  clock.advance(10_000)
  assert.equal(runs[0].signal.aborted, false); assert.equal(runs.length, 1)
  assert.equal(coordinator.snapshot().phase, 'generating')
})

test('blank, duplicate and older finalized segments do not cancel or queue behind a running answer', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'Explain BFS.', { timestamp: 2_000 })); clock.advance(350)
  coordinator.offer(candidate('blank', '', { timestamp: 3_000 }))
  coordinator.offer(candidate('punctuation', '…?!', { timestamp: 3_000 }))
  coordinator.offer(candidate('original', 'Same callback.', { timestamp: 4_000 }))
  coordinator.offer(candidate('same-words', ' explain   bfs. ', { timestamp: 3_000 }))
  coordinator.offer(candidate('old', 'Delayed previous question.', { timestamp: 1_000 }))
  assert.equal(runs[0].signal.aborted, false)
  runs[0].resolve(); await settled(); clock.advance(60_000)
  assert.equal(runs.length, 1); assert.equal(coordinator.snapshot().phase, 'listening')
})

test('a typed speech hold cannot be released by delayed older or unrelated empty finals', () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'Explain BFS.', { timestamp: 1_000 })); clock.advance(200)
  const partial = candidate('new-speech', 'What if', { timestamp: 3_000, provisional: true })
  coordinator.defer(partial); partial.turn.timestamp = 1 // Caller mutation cannot change ownership of the hold.
  coordinator.offer(candidate('older', 'An older segment.', { timestamp: 2_000 }))
  coordinator.offer(candidate('unrelated-empty', '', { timestamp: 4_000 }))
  coordinator.defer(candidate('even-older-partial', 'Old partial.', { timestamp: 1_500, provisional: true }))
  clock.advance(20_000)
  assert.equal(runs.length, 0); assert.match(coordinator.snapshot().reason!, /speech to finish/)
  coordinator.offer(candidate('new-speech', 'What if the graph is weighted?', { timestamp: 3_000 })); clock.advance(350)
  assert.equal(runs.length, 1); assert.equal(runs[0].candidate.turn.id, 'new-speech')
})

test('an empty final only settles its matching partial and never starts a replacement from partial text', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'Explain BFS.', { timestamp: 1_000 })); clock.advance(350)
  coordinator.defer(candidate('noise', 'Unfinished phrase.', { timestamp: 2_000, provisional: true }))
  runs[0].reject(); await settled()
  coordinator.offer(candidate('noise', '', { timestamp: 2_000 })); clock.advance(60_000)
  assert.equal(runs.length, 1); assert.equal(coordinator.snapshot().phase, 'listening')
})

test('new session ownership cannot supersede or queue behind another session without a reset', async () => {
  const { clock, coordinator, runs, ownership } = fixture()
  coordinator.resume(); coordinator.offer(candidate('original', 'First session.', { timestamp: 1_000 })); clock.advance(350)
  ownership.sessionId = 'another'
  coordinator.offer(candidate('foreign-final', 'Second session.', { sessionId: 'another', timestamp: 2_000 }))
  coordinator.defer(candidate('foreign-partial', 'Second session speech.', { sessionId: 'another', timestamp: 3_000, provisional: true }))
  assert.equal(runs[0].signal.aborted, false)
  runs[0].resolve(); await settled(); clock.advance(60_000)
  assert.equal(runs.length, 1)
})

test('interruption replacements retain minimum spacing and the rolling cost limit', async () => {
  const { clock, coordinator, runs } = fixture({ coalesceMs: 10, minIntervalMs: 100, maxPerWindow: 2, windowMs: 1_000 })
  coordinator.resume(); coordinator.offer(candidate('first', 'Initial question.')); clock.advance(10)
  coordinator.offer(candidate('second', 'Changed requirement.', { timestamp: 2 })); runs[0].reject(); await settled()
  clock.advance(99); assert.equal(runs.length, 1); clock.advance(1)
  assert.equal(runs.length, 2); assert.equal(runs[1].at, 110)
  coordinator.offer(candidate('third', 'Latest scenario.', { timestamp: 3 })); runs[1].reject(); await settled()
  clock.advance(899); assert.equal(runs.length, 2)
  assert.match(coordinator.snapshot().reason!, /request limit/)
  clock.advance(1); assert.equal(runs.length, 3); assert.equal(runs[2].at, 1_010)
})

test('a reset after interruption discards the replacement and a late cancellation error cannot pause a new lifecycle', async () => {
  const { clock, coordinator, runs, ownership } = fixture()
  coordinator.resume(); coordinator.offer(candidate('old', 'Original question.', { timestamp: 1_000 })); clock.advance(350)
  coordinator.offer(candidate('obsolete-replacement', 'Old session follow-up.', { timestamp: 2_000 }))
  coordinator.reset(); ownership.generation = 2; ownership.epoch = 1; coordinator.resume()
  coordinator.offer(candidate('new', 'Current question.', {}, 2, 1)); clock.advance(10_000)
  assert.equal(runs.length, 1)
  runs[0].reject(); await settled(); clock.advance(0)
  assert.equal(runs.length, 2); assert.equal(runs[1].candidate.turn.id, 'new')
  assert.equal(coordinator.snapshot().phase, 'generating')
})

test('a synchronous interruption from state publication prevents the obsolete transport from starting', () => {
  const clock = new Clock(), runs: string[] = []
  let changed = false
  const coordinator = new LiveReplyCoordinator({ clock, limits: { minIntervalMs: 0 }, hooks: {
    allowed: () => true, busy: () => false,
    run: async current => { runs.push(current.turn.id) },
    onState(state) {
      if (state.phase === 'generating' && !changed) { changed = true; coordinator.offer(candidate('latest', 'Changed before provider dispatch.', { timestamp: 2 })) }
    },
  } })
  coordinator.resume(); coordinator.offer(candidate('obsolete', 'Initial question.')); clock.advance(700)
  assert.deepEqual(runs, ['latest'])
})

test('a synchronous transport failure also pauses with no implicit retry', () => {
  const clock = new Clock()
  const coordinator = new LiveReplyCoordinator({ clock, hooks: { allowed: () => true, busy: () => false, run: () => { throw new Error('Fixture failure') }, onState() {} } })
  coordinator.resume(); coordinator.offer(candidate()); clock.advance(350)
  assert.equal(coordinator.snapshot().phase, 'paused'); assert.equal(clock.timers.size, 0)
})

test('reset and resume cannot bypass the minimum start interval', async () => {
  const { clock, coordinator, runs } = fixture()
  coordinator.resume(); coordinator.offer(candidate('first')); clock.advance(350)
  coordinator.reset(); runs[0].resolve(); await settled(); coordinator.resume(); coordinator.offer(candidate('second'))
  clock.advance(2_999); assert.equal(runs.length, 1); clock.advance(1)
  assert.equal(runs.length, 2); assert.equal(runs[1].at, 3_350)
})

test('old generation or context work is rejected and a new lifecycle can reuse a turn identity', async () => {
  const { clock, coordinator, runs, ownership } = fixture()
  coordinator.resume(); coordinator.offer(candidate('first', 'Old lifecycle content.', { timestamp: 10_000 })); clock.advance(350)
  coordinator.reset(); runs[0].resolve(); await settled()
  ownership.generation = 2; ownership.epoch = 1; coordinator.resume()
  coordinator.offer(candidate('first')); coordinator.offer(candidate('first', 'New lifecycle content.', {}, 2, 1)); clock.advance(3_000)
  assert.equal(runs.length, 2); assert.equal(runs[1].candidate.generation, 2); assert.equal(runs[1].candidate.epoch, 1)
})

test('snapshot and published state mutations cannot alter internal lifecycle state', () => {
  const { coordinator, states } = fixture()
  coordinator.resume(); const snapshot = coordinator.snapshot(); snapshot.phase = 'paused'; states[0].phase = 'off'
  assert.equal(coordinator.snapshot().phase, 'listening')
})

test('invalid scheduler limits are rejected before work can start', () => {
  const hooks = { allowed: () => true, busy: () => false, run: async () => {}, onState() {} }
  for (const limits of [{ coalesceMs: -1 }, { minIntervalMs: Infinity }, { maxPerWindow: 0 }, { windowMs: 0 }, { busyPollMs: 0 }, { maxPerWindow: 1.5 }]) {
    assert.throws(() => new LiveReplyCoordinator({ hooks, limits }), /limits/)
  }
})


test('production scheduling starts quickly while retaining bounded spacing and cost limits', async () => {
  const { clock, coordinator, runs } = fixture(LIVE_REPLY_LIMITS)
  coordinator.resume(); coordinator.offer(candidate('first'))
  clock.advance(119); assert.equal(runs.length, 0)
  clock.advance(1); assert.equal(runs.length, 1); assert.equal(runs[0].at, 120)
  runs[0].resolve(); await settled()
  coordinator.offer(candidate('second', 'Explain the memory tradeoff.', { timestamp: 2 }))
  clock.advance(799); assert.equal(runs.length, 1)
  clock.advance(1); assert.equal(runs.length, 2); assert.equal(runs[1].at - runs[0].at, 800)
  assert.equal(LIVE_REPLY_LIMITS.maxPerWindow, 20)
})


test('late finalized candidate context reconsiders an unpublished question without bypassing request limits', async () => {
  const { coordinator, clock, runs } = fixture(LIVE_REPLY_LIMITS)
  coordinator.resume(); coordinator.offer(candidate('question', 'Why BFS?', { timestamp: 100 }))
  clock.advance(120); assert.equal(runs.length, 1)
  const observation = candidate('candidate-answer', 'BFS visits by distance; DFS does not guarantee shortest paths.', { channel: 'microphone', timestamp: 200 })
  coordinator.contextChanged(observation)
  assert.equal(runs[0].signal.aborted, true)
  assert.equal((runs[0].signal.reason as { transcriptId: string }).transcriptId, 'candidate-answer')
  runs[0].resolve(); await settled()
  clock.advance(799); assert.equal(runs.length, 1)
  clock.advance(1); assert.equal(runs.length, 2); assert.equal(runs[1].candidate.turn.id, 'question')
  coordinator.contextChanged(observation)
  assert.equal(runs[1].signal.aborted, false, 'the same observation cannot cause repeated paid reconsideration')
})

test('provisional, selected-source and foreign candidate observations cannot reconsider a question', () => {
  const { coordinator, clock, runs } = fixture(LIVE_REPLY_LIMITS)
  coordinator.resume(); coordinator.offer(candidate('question')); clock.advance(120)
  for (const observation of [candidate('partial', 'Thinking', { channel: 'microphone', provisional: true }), candidate('same', 'Other question'), candidate('foreign', 'Answer', { channel: 'microphone', sessionId: 'foreign' }), candidate('stale', 'Answer', { channel: 'microphone' }, 2)]) coordinator.contextChanged(observation)
  assert.equal(runs[0].signal.aborted, false)
  assert.equal(runs.length, 1)
})
