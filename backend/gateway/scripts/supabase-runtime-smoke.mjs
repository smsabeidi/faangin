/** Local Deno + fake Supabase/provider integration. Never contacts a real project or model. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
const uid = 'b57614ec-6325-46eb-a83a-cd02ab59209a'
const selectedServerKey = 'sb_secret_' + 'selected_fixture'
const usage = { audioSeconds: 0, handsfree: 0, fast: 0, smart: 0, spendUsd: 0, days: {} }
const fake = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  res.setHeader('content-type', 'application/json')
  const rpc = req.url.split('/').pop()
  if (req.url.startsWith('/rest/v1/rpc/')) {
    assert.equal(req.headers.apikey, selectedServerKey)
    assert.equal(req.headers.authorization, undefined)
  }
  let data = null
  if (req.url === '/auth/v1/user') { assert.equal(req.headers.authorization, 'Bearer fixture-user-jwt'); data = { id: uid } }
  else if (rpc === 'faangin_gateway_entitlement') data = { plan: 'pro', status: 'active', updatedAt: Date.now(), pro: { currentPeriodStart: Date.now() - 1000, currentPeriodEnd: Date.now() + 86400000, rampUntil: 0 } }
  else if (rpc === 'faangin_gateway_flags') data = {}
  else if (rpc === 'faangin_gateway_usage') data = usage
  else if (rpc === 'faangin_gateway_admit_answer') { usage[body.p_input.mode]++; data = { kind: 'run', mode: body.p_input.mode, downgraded: false } }
  else if (rpc === 'faangin_gateway_claim_lease') data = true
  else if (rpc === 'faangin_gateway_increment') {
    for (const key of ['audioSeconds', 'handsfree', 'fast', 'smart', 'spendUsd']) usage[key] += body.p_delta[key] ?? 0
  } else if (req.url === '/v1/responses') {
    assert.equal(req.headers.authorization, 'Bearer fixture-provider-key')
    assert.equal(body.model, 'fixture-fast')
    res.setHeader('content-type', 'text/event-stream')
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture-answer' }] }], usage: { input_tokens: 10, output_tokens: 4 } } }) + '\n\n')
    return
  }
  res.end(JSON.stringify(data))
})
const provider = new WebSocketServer({ server: fake, path: '/v1/realtime' })
provider.on('connection', (socket, req) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-provider-key')
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString())
    if (value.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    if (value.type === 'input_audio_buffer.commit') {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'fixture-turn' }))
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fixture-turn', transcript: 'fixture transcript' }))
    }
  })
})
fake.listen(0, '127.0.0.1'); await once(fake, 'listening')
const origin = `http://127.0.0.1:${fake.address().port}`
const bundle = fileURLToPath(new URL('../../../supabase/functions/faangin-gateway/index.ts', import.meta.url))
// Hosted Edge ESM does not provide ambient Buffer. Deno CLI normally masks missing imports.
// Keep Deno's own process global: its node:http implementation requires it internally.
const loader = `delete globalThis.Buffer; await import(${JSON.stringify(pathToFileURL(bundle).href)}); if (typeof globalThis.Buffer !== 'undefined') throw new Error('Gateway recreated ambient Buffer');`
let output = ''
const child = spawn('deno', ['run', '--no-config', '--no-lock', '--node-modules-dir=none', '--allow-env', '--allow-net=127.0.0.1', '--allow-read', '--no-check', '-'], { env: {
  ...process.env, SUPABASE_URL: origin,
  FAANGIN_SUPABASE_SERVER_KEY_NAME: 'replacement',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'retired-default-fixture', replacement: selectedServerKey }), SUPABASE_SERVICE_ROLE_KEY: 'retired-legacy-fixture',
  SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_fixture"}',
  OPENAI_API_KEY: 'fixture-provider-key', OPENAI_BASE: origin, OPENAI_WS_BASE: origin.replace('http:', 'ws:'), FAST_MODEL: 'fixture-fast', FAANGIN_GATEWAY_BIND_HOST: '127.0.0.1'
}, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(loader)
child.stdout.on('data', value => { output = (output + value).slice(-8000) }); child.stderr.on('data', value => { output = (output + value).slice(-8000) })
let client
async function until(check) { const deadline = Date.now() + 10000; while (!(await check())) { if (child.exitCode !== null || Date.now() > deadline) throw new Error('Deno gateway fixture failed: ' + output); await new Promise(resolve => setTimeout(resolve, 20)) } }
try {
  await until(async () => { try { return (await fetch('http://127.0.0.1:8080/faangin-gateway/healthz')).ok } catch { return false } })
  const answer = await fetch('http://127.0.0.1:8080/functions/v1/faangin-gateway/v1/responses', { method: 'POST', headers: { authorization: 'Bearer fixture-user-jwt', apikey: 'sb_publishable_fixture', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fast', input: 'fixture question' }) })
  assert.equal(answer.status, 200, output); assert.match(await answer.text(), /fixture-answer/, output)
  client = new WebSocket('ws://127.0.0.1:8080/faangin-gateway/v1/realtime?intent=transcription', { headers: { authorization: 'Bearer fixture-user-jwt', apikey: 'sb_publishable_fixture' } })
  const messages = []
  client.on('message', raw => messages.push(JSON.parse(raw.toString())))
  await once(client, 'open')
  client.send(JSON.stringify({ type: 'session.update', session: { audio: { input: { turn_detection: null } } } }))
  await until(() => messages.some(message => message.type === 'session.updated'))
  client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') }))
  client.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  await until(() => messages.some(message => message.transcript === 'fixture transcript'))
  client.close(); await once(client, 'close')
  await until(() => usage.audioSeconds > 0)
  assert.equal(usage.fast, 1); assert.equal(usage.audioSeconds, 0.1)
  process.stdout.write('Supabase Deno gateway HTTP SSE + WebSocket + auth/RPC fixture passed; no live services used.\n')
} finally {
  client?.terminate()
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited.catch(() => {}) }
  for (const socket of provider.clients) socket.terminate()
  await new Promise(resolve => provider.close(resolve)); fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve))
}
