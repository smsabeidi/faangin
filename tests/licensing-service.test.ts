import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CloudError } from '../src/main/faangin-cloud'
import { BillingError } from '../src/main/licensing/service'
import { CONFIG, DAY, DEVICE, deferred, harness, keyPair, makeToken, licensePayload, NOW, until } from './licensing-support'

const signedIn = { uid: 'user-1', refreshToken: 'refresh-1', provider: 'supabase' as const, supabaseUrl: CONFIG.supabaseUrl }
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_1'
const portalUrl = 'https://billing.stripe.com/p/session/test_1'

test('a build without a backend offers nothing and refuses to sign in', async t => {
  const { service, count } = harness(t, { config: null })
  await service.start()
  assert.equal(service.summary().state.kind, 'unavailable')
  await assert.rejects(service.startSignIn(), (error: unknown) => error instanceof BillingError && /not connected to an accounts service/.test(error.message))
  await assert.rejects(service.openCheckout('pro_monthly'), BillingError)
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
  assert.equal(prompt?.verificationUrl, 'http://127.0.0.1:41234/activate?code=ABCD-EFGH&lease=fixture')
  assert.deepEqual(opened, ['http://127.0.0.1:41234/activate?code=ABCD-EFGH&lease=fixture'])
  assert.equal(service.summary().state.kind, 'signed-out', 'nothing is trusted until approval')

  approval.resolve({ status: 'approved', tokenHash: 'custom-token', uid: 'user-1' })
  await until(() => service.summary().state.kind === 'active', 'an active license')
  assert.deepEqual(service.summary().state, { kind: 'active', plan: 'byok', pastDue: false, periodEnd: null, cancelAtPeriodEnd: false })
  assert.equal(service.summary().signIn, null)
  assert.equal(service.summary().error, null)
  assert.deepEqual(await store.readSession(), signedIn)
  assert.equal(await store.readLicense(), token())
  assert.equal(count('refreshAuthSession'), 0, 'the ID token from sign-in is reused for the first license request')
  assert.ok(!readFileSync(join(dir, 'account-session.bin')).toString().includes('refresh-1'))
})

test('sign-in sends this device to the server and the exchange uses the publishable key', async t => {
  const { service, calls } = harness(t)
  await service.start()
  await service.startSignIn()
  await until(() => service.summary().state.kind === 'active')
  assert.deepEqual(calls.find(call => call.name === 'startDeviceSignIn')?.args, [CONFIG.functionsBase, DEVICE, CONFIG.publishableKey])
  assert.deepEqual(calls.find(call => call.name === 'exchangeDeviceToken')?.args, [CONFIG.supabaseUrl, CONFIG.publishableKey, 'custom-token', 'user-1'])
  assert.deepEqual(calls.find(call => call.name === 'fetchLicense')?.args, [CONFIG.functionsBase, 'id-token-1', DEVICE, CONFIG.publishableKey])
})

test('the activation browser is a main-owned loopback lease and closes after cancellation', async t => {
  const waiting = deferred<unknown>()
  const { service, activation } = harness(t, { cloud: { waitForDeviceSignIn: () => waiting.promise } })
  await service.start()
  await service.startSignIn()
  assert.equal(activation.opened, 1)
  assert.match(service.summary().signIn!.verificationUrl, /^http:\/\/127\.0\.0\.1:/)
  assert.equal(service.isActivationUrl(service.summary().signIn!.verificationUrl), true)
  assert.equal(service.isActivationUrl('http://127.0.0.1:41234/anything'), false)
  service.cancelSignIn()
  assert.equal(service.isActivationUrl('http://127.0.0.1:41234/activate?code=ABCD-EFGH&lease=fixture'), false)
  waiting.resolve({ status: 'aborted' })
  await until(() => activation.closed > 0)
})

test('sign-in does not start when the OS cannot protect the credential', async t => {
  const { service, count } = harness(t, { secrets: { available: false } })
  await service.start()
  await assert.rejects(service.startSignIn(), /credential encryption is unavailable\. Unlock your system credential store/)
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
  assert.equal(count('exchangeDeviceToken'), 0)
  assert.equal(await store.readSession(), null)
})

