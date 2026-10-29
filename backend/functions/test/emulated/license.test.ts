import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { licenseState, verifyLicense } from '../../src/license/sign.js'
import { call, db, signInTestUser } from './harness.js'

type LicenseResult = { token: string; plan: string; status: string; expiresAt: number; graceUntil: number }

// functions/.secret.local is written by scripts/dev-secrets.mjs as KEY=VALUE lines.
const secrets = Object.fromEntries(
  readFileSync(new URL('../../.secret.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
)
const PUBLIC_KEY = secrets.LICENSE_PUBLIC_KEY
assert.ok(PUBLIC_KEY, 'LICENSE_PUBLIC_KEY missing from functions/.secret.local')

const DAY_MS = 24 * 60 * 60 * 1000
const entitle = (uid: string, data: Record<string, unknown>) =>
  db.collection('entitlements').doc(uid).set({ ...data, updatedAt: Date.now() })
const issue = (idToken: string, deviceId: string, deviceName = 'Test Mac') =>
  call<LicenseResult>('issueLicense', { deviceId, deviceName }, idToken)
const code = (expected: string) => (e: { code: string }) => e.code === expected

test('active byok -> token verifies with the dev public key', async () => {
  const user = await signInTestUser()
  await entitle(user.uid, { plan: 'byok', status: 'active' })
  const before = Date.now()
  const result = await issue(user.idToken, 'mac-byok-00001', 'Studio Mac')

  assert.equal(result.plan, 'byok')
  assert.equal(result.status, 'active')
  const payload = verifyLicense(result.token, PUBLIC_KEY)
  assert.ok(payload, 'token must verify')
  assert.equal(payload.v, 1)
  assert.equal(payload.uid, user.uid)
  assert.equal(payload.plan, 'byok')
  assert.equal(payload.status, 'active')
  assert.equal(payload.deviceId, 'mac-byok-00001')
  assert.ok(payload.iat >= before && payload.iat <= Date.now())
  assert.equal(payload.exp - payload.iat, 30 * DAY_MS)
  assert.equal(payload.grace - payload.exp, 14 * DAY_MS)
  assert.equal(result.expiresAt, payload.exp)
  assert.equal(result.graceUntil, payload.grace)
  assert.equal(payload.periodEnd, undefined)
  assert.equal(licenseState(payload, Date.now()), 'valid')
  assert.equal(verifyLicense(result.token.slice(0, -4) + 'AAAA', PUBLIC_KEY), null)

  const device = await db.collection('devices').doc(user.uid).collection('items').doc('mac-byok-00001').get()
  assert.equal(device.get('name'), 'Studio Mac')
  assert.equal(device.get('firstSeenAt'), device.get('lastSeenAt'))
  assert.equal(device.get('lastLicenseAt'), device.get('lastSeenAt'))
})

test('active pro -> token carries the period fields', async () => {
  const user = await signInTestUser()
  const now = Date.now()
  await entitle(user.uid, {
    plan: 'pro', status: 'past_due',
    pro: { status: 'past_due', subscriptionId: 'sub_test', priceLookupKey: 'faangin_pro_monthly', startedAt: now, currentPeriodStart: now, currentPeriodEnd: now + 30 * DAY_MS, cancelAtPeriodEnd: true, rampUntil: now + 14 * DAY_MS }
  })
  const result = await issue(user.idToken, 'mac-pro-000001')
  assert.equal(result.plan, 'pro')
  assert.equal(result.status, 'past_due')
  const payload = verifyLicense(result.token, PUBLIC_KEY)
  assert.ok(payload)
  assert.equal(payload.periodEnd, now + 30 * DAY_MS)
  assert.equal(payload.rampUntil, now + 14 * DAY_MS)
  assert.equal(payload.cancelAtPeriodEnd, true)
})

test('plan none -> failed-precondition', async () => {
  const user = await signInTestUser()
  await assert.rejects(issue(user.idToken, 'mac-none-00001'), code('FAILED_PRECONDITION'))
  await entitle(user.uid, { plan: 'none', status: 'active' })
  await assert.rejects(issue(user.idToken, 'mac-none-00001'), code('FAILED_PRECONDITION'))
})

test('revoked byok -> failed-precondition', async () => {
  const user = await signInTestUser()
  await entitle(user.uid, { plan: 'byok', status: 'revoked', reason: 'refund' })
  await assert.rejects(issue(user.idToken, 'mac-revoked-01'), code('FAILED_PRECONDITION'))
})

test('canceled pro -> failed-precondition', async () => {
  const user = await signInTestUser()
  await entitle(user.uid, { plan: 'pro', status: 'canceled' })
  await assert.rejects(issue(user.idToken, 'mac-canceled-1'), code('FAILED_PRECONDITION'))
})

test('device cap: the fourth new device in 30 days gets resource-exhausted, known devices still renew', async () => {
  const user = await signInTestUser()
  await entitle(user.uid, { plan: 'byok', status: 'active' })
  await issue(user.idToken, 'mac-cap-000001')
  await issue(user.idToken, 'mac-cap-000002')
  await issue(user.idToken, 'mac-cap-000003')
  await assert.rejects(issue(user.idToken, 'mac-cap-000004'), code('RESOURCE_EXHAUSTED'))
  const renewed = await issue(user.idToken, 'mac-cap-000001', 'Renamed Mac')
  assert.ok(verifyLicense(renewed.token, PUBLIC_KEY))
  const items = await db.collection('devices').doc(user.uid).collection('items').get()
  assert.equal(items.size, 3)

  // A device last seen outside the window no longer counts.
  await db.collection('devices').doc(user.uid).collection('items').doc('mac-cap-000003').update({ lastSeenAt: Date.now() - 31 * DAY_MS })
  await issue(user.idToken, 'mac-cap-000004')
  await assert.rejects(issue(user.idToken, 'mac-cap-000005'), code('RESOURCE_EXHAUSTED'))
})

test('auth and input validation', async () => {
  await assert.rejects(issue('', 'mac-auth-00001'), code('UNAUTHENTICATED'))
  const user = await signInTestUser()
  await entitle(user.uid, { plan: 'byok', status: 'active' })
  await assert.rejects(issue(user.idToken, 'short'), code('INVALID_ARGUMENT'))
  await assert.rejects(issue(user.idToken, 'mac-auth-00001', ''), code('INVALID_ARGUMENT'))
  await assert.rejects(issue(user.idToken, 'mac-auth-00001', 'x'.repeat(65)), code('INVALID_ARGUMENT'))
})
