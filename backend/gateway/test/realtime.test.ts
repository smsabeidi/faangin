import assert from 'node:assert/strict'
import { once } from 'node:events'
import { connect } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { MODELS } from '../src/config.js'
import { shapeClientEvent } from '../src/realtime.js'
import { audioBase64, NOW, openClient, PERIOD_KEY, proEntitlement, startFakeOpenAI, startGateway, TODAY, until, type FakeOpenAI, type Gateway } from './support.js'

let fake: FakeOpenAI
let gw: Gateway
let n = 0
let uid: string
let token: string

before(async () => {
  fake = await startFakeOpenAI()
  gw = await startGateway(fake)
})
after(async () => {
  await gw.close()
  await fake.close()
})
beforeEach(() => {
  uid = `rt${++n}`
  token = `tok-${uid}`
  gw.entitlements.set(uid, proEntitlement())
  gw.flags.transcriptionOff = false
  gw.clock.now = NOW
  fake.sessionUpdates.length = 0
  fake.appends.length = 0
  fake.commits = 0
})

const usage = () => gw.store.read(uid, PERIOD_KEY)
const HOURS_20 = 20 * 3600
const GRACE_MS = 30 * 60_000
const PCM = { type: 'audio/pcm', rate: 24000 }
const append = (seconds: number) => ({ type: 'input_audio_buffer.append', audio: audioBase64(seconds) })
const COMMIT = { type: 'input_audio_buffer.commit' }
const muted = (m: Record<string, unknown>) => m.type === 'input_audio_buffer.committed' && String(m.item_id).startsWith('faangin_muted_')

describe('client event allowlist', () => {
  it('keeps only known events and fields, and forces the pcm format the metering assumes', () => {
    assert.equal(shapeClientEvent({ type: 'response.create' }), null)
    assert.equal(shapeClientEvent({ type: 'input_audio_buffer.append' }), null)
    assert.deepEqual(shapeClientEvent({ type: 'input_audio_buffer.commit', event_id: 'e1', extra: 1 }), { type: 'input_audio_buffer.commit', event_id: 'e1' })
    assert.deepEqual(shapeClientEvent({ type: 'session.update', session: { model: 'x', audio: { input: { transcription: { model: 'whisper-1', language: 'en' } } } } }), {
      type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { model: MODELS.transcribe }, format: PCM } } }
    })
    assert.deepEqual(shapeClientEvent({ type: 'session.update', session: { audio: { input: { format: { type: 'audio/pcmu' } } } } }), {
      type: 'session.update', session: { type: 'transcription', audio: { input: { transcription: { model: MODELS.transcribe }, format: PCM } } }
    })
  })
})

