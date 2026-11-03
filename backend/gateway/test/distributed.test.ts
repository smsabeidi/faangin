import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { MemoryStore } from '../src/store.js'
import { audioBase64, NOW, openClient, PERIOD_KEY, post, proEntitlement, startFakeOpenAI, startGateway, TODAY, until } from './support.js'

test('two gateway instances share answer slots, atomic allowances and Smart downgrade', async () => {
  const fake = await startFakeOpenAI(), store = new MemoryStore()
  const a = await startGateway(fake, { store }), b = await startGateway(fake, { store })
  const uid = 'distributed-answers', token = `tok-${uid}`
  for (const gw of [a, b]) gw.entitlements.set(uid, proEntitlement())
  try {
    fake.hold = true
    const [first, second] = await Promise.all([post(a, token, { model: 'fast', input: 'one' }), post(b, token, { model: 'fast', input: 'two' })])
    const third = await post(b, token, { model: 'fast', input: 'three' })
    assert.equal(third.status, 429)
    assert.equal((await third.json() as { error: { code: string } }).error.code, 'concurrency')
    fake.hold = false; fake.release()
    await Promise.all([first.text(), second.text()])
    await until(async () => (await store.read(uid, PERIOD_KEY)).spendUsd > 0)

    await store.increment(uid, PERIOD_KEY, TODAY, { fast: 497 })
    const capped = await Promise.all([post(a, token, { model: 'fast', input: 'last allowance' }), post(b, token, { model: 'fast', input: 'same allowance' })])
    assert.deepEqual(capped.map(res => res.status).sort(), [200, 429])
    await Promise.all(capped.map(res => res.text()))
    assert.equal((await store.read(uid, PERIOD_KEY)).fast, 500)

    const smartUid = 'distributed-smart'
    for (const gw of [a, b]) gw.entitlements.set(smartUid, proEntitlement())
    await store.increment(smartUid, PERIOD_KEY, TODAY, { smart: 24 })
    const smart = await Promise.all([post(a, `tok-${smartUid}`, { model: 'smart', input: 'one' }), post(b, `tok-${smartUid}`, { model: 'smart', input: 'two' })])
    await Promise.all(smart.map(res => res.text()))
    assert.equal((await store.read(smartUid, PERIOD_KEY)).smart, 25)
    assert.equal((await store.read(smartUid, PERIOD_KEY)).fast, 1)
    assert.equal(smart.filter(res => res.headers.get('x-faangin-mode') === 'fast').length, 1)
  } finally { fake.release(); await Promise.all([a.close(), b.close()]); await fake.close() }
})

