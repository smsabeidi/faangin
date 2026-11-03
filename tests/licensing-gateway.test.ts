import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generateAnswer } from '../src/main/inference'
import { DEFAULT_SETTINGS, type Session } from '../src/shared/types'
import { CONFIG, DAY, harness, NOW, until } from './licensing-support'

test('approved account and verified Pro license stream through the real gateway transport without a personal key', async t => {
  const seen: { authorization?: string; apikey?: string; mode?: string; path?: string }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      seen.push({ authorization: request.headers.authorization, apikey: request.headers.apikey as string, mode: body.model, path: request.url })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Use a hash map.' })}\n\n`)
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: DEFAULT_SETTINGS.fastModel, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Use a hash map.' }] }], usage: { input_tokens: 20, output_tokens: 5 } } })}\n\n`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const issuer = harness(t)
  const { service, store } = harness(t, {
    config: { ...CONFIG, gatewayBase: `http://127.0.0.1:${address.port}`, licensePublicKeys: [issuer.signer.publicKeyBase64] },
    cloud: { fetchLicense: async () => ({ token: issuer.token({ plan: 'pro' }), plan: 'pro', status: 'active', expiresAt: NOW + 30 * DAY, graceUntil: NOW + 44 * DAY }) }
  })
  await service.start()
  await service.startSignIn()
  await until(() => service.summary().state.kind === 'active')
  assert.equal((await store.readSession())?.uid, 'user-1')
  const access = await service.requireInferenceAccess()
  assert.equal(access.kind, 'pro')
  if (access.kind !== 'pro') throw new Error('Expected managed Pro access')
  const session: Session = { id: 'interview-1', title: 'Pro interview', mode: 'interview', status: 'idle', createdAt: NOW, updatedAt: NOW, notes: '', transcript: [], answers: [], attachments: [], contextEpoch: 0 }
  const deltas: string[] = []
  const result = await generateAnswer({ action: 'ask', prompt: 'How should I solve two sum?', settings: DEFAULT_SETTINGS, session, attachments: [] }, {
    apiKey: 'faangin-managed', managedMode: 'fast', signal: new AbortController().signal,
    transport: access.transport, onDelta: delta => deltas.push(delta)
  })
  assert.equal(result.text, 'Use a hash map.')
  assert.equal(deltas.join(''), result.text)
  assert.deepEqual(seen, [{ authorization: 'Bearer id-token-1', apikey: CONFIG.publishableKey, mode: 'fast', path: '/v1/responses' }])
  await service.signOut()
  await assert.rejects(async () => access.transport.fetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }), /Sign in first/)
  assert.equal(seen.length, 1, 'the old transport sends nothing after sign-out')
})
