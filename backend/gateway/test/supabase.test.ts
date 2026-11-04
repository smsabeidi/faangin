import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSupabaseBackend, SupabaseGatewayError, SupabaseStore } from '../src/supabase.js'
import { normalizeGatewayPath } from '../src/supabase-routing.js'
import { NOW, openClient, post, proEntitlement, startFakeOpenAI, startGateway, until } from './support.js'

test('Supabase verifies the user against Auth and keeps server credentials out of user requests and errors', async () => {
  const uid = '4e169fb2-49ad-45cf-9c51-bf74da89fa72'
  const seen: Array<{ url: string; headers: Headers; body?: string }> = []
  const backend = createSupabaseBackend({ url: 'https://project.supabase.co', serviceKey: 'sb_secret_fixture', publishableKey: 'sb_publishable_fixture', fetch: (async (url, init) => {
    const headers = new Headers(init?.headers)
    seen.push({ url: String(url), headers, body: init?.body as string })
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: uid, user_metadata: { plan: 'pro' } })
    if (String(url).endsWith('/faangin_gateway_entitlement')) return Response.json(null)
    return Response.json({ proSessionsOpen: 'false', blockedUids: [uid, {}] })
  }) as typeof fetch })
  assert.deepEqual(await backend.verifyIdToken('user-jwt'), { uid })
  assert.equal(seen[0].headers.get('authorization'), 'Bearer user-jwt')
  assert.equal(seen[0].headers.get('apikey'), 'sb_publishable_fixture')
  assert.equal((await backend.loadEntitlement(uid)).plan, 'none', 'user metadata must never grant Pro')
  assert.equal(seen[1].headers.get('apikey'), 'sb_secret_fixture')
  assert.equal(seen[1].headers.get('authorization'), null, 'modern secret keys are API keys, not user JWTs')
  const flags = await backend.loadFlags()
  assert.equal(flags.proSessionsOpen, false); assert.deepEqual(flags.blockedUids, [uid])
  const rejected = createSupabaseBackend({ url: 'https://project.supabase.co', serviceKey: 'sb_secret_fixture', publishableKey: 'public', fetch: (async () => Response.json({ private: 'sb_secret_fixture' }, { status: 401 })) as typeof fetch })
  await assert.rejects(rejected.verifyIdToken('bad-token'), (error: unknown) => error instanceof SupabaseGatewayError && error.status === 401 && !error.message.includes('sb_secret_fixture'))
})

test('SupabaseStore uses one atomic admission RPC with server-owned ramp caps and strict result validation', async () => {
  let call: { name: string; args: Record<string, unknown> } | undefined
  const store = new SupabaseStore(async (name, args) => { call = { name, args }; return { kind: 'run', mode: 'fast', downgraded: true } })
  const decision = await store.admitAnswer('uid', 'period', { mode: 'smart', day: '2026-10-31', ramped: true, flags: { smartToFast: false, handsfreeOff: false }, leaseId: 'lease', now: 1, expiresAt: 2 })
  assert.deepEqual(decision, { kind: 'run', mode: 'fast', downgraded: true })
  assert.equal(call!.name, 'faangin_gateway_admit_answer')
  assert.deepEqual((call!.args.p_input as { limits: unknown }).limits, { fast: 150, smart: 7, handsfree: 450, monthUsd: 16, dayUsd: 11, maxAnswers: 2 })
  await assert.rejects(new SupabaseStore(async () => ({ kind: 'run', mode: 'external-model', downgraded: false })).admitAnswer('uid', 'period', { mode: 'fast', day: '2026-10-31', ramped: false, flags: { smartToFast: false, handsfreeOff: false }, leaseId: 'lease', now: 1, expiresAt: 2 }), SupabaseGatewayError)
})

test('Supabase Edge routing preserves OpenAI paths and query strings under both function prefixes', () => {
  for (const prefix of ['', '/faangin-gateway', '/functions/v1/faangin-gateway']) {
    assert.equal(normalizeGatewayPath(`${prefix}/v1/responses`), '/v1/responses')
    assert.equal(normalizeGatewayPath(`${prefix}/v1/realtime?intent=transcription`), '/v1/realtime?intent=transcription')
    assert.equal(normalizeGatewayPath(`${prefix}/healthz`), '/healthz')
  }
  assert.equal(normalizeGatewayPath('/faangin-gateway-evil/v1/responses'), '/faangin-gateway-evil/v1/responses')
})

test('an unconfigured provider fails before paid admission while health remains available', async () => {
  const fake = await startFakeOpenAI(), gateway = await startGateway(fake, { providerReady: false })
  gateway.entitlements.set('pending-provider', proEntitlement())
  try {
    assert.equal((await fetch(`${gateway.base}/healthz`)).status, 200)
    const response = await post(gateway, 'tok-pending-provider', { model: 'fast', input: 'hi' })
    assert.equal(response.status, 503)
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'provider_not_configured')
    assert.equal(fake.requests.length, 0)
  } finally { await gateway.close(); await fake.close() }
})

test('Edge audio receives a planned rotation notice while committed speech can still drain', async () => {
  const fake = await startFakeOpenAI(), gateway = await startGateway(fake, { sessionExpiresAt: NOW + 25 })
  gateway.entitlements.set('edge-rotation', proEntitlement())
  try {
    const client = await openClient(gateway, 'tok-edge-rotation')
    await until(() => client.messages.some(value => value.type === 'faangin.session.expiring'))
    client.send({ type: 'input_audio_buffer.commit' })
    await until(() => client.messages.some(value => value.transcript === 'hello'))
    await client.close()
  } finally { await gateway.shutdown(); await gateway.close(); await fake.close() }
})
