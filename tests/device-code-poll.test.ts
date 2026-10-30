import assert from 'node:assert/strict'
import test from 'node:test'
import * as ed from '@noble/ed25519'
import type { DeviceCodePollStatus, Entitlement, LicensePublicKey } from '../src/shared/billing-types'
import { DeviceCodeClient } from '../src/main/licensing/device-code'
import { bytesToBase64Url, signLicenseTokenForTesting } from '../src/main/licensing/verify'
import type { CachedEntitlement } from '../src/main/licensing/entitlement-cache'

interface FakeKeyCache {
  getPublicKey: (kid: string) => Promise<LicensePublicKey | null>
  refreshPublicKeys: () => Promise<boolean>
}

function makeEntitlement(deviceId: string): Entitlement {
  const now = Math.floor(Date.now() / 1000)
  return {
    uid: 'uid-1',
    plan: 'pro_monthly',
    status: 'active',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    currentPeriodEnd: now + 30 * 86400,
    graceUntil: now + 44 * 86400,
    devices: [{ deviceId, label: 'Mac', activatedAt: now, lastSeenAt: now }],
    createdAt: now,
    updatedAt: now,
  }
}

async function makeHarness(options: { statuses: DeviceCodePollStatus[] }) {
  const privateKey = ed.utils.randomPrivateKey()
  const pubBytes = await ed.getPublicKeyAsync(privateKey)
  const publicKey: LicensePublicKey = { kid: 'kid-1', alg: 'EdDSA', publicKey: bytesToBase64Url(pubBytes) }
  const now = Math.floor(Date.now() / 1000)
  const deviceId = 'd'.repeat(64)
  const token = await signLicenseTokenForTesting({
    iss: 'faangin-license-v1',
    aud: 'faangin-app',
    sub: 'uid-1',
    iat: now,
    exp: now + 30 * 86400,
    nbf: now - 60,
    jti: 'jti-1',
    plan: 'pro_monthly',
    status: 'active',
    deviceId,
    periodEnd: now + 30 * 86400,
    graceUntil: now + 44 * 86400,
  }, privateKey, publicKey.kid)

  const statuses = [...options.statuses].map(s => (s.status === 'success' ? { ...s, licenseToken: token, entitlement: makeEntitlement(deviceId) } : s))
  const calls: string[] = []
  const fetches: Array<RequestInit | undefined> = []

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push(url)
    fetches.push(init)
    if (url.endsWith('/billing/startDeviceCode')) {
      return new Response(JSON.stringify({
        deviceCode: 'DEVICE', userCode: 'ABCD-1234',
        verificationUri: 'https://faangin.app/sign-in',
        verificationUriComplete: 'https://faangin.app/sign-in?user_code=ABCD-1234',
        expiresIn: 600, interval: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/billing/pollDeviceCode')) {
      const next = statuses.shift() ?? { status: 'pending' as const }
      return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }

  const saved: CachedEntitlement[] = []

  const client = new DeviceCodeClient({
    origin: 'http://localhost:5001',
    fetchImpl,
    keyCache: {
      getPublicKey: async (kid: string) => (kid === publicKey.kid ? publicKey : null),
      refreshPublicKeys: async () => true,
    } as unknown as FakeKeyCache as never,
    entitlementCache: { save: async (cached: CachedEntitlement) => { saved.push(cached) } },
    getDevice: async () => ({ deviceId, label: 'Mac', activatedAt: now, lastSeenAt: now }),
    nowSeconds: () => now,
  })

  return { client, calls, fetches, saved, token, publicKey }
}

test('start returns the DeviceCodeStart payload', async () => {
  const h = await makeHarness({ statuses: [{ status: 'pending' }] })
  const start = await h.client.start()
  assert.equal(start.userCode, 'ABCD-1234')
  assert.equal(h.calls[0], 'http://localhost:5001/billing/startDeviceCode')
})

test('poll succeeds and saves the verified entitlement', async () => {
  const h = await makeHarness({
    statuses: [
      { status: 'pending' },
      { status: 'success' } as DeviceCodePollStatus,
    ],
  })
  const sleeps: number[] = []
  const result = await h.client.poll('DEVICE', {
    intervalMs: 1000,
    sleep: async ms => { sleeps.push(ms) },
  })
  assert.equal(result.outcome, 'success')
  if (result.outcome === 'success') assert.equal(result.state.kind, 'active')
  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0]?.licenseToken, h.token)
  assert.ok(sleeps.length >= 2)
})

test('poll respects slow_down backoff and later succeeds', async () => {
  const h = await makeHarness({
    statuses: [
      { status: 'slow_down', interval: 10 },
      { status: 'pending' },
      { status: 'success' } as DeviceCodePollStatus,
    ],
  })
  const sleeps: number[] = []
  const result = await h.client.poll('DEVICE', { intervalMs: 1000, sleep: async ms => { sleeps.push(ms) } })
  assert.equal(result.outcome, 'success')
  // slow_down should have pushed the interval to at least max(current, interval*1000, current+5000)
  assert.ok(sleeps.some(ms => ms >= 10_000), `expected a sleep ≥10s after slow_down, got ${sleeps.join(',')}`)
})

test('poll returns denied for a denied status', async () => {
  const h = await makeHarness({ statuses: [{ status: 'denied' }] })
  const result = await h.client.poll('DEVICE', { intervalMs: 1000, sleep: async () => {} })
  assert.equal(result.outcome, 'denied')
})

test('poll returns expired for an expired status', async () => {
  const h = await makeHarness({ statuses: [{ status: 'expired' }] })
  const result = await h.client.poll('DEVICE', { intervalMs: 1000, sleep: async () => {} })
  assert.equal(result.outcome, 'expired')
})

test('poll returns aborted when the signal is already aborted', async () => {
  const h = await makeHarness({ statuses: [] })
  const controller = new AbortController()
  controller.abort()
  const result = await h.client.poll('DEVICE', { intervalMs: 1000, sleep: async () => {}, signal: controller.signal })
  assert.equal(result.outcome, 'aborted')
})

test('poll returns denied when the server returns a success with a bad token', async () => {
  // Build a harness where "success" has a signature we overwrite with junk.
  const privateKey = ed.utils.randomPrivateKey()
  const pubBytes = await ed.getPublicKeyAsync(privateKey)
  const publicKey: LicensePublicKey = { kid: 'kid-2', alg: 'EdDSA', publicKey: bytesToBase64Url(pubBytes) }
  const deviceId = 'd'.repeat(64)
  const now = Math.floor(Date.now() / 1000)
  const token = await signLicenseTokenForTesting({
    iss: 'faangin-license-v1', aud: 'faangin-app', sub: 'uid-1',
    iat: now, exp: now + 86400, nbf: now - 60, jti: 'jti-x',
    plan: 'pro_monthly', status: 'active', deviceId,
    periodEnd: now + 86400, graceUntil: now + 86400,
  }, privateKey, publicKey.kid)
  const parts = token.split('.')
  const junk = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`
  const saved: CachedEntitlement[] = []
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    status: 'success', licenseToken: junk, entitlement: makeEntitlement(deviceId),
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const client = new DeviceCodeClient({
    origin: 'http://localhost:5001', fetchImpl,
    keyCache: { getPublicKey: async (kid: string) => (kid === publicKey.kid ? publicKey : null), refreshPublicKeys: async () => true } as unknown as FakeKeyCache as never,
    entitlementCache: { save: async (cached: CachedEntitlement) => { saved.push(cached) } },
    getDevice: async () => ({ deviceId, label: 'Mac', activatedAt: now, lastSeenAt: now }),
    nowSeconds: () => now,
  })

  const result = await client.poll('DEVICE', { intervalMs: 1000, sleep: async () => {} })
  assert.equal(result.outcome, 'denied')
  assert.equal(saved.length, 0)
})