test('audio sockets and grace windows are shared across gateway instances, with crashed leases expiring', async () => {
  const fake = await startFakeOpenAI(), store = new MemoryStore()
  const a = await startGateway(fake, { store }), b = await startGateway(fake, { store })
  const uid = 'distributed-audio', token = `tok-${uid}`
  for (const gw of [a, b]) gw.entitlements.set(uid, proEntitlement())
  try {
    const first = await openClient(a, token), second = await openClient(b, token)
    const third = new WebSocket(`${b.wsBase}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal((await once(third, 'close'))[0], 1008)
    await first.close()
    const replacement = await openClient(b, token)
    assert.equal(replacement.ws.readyState, WebSocket.OPEN)
    await second.close(); await replacement.close()
    assert.equal(await store.claimGrace(uid, PERIOD_KEY, NOW), NOW)
    assert.equal(await store.claimGrace(uid, PERIOD_KEY, NOW + 60_000), NOW)

    const crashUid = 'crashed-instance-audio'
    assert.equal(await store.claimLease(crashUid, 'audio', 'crashed-one', NOW, NOW + 1_000, 2), true)
    assert.equal(await store.claimLease(crashUid, 'audio', 'crashed-two', NOW, NOW + 1_000, 2), true)
    assert.equal(await store.claimLease(crashUid, 'audio', 'blocked', NOW, NOW + 1_000, 2), false)
    assert.equal(await store.claimLease(crashUid, 'audio', 'recovered', NOW + 1_001, NOW + 2_001, 2), true)
    await store.releaseLease(crashUid, 'audio', 'recovered')
    assert.equal(await store.claimLease(crashUid, 'audio', 'recovered', NOW + 1_002, NOW + 3_000, 2, true), false, 'a late heartbeat must not resurrect a closed socket')
  } finally { await Promise.all([a.shutdown(), b.shutdown()]); await Promise.all([a.close(), b.close()]); await fake.close() }
})

test('audio allowance checks reconcile the second instance at each usage flush', async () => {
  const fake = await startFakeOpenAI(), store = new MemoryStore()
  const a = await startGateway(fake, { store, audioFlushMs: 25 }), b = await startGateway(fake, { store, audioFlushMs: 25 })
  const uid = 'distributed-audio-limit', token = `tok-${uid}`
  for (const gw of [a, b]) gw.entitlements.set(uid, proEntitlement())
  try {
    await store.increment(uid, PERIOD_KEY, '2026-10-27', { audioSeconds: 20 * 3600 - 3, graceUsedAt: NOW - 30 * 60 * 1000 })
    const first = await openClient(a, token), second = await openClient(b, token)
    for (const client of [first, second]) client.send({ type: 'input_audio_buffer.append', audio: audioBase64(2) })
    await until(() => fake.appends.length === 2)
    await until(() => [a, b].every(gw => gw.logs.some(log => log.event === 'audio_state' && log.fields?.state === 'muted')))
    for (const client of [first, second]) {
      client.send({ type: 'input_audio_buffer.append', audio: audioBase64(2) })
      client.send({ type: 'input_audio_buffer.commit' })
    }
    await until(() => [first, second].every(client => client.messages.some(value => String(value.item_id).startsWith('faangin_muted_'))))
    assert.equal(fake.appends.length, 2)
    await first.close(); await second.close()
    assert.equal((await store.read(uid, PERIOD_KEY)).audioSeconds, 20 * 3600 + 1)
  } finally { await Promise.all([a.shutdown(), b.shutdown()]); await Promise.all([a.close(), b.close()]); await fake.close() }
})

test('a transient usage-write failure closes audio and retries its buffered usage on close', async () => {
  class FlakyStore extends MemoryStore {
    writes = 0
    override async increment(...args: Parameters<MemoryStore['increment']>): Promise<void> {
      if (++this.writes === 1) throw new Error('transient database failure')
      return super.increment(...args)
    }
  }
  const fake = await startFakeOpenAI(), store = new FlakyStore()
  const gw = await startGateway(fake, { store, audioFlushMs: 25 })
  const uid = 'metering-recovery', token = `tok-${uid}`
  gw.entitlements.set(uid, proEntitlement())
  try {
    const client = await openClient(gw, token)
    const closed = once(client.ws, 'close')
    client.send({ type: 'input_audio_buffer.append', audio: audioBase64(2) })
    const [code, reason] = await closed
    assert.equal(code, 1011); assert.equal(String(reason), 'metering_unavailable')
    await until(async () => (await store.read(uid, PERIOD_KEY)).audioSeconds === 2)
    assert.equal(store.writes, 2)
  } finally { await gw.shutdown(); await gw.close(); await fake.close() }
})

test('an earlier shared grace claim immediately tightens a locally started window', async () => {
  class SharedGraceStore extends MemoryStore {
    override claimGrace(uid: string, period: string, now: number): Promise<number> {
      return super.claimGrace(uid, period, now - 30 * 60_000)
    }
  }
  const fake = await startFakeOpenAI(), store = new SharedGraceStore()
  const gw = await startGateway(fake, { store })
  const uid = 'shared-grace-deadline', token = `tok-${uid}`
  gw.entitlements.set(uid, proEntitlement())
  try {
    await store.increment(uid, PERIOD_KEY, TODAY, { audioSeconds: 20 * 3600 })
    const client = await openClient(gw, token)
    await until(() => gw.logs.some(log => log.event === 'audio_state' && log.fields?.state === 'muted'))
    client.send({ type: 'input_audio_buffer.append', audio: audioBase64(2) })
    client.send({ type: 'input_audio_buffer.commit' })
    await until(() => client.messages.some(value => String(value.item_id).startsWith('faangin_muted_')))
    assert.equal(fake.appends.length, 0)
    await client.close()
  } finally { await gw.shutdown(); await gw.close(); await fake.close() }
})
