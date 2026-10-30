import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backendOrigin, joinBackend } from '../src/shared/billing-storage'
import { DeviceIdentity } from '../src/main/licensing/device-identity'
import { LicenseKeyCache, isLicensePublicKey } from '../src/main/licensing/key-cache'
import { refreshOnce, startLicenseRefresh } from '../src/main/licensing/refresh'
import * as ed from '@noble/ed25519'
import { bytesToBase64Url, signLicenseTokenForTesting } from '../src/main/licensing/verify'
import type { Entitlement, LicensePublicKey } from '../src/shared/billing-types'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'faangin-lic-'))
}

test('backendOrigin falls back to localhost emulator when env is missing', () => {
  assert.equal(backendOrigin({}), 'http://localhost:5001')
})

test('backendOrigin normalises trailing slashes', () => {
  assert.equal(backendOrigin({ FAANGIN_BACKEND_ORIGIN: 'https://api.example.com/v1/' }), 'https://api.example.com/v1')
})

test('backendOrigin ignores malformed input', () => {
  assert.equal(backendOrigin({ FAANGIN_BACKEND_ORIGIN: 'not a url' }), 'http://localhost:5001')
})

test('joinBackend concatenates origin and path safely', () => {
  assert.equal(joinBackend('http://localhost:5001', '/billing/refreshLicense'), 'http://localhost:5001/billing/refreshLicense')
  assert.equal(joinBackend('http://localhost:5001/', 'billing/refreshLicense'), 'http://localhost:5001/billing/refreshLicense')
})

