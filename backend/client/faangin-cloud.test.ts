// Run from gateway/ (tsx and ws resolve there): node --import tsx --test ../client/*.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { WebSocketServer } from 'ws'
import {
  CloudError, callFunction, exchangeDeviceToken, proTransport, refreshAuthSession, rewriteOpenAiUrl,
  verifyLicense, verifyLicenseWithKeys, waitForDeviceSignIn, type LicensePayload
} from './faangin-cloud.js'

// --- helpers -----------------------------------------------------------------------------------------------------

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}

/** Builds a token exactly like functions/src/license/sign.ts: v1.<b64url payload JSON>.<b64url Ed25519 sig over the payload bytes>. */
function makeToken(payload: object, privateKey: KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload))
  return `v1.${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`
}

const DAY = 24 * 3600 * 1000
const NOW = 1_800_000_000_000
const PAYLOAD: LicensePayload = { v: 1, uid: 'user-1', plan: 'pro', status: 'active', iat: NOW, exp: NOW + 30 * DAY, grace: NOW + 44 * DAY, deviceId: 'device-aaaaaaaa', periodEnd: NOW + 31 * DAY, rampUntil: NOW + 14 * DAY, cancelAtPeriodEnd: false }

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: string }

/** Local HTTP server; `handler` returns the JSON answer (and optional status) for each recorded request. */
async function localServer(handler: (r: Recorded) => { status?: number; body: unknown }) {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(recorded)
      const answer = handler(recorded)
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, base, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

// --- verifyLicense ------------------------------------------------------------------------------------------------

test('verifyLicense: round trip returns the payload and inGrace=false before exp', () => {
  const { privateKey, publicKeyBase64 } = keyPair()
  const verified = verifyLicense(makeToken(PAYLOAD, privateKey), publicKeyBase64, NOW + DAY)
  assert.ok(verified)
  assert.deepEqual(verified, { ...PAYLOAD, inGrace: false })
})

test('verifyLicense: tampered payload, wrong key, wrong version and garbage are rejected', () => {
  const { privateKey, publicKeyBase64 } = keyPair()
  const token = makeToken(PAYLOAD, privateKey)
  const [version, , signature] = token.split('.')
  const tampered = `${version}.${Buffer.from(JSON.stringify({ ...PAYLOAD, plan: 'byok', uid: 'someone-else' })).toString('base64url')}.${signature}`
  assert.equal(verifyLicense(tampered, publicKeyBase64, NOW), null)
  assert.equal(verifyLicense(token, keyPair().publicKeyBase64, NOW), null)
  assert.equal(verifyLicense(token.replace(/^v1/, 'v2'), publicKeyBase64, NOW), null)
  assert.equal(verifyLicense('not-a-token', publicKeyBase64, NOW), null)
  assert.equal(verifyLicense('', publicKeyBase64, NOW), null)
  assert.equal(verifyLicense(token, 'not-a-key', NOW), null)
  assert.equal(verifyLicense(makeToken({ ...PAYLOAD, v: 2 }, privateKey), publicKeyBase64, NOW), null)
})

test('verifyLicense: grace window — valid with inGrace after exp, null at and after grace', () => {
  const { privateKey, publicKeyBase64 } = keyPair()
  const token = makeToken(PAYLOAD, privateKey)
  assert.equal(verifyLicense(token, publicKeyBase64, PAYLOAD.exp - 1)?.inGrace, false)
  assert.equal(verifyLicense(token, publicKeyBase64, PAYLOAD.exp)?.inGrace, true)
  assert.equal(verifyLicense(token, publicKeyBase64, PAYLOAD.grace - 1)?.inGrace, true)
  assert.equal(verifyLicense(token, publicKeyBase64, PAYLOAD.grace), null)
  assert.equal(verifyLicense(token, publicKeyBase64, PAYLOAD.grace + DAY), null)
})

test('verifyLicenseWithKeys: finds the matching key among several (rotation)', () => {
  const current = keyPair(), next = keyPair()
  const token = makeToken(PAYLOAD, next.privateKey)
  assert.equal(verifyLicenseWithKeys(token, NOW, [current.publicKeyBase64, next.publicKeyBase64])?.uid, 'user-1')
  assert.equal(verifyLicenseWithKeys(token, NOW, [current.publicKeyBase64]), null)
  assert.equal(verifyLicenseWithKeys(token, NOW, []), null)
})

// --- proTransport -------------------------------------------------------------------------------------------------

test('rewriteOpenAiUrl: OpenAI http/ws URLs move to the gateway, others are untouched', () => {
  assert.equal(rewriteOpenAiUrl('https://api.openai.com/v1/responses', 'https://gw.example.run.app/'), 'https://gw.example.run.app/v1/responses')
  assert.equal(rewriteOpenAiUrl('wss://api.openai.com/v1/realtime?intent=transcription', 'https://gw.example.run.app'), 'wss://gw.example.run.app/v1/realtime?intent=transcription')
  assert.equal(rewriteOpenAiUrl('wss://api.openai.com/v1/realtime?intent=transcription', 'http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/v1/realtime?intent=transcription')
  assert.equal(rewriteOpenAiUrl('https://example.com/v1/responses', 'https://gw.example.run.app'), 'https://example.com/v1/responses')
  assert.equal(rewriteOpenAiUrl('https://api.openai.com.evil.com/v1/responses', 'https://gw.example.run.app'), 'https://api.openai.com.evil.com/v1/responses')
})

test('proTransport.fetch: rewrites the URL, replaces Authorization, keeps method/body/other headers', async () => {
  const server = await localServer(r => ({ body: { echoed: r.body } }))
  try {
    const transport = proTransport(() => 'id-token-1', server.base)
    const response = await transport.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-real-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast', input: 'hi' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { echoed: JSON.stringify({ model: 'fast', input: 'hi' }) })
    const [seen] = server.requests
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/v1/responses')
    assert.equal(seen.headers.authorization, 'Bearer id-token-1')
    assert.equal(seen.headers['content-type'], 'application/json')

    // A URL object works too, and the token getter is consulted on every call.
    const transport2 = proTransport(() => 'id-token-2', server.base)
    await transport2.fetch(new URL('https://api.openai.com/v1/responses?x=1'), { method: 'POST', body: '{}' })
    assert.equal(server.requests[1].url, '/v1/responses?x=1')
    assert.equal(server.requests[1].headers.authorization, 'Bearer id-token-2')

    // Non-OpenAI URLs pass through with their own Authorization header.
    await transport.fetch(`${server.base}/elsewhere`, { headers: { Authorization: 'Bearer other' } })
    assert.equal(server.requests[2].url, '/elsewhere')
    assert.equal(server.requests[2].headers.authorization, 'Bearer other')
  } finally {
    await server.close()
  }
})

test('proTransport.createWebSocket: rewrites wss URL and sends exactly one Authorization header', async () => {
  const seen: { url?: string; authorization?: string }[] = []
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (socket, req) => { seen.push({ url: req.url, authorization: req.headers.authorization }); socket.close() })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  try {
    const transport = proTransport(() => 'id-token-ws', base)
    // Both spellings must be replaced, never duplicated (Node would join duplicates with ", ").
    const socket = transport.createWebSocket('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { authorization: 'Bearer sk-real', Authorization: 'Bearer sk-real' }, handshakeTimeout: 5_000 })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    await new Promise<void>(resolve => socket.once('close', () => resolve()))
    assert.deepEqual(seen, [{ url: '/v1/realtime?intent=transcription', authorization: 'Bearer id-token-ws' }])
  } finally {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>(resolve => wss.close(() => http.close(() => resolve())))
  }
})

// --- device sign-in, auth REST, callables -------------------------------------------------------------------------

test('waitForDeviceSignIn: polls until approved, honours the interval, reports expired and aborted', async () => {
  let polls = 0
  const server = await localServer(r => {
    assert.equal(r.url, '/deviceCodePoll')
    assert.deepEqual(JSON.parse(r.body), { deviceCode: 'dc-1' })
    polls += 1
    return { body: polls < 3 ? { status: 'pending' } : { status: 'approved', tokenHash: 'custom-1', uid: 'user-1' } }
  })
  try {
    const result = await waitForDeviceSignIn(server.base, { deviceCode: 'dc-1', interval: 0, expiresIn: 600 })
    assert.deepEqual(result, { status: 'approved', tokenHash: 'custom-1', uid: 'user-1' })
    assert.equal(polls, 3)

    polls = 0
    const controller = new AbortController()
    const pending = waitForDeviceSignIn(server.base, { deviceCode: 'dc-1', interval: 60, expiresIn: 600 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    assert.deepEqual(await pending, { status: 'aborted' })
    assert.equal(polls, 1)

    assert.deepEqual(await waitForDeviceSignIn(server.base, { deviceCode: 'dc-1', interval: 60, expiresIn: 0 }), { status: 'expired' })
  } finally {
    await server.close()
  }
})

test('waitForDeviceSignIn: a server-side expired answer ends the wait', async () => {
  const server = await localServer(() => ({ body: { status: 'expired' } }))
  try {
    assert.deepEqual(await waitForDeviceSignIn(server.base, { deviceCode: 'dc-1', interval: 60, expiresIn: 600 }), { status: 'expired' })
  } finally {
    await server.close()
  }
})

test('device approval gets a separate Supabase session, verifies the user, and refreshes JSON credentials', async () => {
  const server = await localServer(r => {
    assert.equal(r.headers.apikey, 'sb_publishable_fixture')
    if (r.url === '/auth/v1/verify') return { body: { access_token: 'desktop-access', refresh_token: 'desktop-refresh', expires_in: 3600, user: { id: 'user-7' } } }
    if (r.url === '/auth/v1/user') { assert.equal(r.headers.authorization, 'Bearer desktop-access'); return { body: { id: 'user-7' } } }
    if (r.url === '/auth/v1/token?grant_type=refresh_token') return { body: { access_token: 'desktop-next', refresh_token: 'refresh-rotated', expires_in: 3600, user: { id: 'user-7' } } }
    return { status: 404, body: {} }
  })
  try {
    const before = Date.now()
    const session = await exchangeDeviceToken(server.base, 'sb_publishable_fixture', 'single-use-hash', 'user-7')
    assert.equal(session.uid, 'user-7')
    assert.equal(session.accessToken, 'desktop-access')
    assert.equal(session.refreshToken, 'desktop-refresh')
    assert.ok(session.expiresAt >= before + 3_600_000 && session.expiresAt <= Date.now() + 3_600_000)
    assert.deepEqual(JSON.parse(server.requests[0].body), { token_hash: 'single-use-hash', type: 'email' })
    const next = await refreshAuthSession(server.base, 'sb_publishable_fixture', session.refreshToken)
    assert.equal(next.refreshToken, 'refresh-rotated')
    assert.equal(server.requests[2].headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(server.requests[2].body), { refresh_token: 'desktop-refresh' })
    await assert.rejects(exchangeDeviceToken(server.base, 'sb_publishable_fixture', 'hash', 'different-user'), (error: unknown) => error instanceof CloudError && error.code === 'UNAUTHENTICATED')
  } finally { await server.close() }
})

test('callFunction: sends {data} with the access token, unwraps result, maps HttpsError to CloudError', async () => {
  const server = await localServer(r => {
    if (r.headers.authorization !== 'Bearer id-1') return { status: 401, body: { error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' } } }
    if (r.url === '/issueLicense') return { status: 400, body: { error: { message: 'Buy a plan first.', status: 'FAILED_PRECONDITION' } } }
    return { body: { result: { ok: true, echo: JSON.parse(r.body).data } } }
  })
  try {
    assert.deepEqual(await callFunction(server.base, 'anything', { a: 1 }, 'id-1', 'sb_publishable_fixture'), { ok: true, echo: { a: 1 } })
    await assert.rejects(callFunction(server.base, 'issueLicense', {}, 'id-1', 'sb_publishable_fixture'), (error: unknown) => error instanceof CloudError && error.code === 'FAILED_PRECONDITION' && error.message === 'Buy a plan first.' && error.status === 400)
    await assert.rejects(callFunction(server.base, 'anything', {}, 'wrong', 'sb_publishable_fixture'), (error: unknown) => error instanceof CloudError && error.code === 'UNAUTHENTICATED')
  } finally {
    await server.close()
  }
})

test('verifyLicense: signed but malformed, revoked or future-issued payloads do not grant access', () => {
  const { privateKey, publicKeyBase64 } = keyPair()
  const invalid = [
    { plan: 'enterprise' }, { status: 'revoked' }, { uid: '' }, { deviceId: '' },
    { iat: NOW + DAY }, { exp: NOW - 1 }, { grace: PAYLOAD.exp - 1 },
    { iat: null }, { exp: 'tomorrow' }, { periodEnd: 'tomorrow' }, { cancelAtPeriodEnd: 'false' }
  ]
  for (const fields of invalid) {
    assert.equal(verifyLicense(makeToken({ ...PAYLOAD, ...fields }, privateKey), publicKeyBase64, NOW), null, JSON.stringify(fields))
  }
})

test('proTransport.fetch preserves a Request body, method and signal while replacing provider credentials', async () => {
  const server = await localServer(r => ({ body: { echoed: r.body } }))
  try {
    const abort = new AbortController()
    const request = new Request('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer sk-provider', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'smart', input: 'hello' }), signal: abort.signal
    })
    const response = await proTransport(() => 'supabase-token', server.base).fetch(request)
    assert.equal(response.status, 200)
    assert.equal(server.requests[0].method, 'POST')
    assert.equal(server.requests[0].body, JSON.stringify({ model: 'smart', input: 'hello' }))
    assert.equal(server.requests[0].headers.authorization, 'Bearer supabase-token')
    abort.abort()
    await assert.rejects(proTransport(() => 'supabase-token', server.base).fetch(new Request('https://api.openai.com/v1/responses', { signal: abort.signal })), { name: 'AbortError' })
  } finally {
    await server.close()
  }
})

test('cancelling a sign-in aborts an in-flight poll request', async () => {
  let requestStarted!: () => void
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  const server = createServer(() => { requestStarted() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const abort = new AbortController()
  try {
    const result = waitForDeviceSignIn(base, { deviceCode: 'pending-code', expiresIn: 600, interval: 5 }, { signal: abort.signal })
    await started
    abort.abort()
    assert.deepEqual(await result, { status: 'aborted' })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
