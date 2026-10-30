import assert from 'node:assert/strict'
import test from 'node:test'
import type { Entitlement, LicenseTokenPayload } from '../src/shared/billing-types'
import type { CachedEntitlement } from '../src/main/licensing/entitlement-cache'
import { deriveLicenseState, isLicenseUsable } from '../src/main/licensing/state'

const NOW = 1_780_000_000

function makeEntitlement(patch: Partial<Entitlement> = {}): Entitlement {
  return {
    uid: 'uid-1',
    plan: 'pro_monthly',
    status: 'active',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    currentPeriodEnd: NOW + 30 * 86400,
    graceUntil: NOW + 44 * 86400,
    devices: [{ deviceId: 'a'.repeat(64), label: 'Mac', activatedAt: NOW - 86400, lastSeenAt: NOW }],
    createdAt: NOW - 2 * 86400,
    updatedAt: NOW - 86400,
    ...patch,
  }
}

function makeCached(patch: Partial<CachedEntitlement> = {}): CachedEntitlement {
  return {
    entitlement: makeEntitlement(),
    licenseToken: 'header.payload.signature',
    licenseExpiresAt: NOW + 30 * 86400,
    graceUntil: NOW + 44 * 86400,
    ...patch,
  }
}

function makePayload(patch: Partial<LicenseTokenPayload> = {}): LicenseTokenPayload {
  return {
    iss: 'faangin-license-v1',
    aud: 'faangin-app',
    sub: 'uid-1',
    iat: NOW - 86400,
    exp: NOW + 30 * 86400,
    nbf: NOW - 86400 - 60,
    jti: 'jti-1',
    plan: 'pro_monthly',
    status: 'active',
    deviceId: 'a'.repeat(64),
    periodEnd: NOW + 30 * 86400,
    graceUntil: NOW + 44 * 86400,
    ...patch,
  }
}

test('derives "none" when nothing is cached', () => {
  const s = deriveLicenseState({ now: NOW, cached: null, verifiedPayload: null })
  assert.equal(s.kind, 'none')
})

test('derives "active" when the verified token is within exp', () => {
  const s = deriveLicenseState({ now: NOW, cached: makeCached(), verifiedPayload: makePayload() })
  assert.equal(s.kind, 'active')
  if (s.kind === 'active') assert.equal(s.plan, 'pro_monthly')
})

test('just before exp is still active', () => {
  const payload = makePayload({ exp: NOW + 60 })
  const cached = makeCached({ licenseExpiresAt: NOW + 60 })
  const s = deriveLicenseState({ now: NOW, cached, verifiedPayload: payload })
  assert.equal(s.kind, 'active')
})

test('right at exp falls into grace', () => {
  const payload = makePayload({ exp: NOW })
  const cached = makeCached({ licenseExpiresAt: NOW, graceUntil: NOW + 7 * 86400 })
  const s = deriveLicenseState({ now: NOW, cached, verifiedPayload: payload })
  assert.equal(s.kind, 'grace')
})

test('within grace window with no verified payload is grace', () => {
  const cached = makeCached({ licenseExpiresAt: NOW - 86400, graceUntil: NOW + 10 * 86400 })
  const s = deriveLicenseState({ now: NOW, cached, verifiedPayload: null })
  assert.equal(s.kind, 'grace')
})

test('past grace is expired', () => {
  const cached = makeCached({ licenseExpiresAt: NOW - 100 * 86400, graceUntil: NOW - 1 })
  const s = deriveLicenseState({ now: NOW, cached, verifiedPayload: null })
  assert.equal(s.kind, 'expired')
})

test('revoked when jti is on the revocation list', () => {
  const payload = makePayload()
  const s = deriveLicenseState({ now: NOW, cached: makeCached(), verifiedPayload: payload, revokedJtis: [payload.jti] })
  assert.equal(s.kind, 'revoked')
})

test('revoked when the entitlement status is canceled', () => {
  const s = deriveLicenseState({ now: NOW, cached: makeCached({ entitlement: makeEntitlement({ status: 'canceled' }) }), verifiedPayload: makePayload() })
  assert.equal(s.kind, 'revoked')
})

test('revoked beats active when both apply', () => {
  const payload = makePayload()
  const cached = makeCached({ entitlement: makeEntitlement({ status: 'refunded' }) })
  const s = deriveLicenseState({ now: NOW, cached, verifiedPayload: payload, revokedJtis: [] })
  assert.equal(s.kind, 'revoked')
})

test('isLicenseUsable is true for active and grace, false otherwise', () => {
  assert.equal(isLicenseUsable({ kind: 'none' }), false)
  assert.equal(isLicenseUsable({ kind: 'active', plan: 'byok', renewsAt: NOW }), true)
  assert.equal(isLicenseUsable({ kind: 'grace', plan: 'pro_monthly', graceUntil: NOW }), true)
  assert.equal(isLicenseUsable({ kind: 'expired', plan: 'byok' }), false)
  assert.equal(isLicenseUsable({ kind: 'revoked' }), false)
})

test('inside grace with revoked status prefers revoked', () => {
  const cached = makeCached({
    entitlement: makeEntitlement({ status: 'disputed' }),
    licenseExpiresAt: NOW - 86400,
    graceUntil: NOW + 10 * 86400,
  })
  const s = deriveLicenseState({ now: NOW, cached, verifiedPayload: null })
  assert.equal(s.kind, 'revoked')
})
