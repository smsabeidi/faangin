import assert from 'node:assert/strict'
import test from 'node:test'
import { createManagedTranscriber } from '../src/main/managed-transcriber'
import type { LiveTranscriber, TranscriberOptions } from '../src/main/inference'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!condition()) { if (Date.now() >= deadline) throw new Error('managed fixture timed out'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
function fixture(changes: { firstStop?: Promise<void>; secondReady?: Promise<void> } = {}) {
  const connections: Array<{ options: TranscriberOptions; pcm: number[]; commits: boolean[]; flushes: number; flushComplete: boolean[]; stops: number }> = []
  const errors: string[] = [], incomplete: string[] = [], finals: string[] = []
  const createTranscriber = async (options: TranscriberOptions): Promise<LiveTranscriber> => {
    const connection = { options, pcm: [] as number[], commits: [] as boolean[], flushes: 0, flushComplete: [] as boolean[], stops: 0 }
    connections.push(connection)
    if (connections.length === 2 && changes.secondReady) await Promise.race([changes.secondReady, new Promise<void>((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('admission cancelled')), { once: true }) })])
    return {
      write(pcm) { connection.pcm.push(pcm[0]) }, commit(complete = true) { connection.commits.push(complete) },
      async flush(complete = true) { connection.flushes++; connection.flushComplete.push(complete) }, async stop() { connection.stops++; if (connections[0] === connection) await changes.firstStop }
    }
  }
  return { connections, errors, incomplete, finals, options: {
    apiKey: 'fixture-managed', model: 'gpt-transcribe', language: 'en', channel: 'microphone' as const, rotationMs: 60_000,
    onPartial() {}, onFinal(id: string) { finals.push(id) }, onError(message: string) { errors.push(message) }, onIncomplete(message: string) { incomplete.push(message) }, createTranscriber
  } }
}

test('planned rotation drains the old connection and sends only previously unadmitted PCM to the new one', async () => {
  const drain = deferred(), f = fixture({ firstStop: drain.promise })
  let refreshes = 0
  const live = await createManagedTranscriber({ ...f.options, beforeReconnect: async () => { refreshes++ } })
  try {
    live.write(Uint8Array.of(1)); live.commit(false)
    f.connections[0].options.onSessionExpiring!()
    await until(() => f.connections[0].stops === 1)
    live.write(Uint8Array.of(2)); live.commit(true)
    f.connections[0].options.onFinal('same-item', 'old final', 1, true)
    drain.resolve()
    await live.flush()
    assert.equal(f.connections.length, 2)
    assert.deepEqual(f.connections[0].pcm, [1]); assert.deepEqual(f.connections[1].pcm, [2])
    assert.deepEqual(f.connections[0].commits, [false]); assert.deepEqual(f.connections[1].commits, [true])
    f.connections[1].options.onFinal('same-item', 'new final', 2, true)
    assert.equal(new Set(f.finals).size, 2, 'provider item ids must be unique across reconnects')
    assert.equal(refreshes, 2); assert.deepEqual(f.errors, [])
    assert.deepEqual(f.connections[0].flushComplete, [false], 'transport rotation must preserve an unfinished utterance')
  } finally { drain.resolve(); await live.stop() }
})

test('a stale worker expiration callback cannot rotate the replacement connection', async () => {
  const f = fixture(), live = await createManagedTranscriber(f.options)
  try {
    f.connections[0].options.onSessionExpiring!()
    await until(() => f.connections.length === 2)
    await live.flush()
    f.connections[0].options.onSessionExpiring!()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.connections.length, 2)
  } finally { await live.stop() }
})

test('managed capture rotates proactively without waiting for a server event', async () => {
  const f = fixture(), live = await createManagedTranscriber({ ...f.options, rotationMs: 15 })
  await until(() => f.connections.length >= 2)
  await live.stop()
  const count = f.connections.length
  live.write(Uint8Array.of(3)); live.commit()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.connections.length, count)
  assert.ok(f.connections.every(connection => connection.pcm.length === 0))
})

test('Stop aborts pending reconnection and rejects late callbacks or dispatch', async () => {
  const ready = deferred(), f = fixture({ secondReady: ready.promise })
  const live = await createManagedTranscriber(f.options)
  f.connections[0].options.onSessionExpiring!()
  await until(() => f.connections.length === 2)
  live.write(Uint8Array.of(9))
  const stopping = live.stop(); assert.strictEqual(live.stop(), stopping)
  await stopping
  ready.resolve()
  f.connections[1].options.onFinal('late', 'past stop', 1, true)
  assert.deepEqual(f.finals, []); assert.equal(f.incomplete.length, 1); assert.deepEqual(f.errors, [])
  assert.deepEqual(f.connections[1].pcm, [])
})

test('a managed reconnect buffer is bounded and never silently replays or drops overflow', async () => {
  const drain = deferred(), f = fixture({ firstStop: drain.promise })
  const live = await createManagedTranscriber({ ...f.options, maxBufferedMs: 100 })
  f.connections[0].options.onSessionExpiring!()
  await until(() => f.connections[0].stops === 1)
  live.write(new Uint8Array(4800)); live.write(new Uint8Array(2))
  assert.equal(f.errors.length, 1); assert.equal(f.incomplete.length, 1)
  drain.resolve(); await live.stop()
  assert.equal(f.connections.length, 1)
})
