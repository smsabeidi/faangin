import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifiedLicense } from '../src/main/faangin-cloud'
import { deriveLicenseState } from '../src/main/licensing/state'
import { DAY, NOW, licensePayload } from './licensing-support'

const verified = (overrides: Partial<VerifiedLicense> = {}): VerifiedLicense => ({ ...licensePayload(NOW), inGrace: false, ...overrides })
const base = { configured: true, signedIn: true, hasToken: true, verified: verified() }

test('a build without a backend is unavailable, whatever else is stored', () => {
  assert.deepEqual(deriveLicenseState({ ...base, configured: false }), { kind: 'unavailable' })
})

test('signed out wins over a stored license', () => {
  assert.deepEqual(deriveLicenseState({ ...base, signedIn: false }), { kind: 'signed-out' })
})

test('a verified BYOK license is active with no period', () => {
  assert.deepEqual(deriveLicenseState(base), { kind: 'active', plan: 'byok', pastDue: false, periodEnd: null, cancelAtPeriodEnd: false })
})

test('a Pro license carries its period end and cancellation flag', () => {
  const periodEnd = NOW + 20 * DAY
  assert.deepEqual(
    deriveLicenseState({ ...base, verified: verified({ plan: 'pro', periodEnd, cancelAtPeriodEnd: true }) }),
    { kind: 'active', plan: 'pro', pastDue: false, periodEnd, cancelAtPeriodEnd: true }
  )
})

test('past_due still entitles and is reported as such', () => {
  assert.deepEqual(deriveLicenseState({ ...base, verified: verified({ plan: 'pro', status: 'past_due' }) }), { kind: 'active', plan: 'pro', pastDue: true, periodEnd: null, cancelAtPeriodEnd: false })
})

test('past exp but before grace is the grace state, ending at grace', () => {
  const license = verified({ inGrace: true, exp: NOW - DAY, grace: NOW + 13 * DAY })
  assert.deepEqual(deriveLicenseState({ ...base, verified: license }), { kind: 'grace', plan: 'byok', graceUntil: NOW + 13 * DAY })
})

test('a stored token that no longer verifies is locked; no token at all is no plan', () => {
  assert.deepEqual(deriveLicenseState({ ...base, verified: null }), { kind: 'locked' })
  assert.deepEqual(deriveLicenseState({ ...base, verified: null, hasToken: false }), { kind: 'no-plan' })
})