test('DeviceIdentity produces a 64-hex deviceId derived from stable inputs', async () => {
  const dir = makeTempDir()
  try {
    const identity = new DeviceIdentity({ userDataPath: dir, hostname: 'test-host', machineId: 'MAC-ID', nowSeconds: () => 100 })
    const first = await identity.getDescriptor()
    assert.match(first.deviceId, /^[0-9a-f]{64}$/)
    const second = await identity.getDescriptor()
    assert.equal(second.deviceId, first.deviceId)
    assert.ok(second.lastSeenAt >= first.lastSeenAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DeviceIdentity persists its salt so different runs match', async () => {
  const dir = makeTempDir()
  try {
    const first = await new DeviceIdentity({ userDataPath: dir, hostname: 'host', machineId: 'id' }).getDescriptor()
    const second = await new DeviceIdentity({ userDataPath: dir, hostname: 'host', machineId: 'id' }).getDescriptor()
    assert.equal(second.deviceId, first.deviceId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LicenseKeyCache serves the baked key when offline', async () => {
  const dir = makeTempDir()
  try {
    const fetchImpl: typeof fetch = async () => { throw new Error('offline') }
    const cache = new LicenseKeyCache({ userDataPath: dir, origin: 'http://localhost:5001', fetchImpl })
    const key = await cache.getPublicKey('dev-placeholder-v1')
    assert.ok(key)
    assert.equal(key.kid, 'dev-placeholder-v1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LicenseKeyCache refreshes and persists a new kid', async () => {
  const dir = makeTempDir()
  try {
    const freshKey: LicensePublicKey = { kid: 'kid-prod-1', alg: 'EdDSA', publicKey: 'B'.repeat(43) }
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ keys: [freshKey] }), { status: 200, headers: { 'content-type': 'application/json' } })
    const cache = new LicenseKeyCache({ userDataPath: dir, origin: 'http://localhost:5001', fetchImpl })
    const key = await cache.getPublicKey('kid-prod-1')
    assert.ok(key)
    assert.equal(key.publicKey, freshKey.publicKey)
    const warm = new LicenseKeyCache({ userDataPath: dir, origin: 'http://localhost:5001', fetchImpl: async () => { throw new Error('offline') } })
    const warmKey = await warm.getPublicKey('kid-prod-1')
    assert.ok(warmKey, 'warm cache should hit disk-persisted key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isLicensePublicKey rejects malformed input', () => {
  assert.equal(isLicensePublicKey(null), false)
  assert.equal(isLicensePublicKey({ kid: 'x' }), false)
  assert.equal(isLicensePublicKey({ kid: 'x', alg: 'RS256', publicKey: 'y' }), false)
  assert.equal(isLicensePublicKey({ kid: 'x', alg: 'EdDSA', publicKey: 'y' }), true)
})

test('refreshOnce skips when there is no cached entitlement', async () => {
  const outcome = await refreshOnce({
    keyCache: {} as never,
    entitlementCache: { load: async () => null, save: async () => {} },
    getCurrentState: async () => ({ kind: 'none' }),
  })
  assert.equal(outcome.kind, 'skipped')
})

test('refreshOnce reports an error on malformed response', async () => {
  const outcome = await refreshOnce({
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
    keyCache: { getPublicKey: async () => null, refreshPublicKeys: async () => true } as never,
    entitlementCache: {
      load: async () => ({ entitlement: fakeEntitlement(), licenseToken: 't', licenseExpiresAt: 1, graceUntil: 2 }),
      save: async () => {},
    },
    getCurrentState: async () => ({ kind: 'active', plan: 'pro_monthly', renewsAt: 1 }),
  })
  assert.equal(outcome.kind, 'error')
})

test('refreshOnce writes a verified refreshed token to the cache', async () => {
  const privateKey = ed.utils.randomPrivateKey()
  const pubBytes = await ed.getPublicKeyAsync(privateKey)
  const publicKey: LicensePublicKey = { kid: 'kid-ref-1', alg: 'EdDSA', publicKey: bytesToBase64Url(pubBytes) }
  const now = Math.floor(Date.now() / 1000)
  const deviceId = 'd'.repeat(64)
  const token = await signLicenseTokenForTesting({
    iss: 'faangin-license-v1', aud: 'faangin-app', sub: 'uid-1',
    iat: now, exp: now + 86400, nbf: now - 60, jti: 'jti-ref',
    plan: 'pro_monthly', status: 'active', deviceId,
    periodEnd: now + 86400, graceUntil: now + 86400,
  }, privateKey, publicKey.kid)

  let saved: unknown = null
  const outcome = await refreshOnce({
    fetchImpl: async () => new Response(JSON.stringify({ licenseToken: token, entitlement: fakeEntitlement() }), { status: 200, headers: { 'content-type': 'application/json' } }),
    keyCache: { getPublicKey: async () => publicKey, refreshPublicKeys: async () => true } as never,
    entitlementCache: {
      load: async () => ({ entitlement: fakeEntitlement(), licenseToken: 'stale', licenseExpiresAt: now, graceUntil: now }),
      save: async cached => { saved = cached },
    },
    getCurrentState: async () => ({ kind: 'active', plan: 'pro_monthly', renewsAt: now + 100 }),
  })
  assert.equal(outcome.kind, 'refreshed')
  assert.ok(saved)
})

test('startLicenseRefresh schedules a tick and can be stopped', async () => {
  const timers: Array<{ cb: () => void; delay: number; cleared: boolean }> = []
  const setTimeoutImpl = ((cb: () => void, delay: number) => {
    const handle = { cb, delay, cleared: false }
    timers.push(handle)
    return handle as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  const clearTimeoutImpl = ((handle: unknown) => { (handle as { cleared: boolean }).cleared = true }) as unknown as typeof clearTimeout

  const handle = startLicenseRefresh({
    keyCache: { getPublicKey: async () => null, refreshPublicKeys: async () => true } as never,
    entitlementCache: { load: async () => null, save: async () => {} },
    getCurrentState: async () => ({ kind: 'none' }),
    setTimeoutImpl,
    clearTimeoutImpl,
  })
  assert.equal(timers.length, 1)
  handle.stop()
  assert.ok(timers[0].cleared)
})

function fakeEntitlement(): Entitlement {
  const now = Math.floor(Date.now() / 1000)
  return {
    uid: 'uid-1', plan: 'pro_monthly', status: 'active', stripeCustomerId: 'cus_1',
    currentPeriodEnd: now + 86400, graceUntil: now + 2 * 86400, devices: [],
    createdAt: now, updatedAt: now,
  }
}
