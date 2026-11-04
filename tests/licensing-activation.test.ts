import assert from 'node:assert/strict'
import test from 'node:test'
import { request as httpRequest } from 'node:http'
import { createContext, Script } from 'node:vm'
import { startActivationServer } from '../src/main/licensing/activation-server'

const options = { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', functionsBase: 'https://fixture.supabase.co/functions/v1/faangin-api', userCode: 'ABCD-EFGH', deviceName: '<script>unexpected</script>', expiresAt: Date.now() + 60_000 }

test('activation lease binds only loopback, protects its page with a nonce CSP and never stores browser tokens', async t => {
  const lease = await startActivationServer(options)
  t.after(() => lease.close())
  const url = new URL(lease.url)
  assert.equal(url.hostname, '127.0.0.1')
  assert.match(url.searchParams.get('lease')!, /^[A-Za-z0-9_-]{32}$/)
  const response = await fetch(lease.url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  const nonce = /script-src 'nonce-([^']+)'/.exec(response.headers.get('content-security-policy')!)?.[1]
  assert.ok(nonce)
  assert.match(response.headers.get('content-security-policy')!, /connect-src https:\/\/fixture\.supabase\.co;.*frame-ancestors 'none'/)
  const html = await response.text()
  assert.ok(html.includes(`<script nonce="${nonce}">`))
  assert.ok(html.includes('&lt;script&gt;unexpected&lt;/script&gt;'))
  assert.ok(!html.includes('<script>unexpected</script>'))
  assert.match(html, /Approve this device/)
  assert.ok(!/\bMac\b/.test(html), 'the page copy names no operating system')
  assert.ok(!/localStorage|sessionStorage|refresh_token|service_role|sb_secret_/.test(html))
  assert.match(html, /deviceCodeApprove/)
  assert.match(html, /logout\?scope=local/)
  new Script(/<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1])
  const wrongLease = new URL(lease.url); wrongLease.searchParams.set('lease', 'wrong')
  assert.equal((await fetch(wrongLease)).status, 404)
  assert.equal((await fetch(lease.url, { method: 'POST', body: 'not accepted' })).status, 405)
  const wrongHost = await new Promise<number>(resolve => {
    const request = httpRequest(lease.url, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode!) })
    request.end()
  })
  assert.equal(wrongHost, 403)
  await lease.close()
  await lease.close()
  await assert.rejects(fetch(lease.url))
})

test('the callback page remains reachable after the device code expires so email links can finish', async t => {
  const lease = await startActivationServer({ ...options, expiresAt: Date.now() + 30 })
  t.after(() => lease.close())
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await fetch(lease.url)).status, 200)
  await lease.close()
  await assert.rejects(fetch(lease.url))
})

