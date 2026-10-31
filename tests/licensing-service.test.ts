import assert from 'node:assert/strict'
import test from 'node:test'
import { CloudError } from '../src/main/faangin-cloud'
import { BillingError } from '../src/main/licensing/service'
import { CONFIG, DAY, DEVICE, deferred, harness, keyPair, makeToken, licensePayload, NOW, until } from './licensing-support'

const signedIn = { uid: 'user-1', refreshToken: 'refresh-1' }
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1'
const portalUrl = 'https://billing.stripe.com/p/session/test_1'

test('a build without a backend offers nothing and refuses to sign in', async t => {
  const { service, count } = harness(t, { config: null })
  await service.start()
  assert.equal(service.summary().state.kind, 'unavailable')
  await assert.rejects(service.startSignIn(), (error: unknown) => error instanceof BillingError && /not connected to an accounts service/.test(error.message))
  await assert.rejects(service.openCheckout('byok'), BillingError)
  assert.equal(count('startDeviceSignIn'), 0)
})

test('with nothing stored the app starts signed out and makes no network call', async t => {
  const { service, calls } = harness(t)
  await service.start()
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(service.summary().deviceName, 'Test Mac')
  assert.deepEqual(calls, [])
})

test('sign-in shows the code, opens the activation page, and ends with an active license', async t => {
  const approval = deferred<unknown>()
  const { service, store, opened, count, token, dir } = harness(t, { cloud: { waitForDeviceSignIn: () => approval.promise } })
  await service.start()

  const prompt = (await service.startSignIn()).signIn
  assert.equal(prompt?.userCode, 'ABCD-EFGH')
  assert.equal(prompt?.verificationUrl, 'https://faangin-staging.web.app/activate?code=ABCD-EFGH')
  assert.deepEqual(opened, ['https://faangin-staging.web.app/activate?code=ABCD-EFGH'])
  assert.equal(service.summary().state.kind, 'signed-out', 'nothing is trusted until approval')

  approval.resolve({ status: 'approved', customToken: 'custom-token', uid: 'user-1' })
  await until(() => service.summary().state.kind === 'active', 'an active license')
  assert.deepEqual(service.summary().state, { kind: 'active', plan: 'byok', pastDue: false, periodEnd: null, cancelAtPeriodEnd: false })
  assert.equal(service.summary().signIn, null)
  assert.equal(service.summary().error, null)
  assert.deepEqual(await store.readSession(), signedIn)
  assert.equal(await store.readLicense(), token())
  assert.equal(count('refreshIdToken'), 0, 'the ID token from sign-in is reused for the first license request')
  assert.ok(!(await import('node:fs')).readFileSync(`${dir}/account-session.bin`).toString().includes('refresh-1'))
})

test('sign-in sends this device to the server and the exchange uses the web API key', async t => {
  const { service, calls } = harness(t)
  await service.start()
  await service.startSignIn()
  await until(() => service.summary().state.kind === 'active')
  assert.deepEqual(calls.find(call => call.name === 'startDeviceSignIn')?.args, [CONFIG.functionsBase, DEVICE])
  assert.deepEqual(calls.find(call => call.name === 'exchangeCustomToken')?.args, ['web-key', 'custom-token', undefined])
  assert.deepEqual(calls.find(call => call.name === 'fetchLicense')?.args, [CONFIG.functionsBase, 'id-token-1', DEVICE])
})

test('a verification link outside the activation page is never opened or polled', async t => {
  const { service, opened, count } = harness(t, { cloud: { startDeviceSignIn: async () => ({ deviceCode: 'd', userCode: 'ABCD-EFGH', verificationUrl: 'https://evil.example/activate?code=ABCD-EFGH', expiresIn: 600, interval: 5 }) } })
  await service.start()
  await assert.rejects(service.startSignIn(), (error: unknown) => error instanceof BillingError && /unexpected link/.test(error.message))
  assert.deepEqual(opened, [])
  assert.equal(count('waitForDeviceSignIn'), 0)
  assert.equal(service.summary().signIn, null)
})

test('sign-in does not start when the OS cannot protect the credential', async t => {
  const { service, count } = harness(t, { secrets: { available: false } })
  await service.start()
  await assert.rejects(service.startSignIn(), /credential encryption is unavailable/)
  assert.equal(count('startDeviceSignIn'), 0)
})

test('an unreachable service on sign-in start is a plain, retryable message', async t => {
  const { service } = harness(t, { cloud: { startDeviceSignIn: async () => { throw new TypeError('fetch failed') } } })
  await service.start()
  await assert.rejects(service.startSignIn(), /could not reach the accounts service/)
  assert.equal(service.summary().signIn, null)
})

