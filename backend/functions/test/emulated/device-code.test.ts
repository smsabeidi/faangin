import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { call, db, http, signInTestUser, signInWithCustomToken } from './harness.js'

type StartResult = { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }
type PollResult = { status: 'pending' | 'approved' | 'expired'; customToken?: string; uid?: string }

const post = (name: string, body: unknown) =>
  http(name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const newDeviceId = () => `mac-${Math.random().toString(36).slice(2, 14)}`

async function start(deviceId = newDeviceId(), deviceName = 'Test Mac'): Promise<StartResult> {
  const res = await post('deviceCodeStart', { deviceId, deviceName })
  assert.equal(res.status, 200)
  return (await res.json()) as StartResult
}

async function poll(deviceCode: string): Promise<PollResult> {
  const res = await post('deviceCodePoll', { deviceCode })
  assert.equal(res.status, 200)
  return (await res.json()) as PollResult
}

test('full flow: start -> approve as a signed-in user -> poll -> custom token signs in as that user', async () => {
  const started = await start()
  assert.match(started.deviceCode, /^[A-Za-z0-9_-]{43}$/)
  assert.match(started.userCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/)
  assert.equal(started.verificationUrl, `https://demo-faangin.web.app/activate?code=${started.userCode}`, 'the project\'s own site')
  assert.equal(started.expiresIn, 600)
  assert.equal(started.interval, 5)

  assert.deepEqual(await poll(started.deviceCode), { status: 'pending' })

  const user = await signInTestUser()
  // Approve normalizes case, spaces and dashes.
  const approved = await call('deviceCodeApprove', { userCode: ` ${started.userCode.toLowerCase()} ` }, user.idToken)
  assert.deepEqual(approved, { ok: true, deviceName: 'Test Mac' })

  const polled = await poll(started.deviceCode)
  assert.equal(polled.status, 'approved')
  assert.equal(polled.uid, user.uid)
  assert.ok(polled.customToken)
  const session = await signInWithCustomToken(polled.customToken!)
  assert.equal(session.uid, user.uid)

  // Single use: the doc is gone, so the code now reads as expired.
  assert.deepEqual(await poll(started.deviceCode), { status: 'expired' })
  assert.equal((await db.collection('deviceCodes').doc(started.userCode.replace('-', '')).get()).exists, false)
})

test('unknown code -> not-found on approve, expired on poll', async () => {
  const user = await signInTestUser()
  await assert.rejects(call('deviceCodeApprove', { userCode: 'ZZZZ-ZZZZ' }, user.idToken), (e: { code: string }) => e.code === 'NOT_FOUND')
  assert.deepEqual(await poll('A'.repeat(43)), { status: 'expired' })
})

test('approving twice -> failed-precondition', async () => {
  const started = await start()
  const user = await signInTestUser()
  await call('deviceCodeApprove', { userCode: started.userCode }, user.idToken)
  await assert.rejects(call('deviceCodeApprove', { userCode: started.userCode }, user.idToken), (e: { code: string }) => e.code === 'FAILED_PRECONDITION')
})

test('expired code -> poll says expired, approve says not-found', async () => {
  const deviceCode = 'B'.repeat(43)
  await db.collection('deviceCodes').doc('ABCDEFGH').set({
    deviceCodeHash: createHash('sha256').update(deviceCode).digest('hex'),
    deviceId: 'mac-expired-0001',
    deviceName: 'Old Mac',
    createdAt: Date.now() - 700_000,
    expiresAt: Date.now() - 100_000,
    status: 'pending'
  })
  assert.deepEqual(await poll(deviceCode), { status: 'expired' })
  const user = await signInTestUser()
  await assert.rejects(call('deviceCodeApprove', { userCode: 'ABCD-EFGH' }, user.idToken), (e: { code: string }) => e.code === 'NOT_FOUND')
})

test('a new start replaces the pending code of the same device', async () => {
  const deviceId = newDeviceId()
  const first = await start(deviceId)
  const second = await start(deviceId)
  assert.notEqual(first.userCode, second.userCode)
  assert.deepEqual(await poll(first.deviceCode), { status: 'expired' })
  assert.deepEqual(await poll(second.deviceCode), { status: 'pending' })
  const mine = await db.collection('deviceCodes').where('deviceId', '==', deviceId).get()
  assert.equal(mine.size, 1)
})

test('input validation and method checks', async () => {
  assert.equal((await http('deviceCodeStart', { method: 'GET' })).status, 405)
  assert.equal((await http('deviceCodePoll', { method: 'GET' })).status, 405)
  assert.equal((await post('deviceCodeStart', { deviceId: 'short', deviceName: 'x' })).status, 400)
  assert.equal((await post('deviceCodeStart', { deviceId: newDeviceId(), deviceName: 'x'.repeat(65) })).status, 400)
  assert.equal((await post('deviceCodeStart', { deviceId: newDeviceId() })).status, 400)
  assert.equal((await post('deviceCodePoll', { deviceCode: 'nope' })).status, 400)
  assert.equal((await post('deviceCodePoll', {})).status, 400)
  await assert.rejects(call('deviceCodeApprove', { userCode: 'ABCD-EFGH' }), (e: { code: string }) => e.code === 'UNAUTHENTICATED')
  const user = await signInTestUser()
  await assert.rejects(call('deviceCodeApprove', { userCode: 'ABC' }, user.idToken), (e: { code: string }) => e.code === 'INVALID_ARGUMENT')
})