// Execute the actual served browser script against its public DOM and Auth HTTP contract.
// The callback token only exists inside this VM; nothing is stored by the loopback server.
async function browser(t: test.TestContext, input: { hash?: string; expiresAt?: number; respond?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const expiresAt = input.expiresAt ?? Date.now() + 600_000
  const lease = await startActivationServer({ ...options, expiresAt })
  t.after(() => lease.close())
  const html = await (await fetch(lease.url)).text()
  const source = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1]
  type Element = { hidden: boolean; disabled: boolean; value: string; textContent: string; onclick?: () => void; listeners: Map<string, (event: { preventDefault(): void }) => void>; classList: { toggle(): void }; addEventListener(type: string, callback: (event: { preventDefault(): void }) => void): void; reportValidity(): boolean }
  const elements = new Map<string, Element>()
  for (const id of ['status', 'expiry', 'identity', 'instructions', 'user-code', 'login', 'recovery', 'approval', 'email', 'password', 'new-password', 'submit', 'signup', 'reset', 'google', 'approve', 'different']) {
    const listeners = new Map()
    elements.set(id, { hidden: ['expiry', 'recovery', 'approval', 'google'].includes(id), disabled: false, value: '', textContent: '', listeners, classList: { toggle() {} }, addEventListener(type, callback) { listeners.set(type, callback) }, reportValidity: () => true })
  }
  const buttons = ['submit', 'signup', 'reset', 'google', 'approve', 'different'].map(id => elements.get(id)!)
  const calls: Array<{ url: string; init?: RequestInit }> = [], location = new URL(lease.url + (input.hash ?? ''))
  let now = Date.now()
  const timers: Array<{ run: () => void; at: number }> = []
  const windowListeners = new Map<string, () => void>()
  class Clock extends Date { static override now() { return now } }
  const user = { id: 'fixture-user', email: 'buyer@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
  const context = createContext({
    document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => buttons },
    location, history: { replaceState(_data: unknown, _unused: string, path: string) { const updated = new URL(path, location); location.href = updated.href } },
    window: { addEventListener: (event: string, callback: () => void) => windowListeners.set(event, callback) },
    Date: Clock, URLSearchParams, AbortSignal,
    setTimeout: (run: () => void, delay: number) => { timers.push({ run, at: now + delay }); return timers.length },
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (input.respond) return input.respond(url, init)
      if (url.endsWith('/settings')) return Response.json({ external: { google: false } })
      if (url.endsWith('/user')) return Response.json(user)
      if (url.includes('/signup')) return Response.json({ user })
      if (url.includes('/token?')) return Response.json({ access_token: 'fixture-browser-session' })
      return Response.json({})
    }
  })
  new Script(source).runInContext(context)
  const idle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
  await idle()
  const element = (id: string) => elements.get(id)!
  return {
    element, calls, location, lease,
    async action(id: string, type = 'click') { const item = element(id); if (type === 'click') item.onclick?.(); else item.listeners.get(type)?.({ preventDefault() {} }); await idle() },
    async advance(time: number) { now = time; for (const timer of timers.filter(timer => timer.at <= now)) timer.run(); await idle() },
    leave: () => windowListeners.get('pagehide')?.(), expiresAt
  }
}

test('signup sends a live owned callback, clears the password, and guides confirmation beyond device-code expiry', async t => {
  const f = await browser(t)
  f.element('email').value = 'buyer@example.test'; f.element('password').value = 'fixture-password'
  await f.action('signup')
  const signup = f.calls.find(call => call.url.includes('/signup'))!
  assert.equal(new URL(signup.url).searchParams.get('redirect_to'), f.lease.url)
  assert.deepEqual(JSON.parse(signup.init!.body as string), { email: 'buyer@example.test', password: 'fixture-password' })
  assert.equal(f.element('password').value, '')
  assert.match(f.element('status').textContent, /Check your email.*code expires.*Sign in again/)
  await f.advance(f.expiresAt + 1)
  assert.equal(f.element('approve').hidden, true)
  assert.equal(f.element('user-code').hidden, true)
  assert.match(f.element('expiry').textContent, /code has expired.*reset your password/)
  assert.equal(f.element('login').hidden, false)
  await f.action('reset')
  assert.ok(f.calls.some(call => call.url.includes('/recover?')))
  await f.action('approve')
  assert.equal(f.calls.some(call => call.url.includes('/deviceCodeApprove')), false)
})

test('confirmed email callbacks clear credential fragments and approve only with the verified browser session', async t => {
  const f = await browser(t, { hash: '#access_token=fixture-confirmed-session&type=signup&refresh_token=discard-me' })
  assert.equal(f.location.hash, '')
  assert.equal(f.element('approval').hidden, false)
  assert.match(f.element('identity').textContent, /buyer@example.test/)
  const check = f.calls.find(call => call.url.endsWith('/user'))!
  assert.equal(new Headers(check.init?.headers).get('authorization'), 'Bearer fixture-confirmed-session')
  await f.action('approve')
  assert.deepEqual(JSON.parse(f.calls.find(call => call.url.includes('/deviceCodeApprove'))!.init!.body as string), { data: { userCode: options.userCode } })
  assert.ok(f.calls.some(call => call.url.includes('/logout?scope=local')))
  assert.match(f.element('status').textContent, /This device is approved/)
})