test('cancelling sign-in stops polling and leaves no error or session', async t => {
  const { service, store, count } = harness(t, {
    cloud: { waitForDeviceSignIn: (_base: string, _start: unknown, options: { signal: AbortSignal }) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ status: 'aborted' }))) }
  })
  await service.start()
  await service.startSignIn()
  assert.ok(service.summary().signIn)
  const summary = service.cancelSignIn()
  assert.equal(summary.signIn, null)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(service.summary().error, null)
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(count('exchangeCustomToken'), 0)
  assert.equal(await store.readSession(), null)
})

test('an expired sign-in code says so', async t => {
  const { service } = harness(t, { cloud: { waitForDeviceSignIn: async () => ({ status: 'expired' }) } })
  await service.start()
  await service.startSignIn()
  await until(() => service.summary().error !== null)
  assert.match(service.summary().error!, /code expired/)
  assert.equal(service.summary().signIn, null)
  assert.equal(service.summary().state.kind, 'signed-out')
})

test('a signed-in account with no purchase is no-plan, quietly, and a stale license is removed', async t => {
  const failure = new CloudError('FAILED_PRECONDITION', 'No active plan', 400)
  const { service, store, token } = harness(t, { cloud: { fetchLicense: async () => { throw failure } } })
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  assert.equal(service.summary().state.kind, 'active', 'the stored license is trusted until the server says otherwise')
  await service.refresh()
  assert.deepEqual(service.summary().state, { kind: 'no-plan' })
  assert.equal(service.summary().error, null)
  assert.equal(await store.readLicense(), null)
})