test('an expired sign-in code says so', async t => {
  const { service, activation } = harness(t, { cloud: { waitForDeviceSignIn: async () => ({ status: 'expired' }) } })
  await service.start()
  await service.startSignIn()
  await until(() => service.summary().error !== null)
  assert.match(service.summary().error!, /code expired/)
  assert.equal(service.summary().signIn, null)
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(activation.closed, 0, 'email callbacks outlive the device code')
  assert.equal(service.isActivationUrl('http://127.0.0.1:41234/activate?code=ABCD-EFGH&lease=fixture'), false)
  await service.startSignIn()
  await until(() => activation.opened === 2 && service.summary().signIn === null)
  assert.equal(activation.closed, 1, 'a fresh sign-in cleans up the old callback')
  service.dispose()
  await until(() => activation.closed === 2)
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

test('the fourth device gets the device-limit message and keeps its sign-in but loses its stale license', async t => {
  const { service, store, token } = harness(t, { cloud: { fetchLicense: async () => { throw new CloudError('RESOURCE_EXHAUSTED', 'Up to 3 devices in 30 days', 429) } } })
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  assert.equal(service.summary().state.kind, 'active')
  await service.refresh()
  assert.match(service.summary().error!, /already active on 3 devices/)
  assert.equal(service.summary().state.kind, 'no-plan')
  assert.equal(await store.readLicense(), null)
  assert.deepEqual(await store.readSession(), signedIn)
})

test('a failed local cleanup still signs out and revokes the server session', async t => {
  const { service, store, token, count } = harness(t)
  await store.writeSession(signedIn)
  await store.writeLicense(token())
  await service.start()
  t.mock.method(store, 'clearSession', async () => { throw new Error('file locked') })
  const result = await service.signOut()
  assert.equal(result.state.kind, 'signed-out')
  assert.match(result.error!, /could not remove all saved sign-in data/)
  assert.equal(await store.readLicense(), null)
  await until(() => count('revokeAuthSession') === 1)
})

test('a rejected sign-in token signs the user out and clears what was stored', async t => {
  const { service, store, token } = harness(t, { cloud: { refreshAuthSession: async () => { throw new CloudError('refresh_token_not_found', 'Invalid Refresh Token', 400) } } })
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

test('a 5xx while refreshing the access token is offline, not a sign-out', async t => {
  const { service, store } = harness(t, { cloud: { refreshAuthSession: async () => { throw new CloudError('UNAVAILABLE', 'try later', 503) } } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.deepEqual(await store.readSession(), signedIn)
  assert.match(service.summary().error!, /Could not reach Faangin/)
})

test('a rotated refresh token is persisted', async t => {
  const { service, store } = harness(t, { cloud: { refreshAuthSession: async () => ({ uid: 'user-1', accessToken: 'id-token-9', refreshToken: 'refresh-rotated', expiresAt: NOW + 3600_000 }) } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.deepEqual(await store.readSession(), { ...signedIn, refreshToken: 'refresh-rotated' })
  assert.equal(service.summary().state.kind, 'active')
})

test('the access token is reused until it is close to expiry', async t => {
  const { service, store, clock, count } = harness(t)
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  await service.refresh()
  assert.equal(count('refreshAuthSession'), 1)
  clock.now += 56 * 60_000
  await service.refresh()
  assert.equal(count('refreshAuthSession'), 2)
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
  assert.equal(count('exchangeDeviceToken'), 0)
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
  assert.deepEqual(calls.find(entry => entry.name === 'callFunction')!.args, [CONFIG.functionsBase, 'createCheckoutSession', { plan: 'pro_monthly' }, 'id-token-2', CONFIG.publishableKey])

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
  await assert.rejects(service.openCheckout('pro_monthly'), (error: unknown) => error instanceof BillingError && /unexpected link/.test(error.message))
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
    await assert.rejects(service.openCheckout('pro_monthly'), (error: unknown) => error instanceof BillingError && expected[index]!.test(error.message) && !/stack trace/.test(error.message))
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
  await assert.rejects(service.openCheckout('pro_monthly'), /Sign in first/)
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
  await assert.rejects(service.openCheckout('pro_monthly'), /signed out/)
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

test('cancelling while device-token exchange is pending cannot save a session later', async t => {
  const exchange = deferred<unknown>()
  const { service, store, count } = harness(t, { cloud: { exchangeDeviceToken: () => exchange.promise } })
  await service.start()
  await service.startSignIn()
  await until(() => count('exchangeDeviceToken') === 1)
  service.cancelSignIn()
  exchange.resolve({ uid: 'user-1', accessToken: 'late-id', refreshToken: 'late-refresh', expiresAt: NOW + 3600_000 })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(await store.readSession(), null)
  assert.equal(count('fetchLicense'), 0)
})

test('signing out while code creation is pending prevents the late browser and polling', async t => {
  const start = deferred<unknown>()
  const { service, store, count, opened } = harness(t, { cloud: { startDeviceSignIn: () => start.promise } })
  await service.start()
  const signingIn = service.startSignIn()
  await until(() => count('startDeviceSignIn') === 1)
  await service.signOut()
  start.resolve({ deviceCode: 'late-code', userCode: 'ABCD-EFGH', expiresIn: 600, interval: 5 })
  await signingIn
  assert.deepEqual(opened, [])
  assert.equal(count('waitForDeviceSignIn'), 0)
  assert.equal(await store.readSession(), null)
})

test('a configuration error from Supabase keeps the session for recovery', async t => {
  const { service, store } = harness(t, { cloud: { refreshAuthSession: async () => { throw new CloudError('400', 'API_KEY_INVALID', 400) } } })
  await store.writeSession(signedIn)
  await service.start()
  await service.refresh()
  assert.deepEqual(await store.readSession(), signedIn)
  assert.match(service.summary().error!, /Could not reach Faangin/)
})

test('an existing BYOK license keeps the upgrade pending until the delayed Pro webhook arrives', async t => {
  const issuer = harness(t)
  let upgraded = false
  const { service, store, count } = harness(t, {
    trust: [issuer.signer.publicKeyBase64], purchaseRefreshMs: 15,
    cloud: {
      callFunction: async () => ({ url: checkoutUrl }),
      fetchLicense: async () => ({ token: issuer.token({ plan: upgraded ? 'pro' : 'byok' }), plan: upgraded ? 'pro' : 'byok', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY })
    }
  })
  await store.writeSession(signedIn)
  await service.start()
  await until(() => service.summary().state.kind === 'active')
  await service.openCheckout('pro_monthly')
  const previous = count('fetchLicense')
  service.onWindowFocus()
  await until(() => count('fetchLicense') > previous)
  assert.equal(service.summary().awaitingPurchase, true, 'the old BYOK license does not confirm a Pro purchase')
  upgraded = true
  await until(() => !service.summary().awaitingPurchase, 'background webhook reconciliation')
  assert.equal((service.summary().state as { plan?: string }).plan, 'pro')
})

test('returning from the portal refreshes cancellation even without a new Checkout purchase', async t => {
  const issuer = harness(t)
  let cancelled = false
  const { service, store } = harness(t, {
    trust: [issuer.signer.publicKeyBase64],
    cloud: {
      callFunction: async () => ({ url: portalUrl }),
      fetchLicense: async () => ({ token: issuer.token({ plan: 'pro', cancelAtPeriodEnd: cancelled }), plan: 'pro', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY })
    }
  })
  await store.writeSession(signedIn)
  await service.start()
  await until(() => service.summary().state.kind === 'active')
  await service.openPortal()
  cancelled = true
  service.onWindowFocus()
  await until(() => (service.summary().state as { cancelAtPeriodEnd?: boolean }).cancelAtPeriodEnd === true)
})

test('inference requires a verified plan when the backend is configured', async t => {
  const { service } = harness(t)
  await service.start()
  await assert.rejects(service.requireInferenceAccess(), /Sign in/)
  await service.startSignIn()
  await until(() => service.summary().state.kind === 'active')
  assert.deepEqual(await service.requireInferenceAccess(), { kind: 'byok' })
  assert.equal(await service.proAccess(), null)
  const unconfigured = harness(t, { config: null })
  assert.deepEqual(await unconfigured.service.requireInferenceAccess(), { kind: 'unconfigured' })
})

test('unpaid and expired accounts cannot request inference; BYOK grace remains available offline', async t => {
  const { service, store, clock, token } = harness(t, { cloud: { fetchLicense: async () => { throw new TypeError('offline') } } })
  await store.writeSession(signedIn)
  await service.start()
  await assert.rejects(service.requireInferenceAccess(), /Choose a plan/)
  await store.writeLicense(token())
  await service.start()
  clock.now = NOW + 31 * DAY
  assert.deepEqual(await service.requireInferenceAccess(), { kind: 'byok' })
  clock.now = NOW + 45 * DAY
  await assert.rejects(service.requireInferenceAccess(), /Check your license/)
})

test('Pro access uses the environment signing keys and never works without a configured gateway', async t => {
  const issuer = harness(t)
  const { service, store, count } = harness(t, {
    config: { ...CONFIG, gatewayBase: 'https://gateway.example.run.app', licensePublicKeys: [issuer.signer.publicKeyBase64] },
    cloud: { fetchLicense: async () => ({ token: issuer.token({ plan: 'pro' }), plan: 'pro', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY }) }
  })
  await store.writeSession(signedIn)
  await service.start()
  await until(() => service.summary().state.kind === 'active')
  const access = await service.requireInferenceAccess()
  assert.equal(access.kind, 'pro')
  assert.ok(access.kind === 'pro' && typeof access.transport.fetch === 'function')
  assert.equal(count('refreshAuthSession'), 1, 'a fresh Firebase token is used without another refresh')
  const missing = harness(t, {
    trust: [issuer.signer.publicKeyBase64],
    cloud: { fetchLicense: async () => ({ token: issuer.token({ plan: 'pro' }), plan: 'pro', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY }) }
  })
  await missing.store.writeSession(signedIn)
  await missing.service.start()
  await until(() => missing.service.summary().state.kind === 'active')
  await assert.rejects(missing.service.proAccess(), /no Pro gateway/)
})

test('legacy Firebase and other-project refresh credentials are discarded without contacting Supabase', async t => {
  for (const stored of [
    { uid: 'old-user', refreshToken: 'legacy-refresh' },
    { ...signedIn, supabaseUrl: 'https://another-project.supabase.co' }
  ]) {
    const { service, store, token, count } = harness(t)
    await store.writeSession(stored)
    await store.writeLicense(token())
    await service.start()
    assert.equal(service.summary().state.kind, 'signed-out')
    assert.equal(await store.readSession(), null)
    assert.equal(await store.readLicense(), null)
    assert.equal(count('refreshAuthSession'), 0)
  }
})

test('desktop sign-out revokes only its own Supabase session after local credentials are cleared', async t => {
  const { service, store, count, calls } = harness(t)
  await service.start()
  await service.startSignIn()
  await until(() => service.summary().state.kind === 'active')
  await service.signOut()
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(await store.readSession(), null)
  await until(() => count('revokeAuthSession') === 1)
  assert.deepEqual(calls.find(call => call.name === 'revokeAuthSession')!.args, [CONFIG.supabaseUrl, CONFIG.publishableKey, 'id-token-1'])
})

test('a rotated access token is not admitted before its refresh credential is durably saved', async t => {
  const { service, store, count } = harness(t, { cloud: { refreshAuthSession: async () => ({ uid: 'user-1', accessToken: 'next-access', refreshToken: 'next-refresh', expiresAt: NOW + 3600_000 }) } })
  await store.writeSession(signedIn)
  const persist = store.writeSession.bind(store)
  let fail = true
  store.writeSession = async session => { if (fail) { fail = false; throw new Error('storage unavailable') }; await persist(session) }
  await service.start()
  await until(() => service.summary().error !== null)
  assert.equal(count('refreshAuthSession'), 1)
  assert.equal((await store.readSession())?.refreshToken, 'refresh-1')
  await service.refresh()
  assert.equal(count('refreshAuthSession'), 2, 'the failed persistence did not publish a memoized access token')
  assert.equal((await store.readSession())?.refreshToken, 'next-refresh')
  assert.equal(service.summary().state.kind, 'active')
})