describe('GET /v1/realtime', () => {
  it('proxies session.update with the forced model and format, a truncated prompt and the kept fields', async () => {
    const client = await openClient(gw, token)
    client.send({ type: 'session.update', session: { audio: { input: {
      transcription: { model: 'whisper-1', prompt: 'p'.repeat(3000), languages: ['en'], delay: 500, extra: true },
      format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' }, noise_reduction: { type: 'far_field' }
    } }, instructions: 'leak' } })
    await until(() => fake.sessionUpdates.length === 1)
    assert.deepEqual(fake.sessionUpdates[0], { type: 'session.update', session: { type: 'transcription', audio: { input: {
      transcription: { model: MODELS.transcribe, languages: ['en'], prompt: 'p'.repeat(2500), delay: 500 },
      format: PCM, turn_detection: { type: 'server_vad' }
    } } } })
    assert.equal(fake.sockets.at(-1)!.headers.authorization, 'Bearer test-openai-key')
    await until(() => client.messages.some(m => m.type === 'session.updated'))
    await client.close()
  })

  it('counts audio as it is appended (commit or not), forwards upstream events and flushes on close', async () => {
    const client = await openClient(gw, token)
    client.send(append(2))
    client.send(COMMIT)
    await until(() => client.messages.some(m => m.type === 'conversation.item.input_audio_transcription.completed'))
    assert.deepEqual(fake.appends, [128_000])
    assert.equal(fake.commits, 1)
    assert.ok(client.messages.some(m => m.type === 'input_audio_buffer.committed' && m.item_id === 'item_1'))
    client.send(append(1)) // never committed by the client (server VAD would commit it upstream), still charged
    await until(() => fake.appends.length === 2)
    await client.close()
    await until(async () => (await usage()).audioSeconds > 0)
    const u = await usage()
    assert.equal(u.audioSeconds, 3)
    assert.equal(u.days[TODAY].audioSeconds, 3)
    assert.ok(Math.abs(u.spendUsd - (3 / 3600) * 0.27) < 1e-12)
  })

  it('gives one grace window per period at the limit, then mutes with synthetic acks and no upstream audio', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { audioSeconds: HOURS_20 - 1 })
    const first = await openClient(gw, token)
    first.send(append(2)) // crosses the limit
    first.send(COMMIT)
    await until(() => first.messages.some(m => m.type === 'input_audio_buffer.committed'))
    first.send(append(2)) // over the limit: the grace window opens
    first.send(COMMIT)
    await until(() => fake.commits === 2)
    assert.equal(fake.appends.length, 2)
    await until(async () => (await usage()).graceUsedAt !== undefined)
    assert.equal((await usage()).graceUsedAt, NOW)
    await first.close()
    await until(async () => (await usage()).audioSeconds === HOURS_20 + 3)

    gw.clock.now = NOW + GRACE_MS // the window is over
    const second = await openClient(gw, token)
    second.send(append(2))
    second.send({ type: 'input_audio_buffer.commit', event_id: 'c1' })
    await until(() => second.messages.some(m => m.type === 'input_audio_buffer.committed'))
    assert.deepEqual(second.messages.filter(m => m.type === 'input_audio_buffer.committed'), [
      { type: 'input_audio_buffer.committed', event_id: 'c1', item_id: 'faangin_muted_1', previous_item_id: null }
    ])
    second.send({ type: 'input_audio_buffer.clear' })
    await until(() => second.messages.some(m => m.type === 'input_audio_buffer.cleared'))
    assert.equal(fake.appends.length, 2)
    assert.equal(fake.commits, 2)
    await second.close()
    assert.equal((await usage()).audioSeconds, HOURS_20 + 3)
  })

  it('mutes from the start when the day limit is reached and the grace window has passed', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { audioSeconds: 5 * 3600, graceUsedAt: NOW - GRACE_MS })
    const client = await openClient(gw, token)
    client.send(append(1))
    client.send(COMMIT)
    await until(() => client.messages.some(m => m.type === 'input_audio_buffer.committed'))
    assert.equal(fake.appends.length, 0)
    await client.close()
  })

  it('charges both sockets of a uid against one usage copy and one grace window', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { audioSeconds: HOURS_20 - 3 })
    const a = await openClient(gw, token)
    const b = await openClient(gw, token)
    a.send(append(2)) // HOURS_20 - 1
    await until(() => fake.appends.length === 1)
    b.send(append(2)) // HOURS_20 + 1: over, because b sees what a charged
    await until(() => fake.appends.length === 2)
    b.send(append(1)) // b opens the window
    await until(() => fake.appends.length === 3)
    await until(async () => (await usage()).graceUsedAt === NOW)
    a.send(append(1)) // a is over the limit too and shares b's window instead of starting its own
    await until(() => fake.appends.length === 4)

    gw.clock.now = NOW + GRACE_MS // the window is over for both
    a.send(append(1))
    b.send(append(1))
    a.send(COMMIT)
    b.send(COMMIT)
    await until(() => a.messages.some(muted) && b.messages.some(muted))
    assert.equal(fake.appends.length, 4)
    await a.close()
    await b.close()
    await until(async () => (await usage()).audioSeconds === HOURS_20 + 3)
    assert.equal((await usage()).graceUsedAt, NOW)
  })

  it('closes a socket that sends a message over 1 MiB with 1009 and forwards nothing', async () => {
    const client = await openClient(gw, token)
    client.send({ type: 'input_audio_buffer.append', audio: 'A'.repeat(1024 * 1024) })
    const [code] = await once(client.ws, 'close')
    assert.equal(code, 1009)
    assert.equal(fake.appends.length, 0)
  })

  it('survives a malformed frame on a socket it closed before the session started', async () => {
    gw.flags.transcriptionOff = true
    const { hostname, port } = new URL(gw.base)
    const socket = connect(Number(port), hostname)
    await once(socket, 'connect')
    let received = ''
    socket.on('data', (chunk: Buffer) => { received += chunk.toString('latin1') })
    socket.write(
      `GET /v1/realtime?intent=transcription HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`
    )
    await until(() => received.includes('\x88')) // the 1013 close frame
    socket.write(Buffer.from([0x81, 0x01, 0x41])) // an unmasked text frame: a protocol error
    await until(() => gw.logs.some(l => l.event === 'client_socket_error'))
    socket.destroy()
    assert.equal((await fetch(`${gw.base}/healthz`)).status, 200)
  })

  it('never forwards upstream error events', async () => {
    const client = await openClient(gw, token)
    client.send({ type: 'input_audio_buffer.commit' })
    await until(() => fake.commits === 1)
    fake.emitError()
    client.send({ type: 'input_audio_buffer.commit' })
    await until(() => client.messages.filter(m => m.type === 'input_audio_buffer.committed').length === 2)
    assert.ok(client.messages.every(m => m.type !== 'error'))
    assert.ok(gw.logs.some(l => l.event === 'upstream_event_error'))
    await client.close()
  })

  it('closes the client 1011 when upstream closes', async () => {
    const client = await openClient(gw, token)
    client.send({ type: 'input_audio_buffer.commit' })
    await until(() => fake.commits === 1)
    fake.sockets.at(-1)!.ws.close(1000)
    const [code] = await once(client.ws, 'close')
    assert.equal(code, 1011)
  })

  it('allows two sockets per uid and closes the third with 1008', async () => {
    const a = await openClient(gw, token)
    const b = await openClient(gw, token)
    const c = new WebSocket(`${gw.wsBase}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer ${token}` } })
    const [code] = await once(c, 'close')
    assert.equal(code, 1008)
    await a.close()
    const d = await openClient(gw, token)
    await b.close()
    await d.close()
  })

  it('closes with 1013 when transcription is switched off', async () => {
    gw.flags.transcriptionOff = true
    const ws = new WebSocket(`${gw.wsBase}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer ${token}` } })
    const [code] = await once(ws, 'close')
    assert.equal(code, 1013)
  })
})

describe('shutdown', () => {
  it('closes live sockets with 1001 and waits for their usage to reach the store', async () => {
    const client = await openClient(gw, token)
    client.send(append(2))
    await until(() => fake.appends.length === 1)
    const closed = once(client.ws, 'close')
    await gw.shutdown()
    const [code, reason] = await closed as [number, Buffer]
    assert.equal(code, 1001)
    assert.equal(reason.toString(), 'server_shutdown')
    const u = await usage()
    assert.equal(u.audioSeconds, 2)
  })
})