test('the fourth device gets the device-limit message and keeps its sign-in', async t => {
  const { service, store } = harness(t, { cloud: { fetchLicense: async () => { throw new CloudError('RESOURCE_EXHAUSTED', 'Up to 3 devices in 30 days', 429) } } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.match(service.summary().error!, /already active on 3 devices/)
  assert.equal(service.summary().state.kind, 'no-plan')
  assert.deepEqual(await store.readSession(), signedIn)
})

test('a rejected sign-in token signs the user out and clears what was stored', async t => {
  const { service, store, token } = harness(t, { cloud: { refreshIdToken: async () => { throw new CloudError('INVALID_ARGUMENT', 'TOKEN_EXPIRED', 400) } } })
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  await service.refresh()
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.match(service.summary().error!, /signed out/)
  assert.equal(await store.readSession(), null)
  assert.equal(await store.readLicense(), null)
})

test('an unauthenticated license call is treated the same way', async t => {
  const { service, store } = harness(t, { cloud: { fetchLicense: async () => { throw new CloudError('UNAUTHENTICATED', 'Sign in first', 401) } } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(await store.readSession(), null)
})

test('offline, a working license keeps working and a background check stays quiet', async t => {
  const { service, store, token } = harness(t, { cloud: { fetchLicense: async () => { throw new TypeError('fetch failed') } } })
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  await service.refresh({ background: true })
  assert.equal(service.summary().state.kind, 'active')
  assert.equal(service.summary().error, null)
  await service.refresh()
  assert.equal(service.summary().state.kind, 'active')
  assert.match(service.summary().error!, /keeps working offline/)
})

test('a 5xx while minting the ID token is offline, not a sign-out', async t => {
  const { service, store } = harness(t, { cloud: { refreshIdToken: async () => { throw new CloudError('UNAVAILABLE', 'try later', 503) } } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.deepEqual(await store.readSession(), signedIn)
  assert.match(service.summary().error!, /Could not reach Faangin/)
})

test('a rotated refresh token is persisted', async t => {
  const { service, store } = harness(t, { cloud: { refreshIdToken: async () => ({ uid: 'user-1', idToken: 'id-token-9', refreshToken: 'refresh-rotated', expiresAt: NOW + 3600_000 }) } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.deepEqual(await store.readSession(), { uid: 'user-1', refreshToken: 'refresh-rotated' })
  assert.equal(service.summary().state.kind, 'active')
})

test('the ID token is reused until it is close to expiry', async t => {
  const { service, store, clock, count } = harness(t)
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  await service.refresh()
  assert.equal(count('refreshIdToken'), 1)
  clock.now += 56 * 60_000
  await service.refresh()
  assert.equal(count('refreshIdToken'), 2)
})

test('a license the build cannot verify is rejected and never stored', async t => {
  const stranger = keyPair()
  const { service, store } = harness(t, { cloud: { fetchLicense: async () => ({ token: makeToken(licensePayload(NOW), stranger.privateKey), plan: 'byok', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY }) } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.match(service.summary().error!, /could not verify the license/)
  assert.equal(await store.readLicense(), null)
  assert.equal(service.summary().state.kind, 'no-plan')
})

test('a placeholder key set verifies nothing', async t => {
  const { service, store } = harness(t, { trust: ['REPLACE_WITH_CURRENT_LICENSE_PUBLIC_KEY'] })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.match(service.summary().error!, /could not verify the license/)
  assert.equal(await store.readLicense(), null)
})

test('a license issued for another device or account is rejected', async t => {
  const other = harness(t)
  const wrongDevice = other.token({ deviceId: 'b'.repeat(64) })
  const wrongUser = other.token({ uid: 'user-2' })
  for (const bad of [wrongDevice, wrongUser]) {
    const { service, store } = harness(t, { cloud: { fetchLicense: async () => ({ token: bad, plan: 'byok', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY }) }, trust: [other.signer.publicKeyBase64] })
    await store.writeSession(signedIn)
    await service.start()
    await service.refresh()
    assert.match(service.summary().error!, /could not verify the license/)
    assert.equal(await store.readLicense(), null)
  }
})

test('a stored license for another device does not entitle this one', async t => {
  const { service, store, token } = harness(t, { cloud: { fetchLicense: async () => { throw new TypeError('fetch failed') } } })
  await store.writeSession(signedIn)
  await store.writeLicense(token({ deviceId: 'c'.repeat(64) }))
  await service.start()
  assert.equal(service.summary().state.kind, 'locked')
})

test('past 30 days the license is in grace; past grace it is locked until it refreshes', async t => {
  const { service, store, token, clock } = harness(t, { cloud: { fetchLicense: async () => { throw new TypeError('fetch failed') } } })
  const issuedAt = NOW
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  assert.equal(service.summary().state.kind, 'active')
  clock.now = issuedAt + 31 * DAY
  assert.deepEqual(service.summary().state, { kind: 'grace', plan: 'byok', graceUntil: issuedAt + 44 * DAY })
  clock.now = issuedAt + 45 * DAY
  assert.equal(service.summary().state.kind, 'locked')
})

test('starting up signed in refreshes the license in the background', async t => {
  const { service, store, count } = harness(t)
  await store.writeSession(signedIn)
  await service.start()
  await until(() => service.summary().state.kind === 'active', 'the launch refresh')
  assert.equal(count('fetchLicense'), 1)
})

test('sign-out removes the session and license and abandons a pending sign-in', async t => {
  const { service, store, token, count } = harness(t, {
    cloud: { waitForDeviceSignIn: (_base: string, _start: unknown, options: { signal: AbortSignal }) => new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ status: 'aborted' }))) }
  })
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  await service.startSignIn()
  const summary = await service.signOut()
  assert.equal(summary.state.kind, 'signed-out')
  assert.equal(summary.signIn, null)
  assert.equal(await store.readSession(), null)
  assert.equal(await store.readLicense(), null)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(count('exchangeCustomToken'), 0)
})

test('Checkout opens only Stripe and marks the purchase as awaited; focus checks are rate limited', async t => {
  const { service, store, opened, calls, count, clock } = harness(t, {
    cloud: {
      callFunction: async () => ({ url: checkoutUrl }),
      fetchLicense: async () => { throw new CloudError('FAILED_PRECONDITION', 'No active plan', 400) }
    }
  })
  await store.writeSession(signedIn)
  await service.start()
  await until(() => count('fetchLicense') === 1, 'the launch refresh')
  assert.equal(service.summary().state.kind, 'no-plan')

  const summary = await service.openCheckout('pro_monthly')
  assert.deepEqual(opened, [checkoutUrl])
  assert.equal(summary.awaitingPurchase, true)
  assert.deepEqual(calls.find(entry => entry.name === 'callFunction')!.args, [CONFIG.functionsBase, 'createCheckoutSession', { plan: 'pro_monthly' }, 'id-token-2'])

  service.onWindowFocus()
  await until(() => count('fetchLicense') === 2, 'the focus check')
  service.onWindowFocus()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(count('fetchLicense'), 2, 'a second focus within ten seconds does nothing')
  clock.now += 11_000
  service.onWindowFocus()
  await until(() => count('fetchLicense') === 3, 'the next focus check')
})

test('focus checks do nothing unless a purchase is awaited and someone is signed in', async t => {
  const { service, store, count } = harness(t)
  await service.start()
  service.onWindowFocus()
  await store.writeSession(signedIn)
  await service.start()
  await until(() => count('fetchLicense') === 1, 'the launch refresh')
  service.onWindowFocus()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(count('fetchLicense'), 1)
})

test('after paying, the next focus check turns no-plan into an active Pro license', async t => {
  const first = harness(t)
  let paid = false
  const { service, store, clock, count, opened } = harness(t, {
    trust: [first.signer.publicKeyBase64],
    cloud: {
      callFunction: async () => ({ url: checkoutUrl }),
      fetchLicense: async () => {
        if (!paid) throw new CloudError('FAILED_PRECONDITION', 'No active plan', 400)
        return { token: first.token({ plan: 'pro', periodEnd: NOW + 30 * DAY }), plan: 'pro', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY }
      }
    }
  })
  await store.writeSession(signedIn)
  await service.start()
  await until(() => count('fetchLicense') === 1)
  await service.openCheckout('pro_annual')
  assert.deepEqual(opened, [checkoutUrl])
  assert.equal(service.summary().awaitingPurchase, true)

  paid = true
  clock.now += 11_000
  service.onWindowFocus()
  await until(() => service.summary().state.kind === 'active', 'the paid license')
  assert.deepEqual(service.summary().state, { kind: 'active', plan: 'pro', pastDue: false, periodEnd: NOW + 30 * DAY, cancelAtPeriodEnd: false })
  assert.equal(service.summary().awaitingPurchase, false)
  assert.equal(await store.readLicense(), first.token({ plan: 'pro', periodEnd: NOW + 30 * DAY }))
})

test('a checkout link that is not Stripe is refused and nothing is opened', async t => {
  const { service, store, opened } = harness(t, { cloud: { callFunction: async () => ({ url: 'https://evil.example/pay' }) } })
  await store.writeSession(signedIn)
  await service.start()
  await assert.rejects(service.openCheckout('byok'), (error: unknown) => error instanceof BillingError && /unexpected link/.test(error.message))
  assert.deepEqual(opened, [])
  assert.equal(service.summary().awaitingPurchase, false)
})

test('the server explains why Checkout is unavailable; other failures stay generic', async t => {
  const reasons: CloudError[] = [new CloudError('FAILED_PRECONDITION', 'You already own the BYOK license.', 400), new CloudError('INTERNAL', 'stack trace at /srv/functions/checkout.js:42', 500)]
  const expected = [/already own the BYOK license/, /Checkout could not be started/]
  for (const [index, reason] of reasons.entries()) {
    const { service, store } = harness(t, { cloud: { callFunction: async () => { throw reason } } })
    await store.writeSession(signedIn)
    await service.start()
    await assert.rejects(service.openCheckout('byok'), (error: unknown) => error instanceof BillingError && expected[index]!.test(error.message) && !/stack trace/.test(error.message))
  }
})

test('an unknown plan is refused before any request', async t => {
  const { service, store, count } = harness(t)
  await store.writeSession(signedIn)
  await service.start()
  await assert.rejects(service.openCheckout('enterprise' as never), /Unknown plan/)
  assert.equal(count('callFunction'), 0)
})

test('Checkout and the portal need a sign-in', async t => {
  const { service } = harness(t)
  await service.start()
  await assert.rejects(service.openCheckout('byok'), /Sign in first/)
  await assert.rejects(service.openPortal(), /Sign in first/)
})

test('the portal opens only Stripe’s billing page', async t => {
  const links = [portalUrl, checkoutUrl]
  const { service, store, opened } = harness(t, { cloud: { callFunction: async () => ({ url: links.shift() }) } })
  await store.writeSession(signedIn)
  await service.start()
  await service.openPortal()
  assert.deepEqual(opened, [portalUrl])
  await assert.rejects(service.openPortal(), /unexpected link/)
  assert.deepEqual(opened, [portalUrl])
})

test('a revoked session found while opening Checkout signs the user out', async t => {
  const { service, store, token } = harness(t, { cloud: { callFunction: async () => { throw new CloudError('UNAUTHENTICATED', 'expired', 401) } } })
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  await assert.rejects(service.openCheckout('byok'), /signed out/)
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(await store.readSession(), null)
})

test('every state change is announced to the UI', async t => {
  const { service, store, changes } = harness(t)
  await store.writeSession(signedIn)
  await service.start()
  await until(() => service.summary().state.kind === 'active')
  assert.ok(changes.length >= 3, 'loaded, busy and finished')
  assert.equal(changes.at(-1)?.state.kind, 'active')
  assert.ok(changes.some(summary => summary.busy))
  assert.equal(changes.at(-1)?.busy, false)
})
