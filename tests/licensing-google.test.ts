import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CloudError, exchangeOAuthCode, type AuthSession } from '../src/main/faangin-cloud'
import { GOOGLE_AUTH_REDIRECT } from '../src/main/licensing/auth-redirect'
import { CONFIG, DEVICE, NOW, deferred, harness, until } from './licensing-support'

const callback = `${GOOGLE_AUTH_REDIRECT}?code=supabase-code`

test('Google sign-in opens Supabase with S256 and resumes from an encrypted verifier after restart', async t => {
  const { service, createService, store, dir, opened, calls, count, clock } = harness(t)
  await service.start()
  assert.equal((await service.startGoogleSignIn()).googleSignInPending, true)
  assert.equal(opened.length, 1)
  const authorize = new URL(opened[0])
  const pending = await store.readGoogleSignIn()
  assert.ok(pending)
  assert.equal(authorize.origin + authorize.pathname, `${CONFIG.supabaseUrl}/auth/v1/authorize`)
  assert.equal(authorize.searchParams.get('redirect_to'), GOOGLE_AUTH_REDIRECT)
  assert.equal(authorize.searchParams.get('provider'), 'google')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 's256')
  assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(pending.verifier).digest('base64url'))
  assert.ok(!opened[0].includes(pending.verifier))
  assert.ok(!(await readFile(join(dir, 'google-sign-in.bin'))).includes(pending.verifier))

  service.dispose()
  const relaunched = createService()
  t.after(() => relaunched.dispose())
  await relaunched.start()
  assert.equal(relaunched.summary().googleSignInPending, true)
  await Promise.all([relaunched.handleGoogleCallback(callback), relaunched.handleGoogleCallback(callback)])
  assert.equal(relaunched.summary().state.kind, 'active')
  assert.equal(relaunched.summary().googleSignInPending, false)
  assert.equal(await store.readGoogleSignIn(), null)
  assert.equal(count('exchangeOAuthCode'), 1)
  assert.deepEqual(calls.find(call => call.name === 'exchangeOAuthCode')?.args, [CONFIG.supabaseUrl, CONFIG.publishableKey, 'supabase-code', pending.verifier])
  assert.deepEqual(calls.find(call => call.name === 'fetchLicense')?.args, [CONFIG.functionsBase, 'id-token-1', DEVICE, CONFIG.publishableKey])
  assert.equal(count('startDeviceSignIn'), 0)
  assert.equal((await store.readSession())?.uid, 'user-1')
  assert.ok(!(await readFile(join(dir, 'account-session.bin'))).includes('refresh-1'))

  clock.now += 56 * 60_000
  await relaunched.refresh()
  assert.equal(count('refreshAuthSession'), 1)
  await relaunched.signOut()
  assert.equal(await store.readSession(), null)
  assert.deepEqual(calls.find(call => call.name === 'revokeAuthSession')?.args, [CONFIG.supabaseUrl, CONFIG.publishableKey, 'id-token-2'])
})

test('malformed, implicit and unsolicited callbacks cannot exchange a code', async t => {
  const { service, count } = harness(t)
  await service.start()
  await service.handleGoogleCallback(callback)
  await service.startGoogleSignIn()
  for (const raw of [
    'faangin://auth/other?code=supabase-code',
    `${callback}&code=duplicate`,
    `${callback}&error=access_denied`,
    `${callback}#access_token=unexpected`,
    `${GOOGLE_AUTH_REDIRECT}#code=fragment-code`,
    `${GOOGLE_AUTH_REDIRECT}?code=%0a`
  ]) await service.handleGoogleCallback(raw)
  assert.equal(count('exchangeOAuthCode'), 0)
  assert.equal(service.summary().googleSignInPending, true)
})

test('Google cancellation and expiry remove the verifier and keep email available', async t => {
  const { service, store, count, clock } = harness(t)
  await service.start()
  await service.startGoogleSignIn()
  await service.handleGoogleCallback(`${GOOGLE_AUTH_REDIRECT}?error=access_denied#error=access_denied&sb=`)
  assert.match(service.summary().error!, /cancelled/)
  assert.equal(await store.readGoogleSignIn(), null)

  await service.startGoogleSignIn()
  clock.now += 11 * 60_000
  await service.handleGoogleCallback(callback)
  assert.match(service.summary().error!, /expired/)
  assert.equal(count('exchangeOAuthCode'), 0)
  assert.equal(await store.readGoogleSignIn(), null)

  await service.startGoogleSignIn()
  await service.startSignIn()
  assert.equal(await store.readGoogleSignIn(), null)
  assert.equal(service.summary().googleSignInPending, false)
  await until(() => service.summary().state.kind === 'active')
})

test('cancelling during exchange discards and revokes the resulting session', async t => {
  const exchange = deferred<AuthSession>()
  const { service, store, count } = harness(t, { cloud: { exchangeOAuthCode: () => exchange.promise } })
  await service.start()
  await service.startGoogleSignIn()
  const handling = service.handleGoogleCallback(callback)
  await until(() => count('exchangeOAuthCode') === 1)
  await service.cancelGoogleSignIn()
  exchange.resolve({ uid: 'user-1', accessToken: 'discard', refreshToken: 'discard', expiresAt: NOW + 3600_000 })
  await handling
  assert.equal(service.summary().state.kind, 'signed-out')
  assert.equal(await store.readSession(), null)
  assert.equal(await store.readGoogleSignIn(), null)
  assert.equal(count('revokeAuthSession'), 1)
})

test('a rejected OAuth exchange is retryable and never installs a session', async t => {
  const { service, store } = harness(t, { cloud: { exchangeOAuthCode: async () => { throw new CloudError('bad_code_verifier', 'secret detail', 400) } } })
  await service.start()
  await service.startGoogleSignIn()
  await service.handleGoogleCallback(callback)
  assert.match(service.summary().error!, /could not finish/)
  assert.equal(service.summary().googleSignInPending, false)
  assert.equal(await store.readSession(), null)
  assert.equal(await store.readGoogleSignIn(), null)
  assert.equal((await service.startGoogleSignIn()).googleSignInPending, true)
})

test('Google sign-in refuses to open without OS credential encryption', async t => {
  const { service, store, opened } = harness(t, { secrets: { available: false } })
  await service.start()
  await assert.rejects(service.startGoogleSignIn(), /credential encryption is unavailable/)
  assert.deepEqual(opened, [])
  assert.equal(await store.readGoogleSignIn(), null)
})

test('OAuth exchange sends only the public key, authorization code and verifier to Supabase', async t => {
  const session = { user: { id: 'user-1' }, access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, `${CONFIG.supabaseUrl}/auth/v1/token?grant_type=pkce`)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, { 'content-type': 'application/json', apikey: CONFIG.publishableKey })
    assert.deepEqual(JSON.parse(String(options.body)), { auth_code: 'the-code', code_verifier: 'the-verifier' })
    return Response.json({ ...session, provider_token: 'discarded-google-token' })
  })
  const { expiresAt, ...received } = await exchangeOAuthCode(CONFIG.supabaseUrl, CONFIG.publishableKey, 'the-code', 'the-verifier')
  assert.ok(expiresAt > Date.now())
  assert.deepEqual(received, { uid: 'user-1', accessToken: 'access', refreshToken: 'refresh' })
  assert.equal(fetch.mock.callCount(), 1)
})
