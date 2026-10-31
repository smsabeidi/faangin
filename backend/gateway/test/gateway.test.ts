import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, before, beforeEach, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { post, proEntitlement, startFakeOpenAI, startGateway, type FakeOpenAI, type Gateway } from './support.js'

let fake: FakeOpenAI
let gw: Gateway
let n = 0
let uid: string

before(async () => {
  fake = await startFakeOpenAI()
  gw = await startGateway(fake)
})
after(async () => {
  await gw.close()
  await fake.close()
})
beforeEach(() => {
  uid = `auth${++n}`
  gw.entitlements.set(uid, proEntitlement())
  gw.flags.proSessionsOpen = true
  gw.flags.blockedUids = []
})

const body = { model: 'fast', input: 'hi' }

describe('routes', () => {
  it('GET /healthz answers ok without auth', async () => {
    const res = await fetch(`${gw.base}/healthz`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok')
  })
  it('unknown routes are 404', async () => {
    const res = await fetch(`${gw.base}/v1/other`, { headers: { authorization: `Bearer tok-${uid}` } })
    assert.equal(res.status, 404)
  })
})

describe('auth', () => {
  it('401 without a bearer token or with a bad one', async () => {
    assert.equal((await post(gw, undefined, body)).status, 401)
    const res = await post(gw, 'nope', body)
    assert.equal(res.status, 401)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'unauthorized')
  })
  it('402 no_pro without a Pro entitlement', async () => {
    gw.entitlements.set(uid, { plan: 'byok', status: 'active', updatedAt: 0 })
    const res = await post(gw, `tok-${uid}`, body)
    assert.equal(res.status, 402)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_pro')
    gw.entitlements.set(uid, proEntitlement({}, 'canceled'))
    assert.equal((await post(gw, `tok-${uid}`, body)).status, 402)
    gw.entitlements.set(uid, proEntitlement({}, 'past_due'))
    assert.equal((await post(gw, `tok-${uid}`, body)).status, 200)
  })
  it('403 when the uid is blocked', async () => {
    gw.flags.blockedUids = [uid]
    assert.equal((await post(gw, `tok-${uid}`, body)).status, 403)
  })
  it('503 pro_paused when Pro sessions are closed', async () => {
    gw.flags.proSessionsOpen = false
    const res = await post(gw, `tok-${uid}`, body)
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'pro_paused')
  })
  it('the WebSocket upgrade is refused with the same statuses', async () => {
    const ws = new WebSocket(`${gw.wsBase}/v1/realtime?intent=transcription`)
    const [error] = await once(ws, 'error')
    assert.match(String(error), /401/)
    gw.entitlements.delete(uid)
    const ws2 = new WebSocket(`${gw.wsBase}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer tok-${uid}` } })
    const [error2] = await once(ws2, 'error')
    assert.match(String(error2), /402/)
  })
})

describe('body limit', () => {
  it('answers 413 to a body over the limit even though the upload is still in flight', async () => {
    const { request } = await import('node:http')
    const status = await new Promise<{ code: number; body: string }>((resolve, reject) => {
      const req = request(`${gw.base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer tok-${uid}` } }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ code: res.statusCode ?? 0, body: text }))
      })
      req.on('error', reject)
      req.write(Buffer.alloc(1_200_000, 0x20)) // 1.2 MB of spaces: over BODY_LIMIT_BYTES before any JSON parsing
      req.end()
    })
    assert.equal(status.code, 413)
    assert.equal((JSON.parse(status.body) as { error: { code: string } }).error.code, 'body_too_large')
  })
})