test('switching accounts accepts an empty successful logout and clears the browser session', async t => {
  const f = await browser(t, {
    hash: '#access_token=fixture-confirmed-session&type=signup',
    respond: url => {
      if (url.endsWith('/settings')) return Response.json({})
      if (url.endsWith('/user')) return Response.json({ id: 'fixture-user', email: 'buyer@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' })
      if (url.includes('/logout?scope=local')) return new Response(null, { status: 204 })
      return Response.json({})
    }
  })
  assert.equal(f.element('approval').hidden, false)
  await f.action('different')
  const logout = f.calls.find(call => call.url.includes('/logout?scope=local'))!
  assert.equal(new Headers(logout.init?.headers).get('authorization'), 'Bearer fixture-confirmed-session')
  assert.equal(f.element('login').hidden, false)
  assert.equal(f.element('approval').hidden, true)
  assert.equal(f.element('status').textContent, 'Sign in with the account you want to use.')
  await f.action('approve')
  assert.equal(f.calls.some(call => call.url.includes('/deviceCodeApprove')), false)
  assert.match(f.element('status').textContent, /Sign in again/)
})

test('successful Auth responses that require JSON still reject malformed response bodies', async t => {
  const f = await browser(t, { respond: url => url.endsWith('/settings') ? Response.json({}) : new Response('not JSON', { status: 200 }) })
  f.element('email').value = 'buyer@example.test'; f.element('password').value = 'fixture-password'
  await f.action('login', 'submit')
  assert.equal(f.element('approval').hidden, true)
  assert.equal(f.element('status').textContent, 'The account service returned an invalid response.')
})

test('a recovery callback still changes the password after code expiry and never approves the expired code', async t => {
  const f = await browser(t, { hash: '#access_token=fixture-recovery-session&type=recovery', expiresAt: Date.now() - 1000 })
  assert.equal(f.location.hash, '')
  assert.equal(f.element('recovery').hidden, false)
  assert.equal(f.element('approval').hidden, true)
  f.element('new-password').value = 'fixture-new-password'
  await f.action('recovery', 'submit')
  const saved = f.calls.find(call => call.init?.method === 'PUT')!
  assert.equal(new Headers(saved.init?.headers).get('authorization'), 'Bearer fixture-recovery-session')
  assert.deepEqual(JSON.parse(saved.init!.body as string), { password: 'fixture-new-password' })
  assert.equal(f.element('new-password').value, '')
  assert.match(f.element('status').textContent, /password has been saved.*new code/)
  assert.equal(f.element('approve').hidden, true)
  await f.action('approve')
  assert.equal(f.calls.some(call => call.url.includes('/deviceCodeApprove')), false)
})

test('invalid recovery sessions and expired callbacks do not expose account actions', async t => {
  const f = await browser(t, { hash: '#access_token=invalid-session&type=recovery', respond: url => url.endsWith('/settings') ? Response.json({}) : Response.json({ message: 'Session expired' }, { status: 401 }) })
  assert.equal(f.location.hash, '')
  assert.equal(f.element('recovery').hidden, true)
  assert.equal(f.element('approval').hidden, true)
  assert.match(f.element('status').textContent, /Session expired/)
  await f.advance(Date.now() + 61 * 60_000)
  assert.equal(f.element('login').hidden, true)
  assert.match(f.element('expiry').textContent, /temporary account page has expired/)
  const requests = f.calls.length
  await f.action('reset')
  assert.equal(f.calls.length, requests)
})

test('leaving the callback clears its in-memory session before another approval attempt', async t => {
  const f = await browser(t, { hash: '#access_token=fixture-confirmed-session&type=signup' })
  assert.equal(f.element('approval').hidden, false)
  f.leave()
  await f.action('approve')
  assert.equal(f.calls.some(call => call.url.includes('/deviceCodeApprove')), false)
  assert.match(f.element('status').textContent, /Sign in again/)
})
