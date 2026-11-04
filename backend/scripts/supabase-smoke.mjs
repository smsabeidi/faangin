#!/usr/bin/env node
/**
 * Live, self-cleaning Supabase acceptance checks. No Stripe payment is created.
 *
 * node backend/scripts/supabase-smoke.mjs --env-file backend/.env.supabase.local --sql-auth-fixture
 * Add --inference for one tiny billed answer, and --cancel for a second canceled answer.
 * Without --authenticated/--sql-auth-fixture, only public checks and an owned pending code run.
 *
 * Preferred fixture creation: --authenticated with SUPABASE_SECRET_KEY in the ignored env file.
 * --sql-auth-fixture explicitly permits a tagged temporary Auth row/identity when only a scoped
 * management PAT is available. It introspects managed Auth columns and refuses unknown layouts.
 * Passwords, access/refresh tokens, confirmation hashes and provider output are never printed.
 */
import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { parseEnv } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const allowed = new Set(['--env-file', '--config', '--authenticated', '--sql-auth-fixture', '--inference', '--cancel', '--audio', '--rotation', '--help'])
function check(ok, message) { if (!ok) throw new Error(message) }
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; check(args[i + 1] && !args[i + 1].startsWith('--'), `${name} requires a path`); return args[i + 1] }
for (let i = 0; i < args.length; i++) { check(allowed.has(args[i]), 'Unknown smoke option; use --help'); if (['--env-file', '--config'].includes(args[i])) i++ }
if (args.includes('--help')) {
  console.log('Usage: node --import tsx backend/scripts/supabase-smoke.mjs --env-file <ignored-env> [--config <public-json>] [--authenticated | --sql-auth-fixture] [--inference] [--cancel] [--audio [--rotation]]')
  console.log('Requires SUPABASE_ACCESS_TOKEN for owned-fixture cleanup. --authenticated also needs SUPABASE_SECRET_KEY. --inference/--cancel make small billed provider requests.')
  process.exit(0)
}
const envFile = option('--env-file', undefined)
let env = { ...process.env }
if (envFile) {
  const path = resolve(envFile), info = await stat(path)
  check(info.isFile() && (info.mode & 0o077) === 0, 'The credential env file must be a regular file accessible only by its owner (chmod 600)')
  env = { ...env, ...parseEnv(await readFile(path, 'utf8')) }
}
const config = JSON.parse(await readFile(resolve(option('--config', resolve(root, 'config/cloud.supabase.json'))), 'utf8'))
const project = new URL(config.supabaseUrl)
check(project.protocol === 'https:' && /^[a-z]{20}\.supabase\.co$/.test(project.hostname) && project.pathname === '/' && !project.search && !project.hash && !project.username && !project.password, 'Public config must identify an HTTPS Supabase project origin')
check(typeof config.publishableKey === 'string' && config.publishableKey.startsWith('sb_publishable_'), 'Public config needs a publishable key')
const ref = project.hostname.split('.')[0], base = project.origin
const account = `${base}/functions/v1/faangin-api`, gateway = `${base}/functions/v1/faangin-gateway`
check(!config.gatewayBase || config.gatewayBase === gateway, 'Public gateway config must belong to the same project')
const pat = env.SUPABASE_ACCESS_TOKEN
check(typeof pat === 'string' && pat.length > 20, 'SUPABASE_ACCESS_TOKEN is required to clean up owned smoke fixtures')
const sqlAuth = args.includes('--sql-auth-fixture'), authenticated = sqlAuth || args.includes('--authenticated')
const inference = args.includes('--inference'), cancel = args.includes('--cancel')
const audio = args.includes('--audio')
const rotation = args.includes('--rotation')
check(!(sqlAuth && args.includes('--authenticated')), 'Choose either --authenticated or --sql-auth-fixture')
check(!inference || authenticated, '--inference requires an authenticated fixture')
check(!cancel || inference, '--cancel requires --inference')
check(!audio || inference, '--audio requires --inference and makes a small billed transcription request')
check(!rotation || audio, '--rotation requires --audio and checks renewal across a two-minute session')
check(!audio || process.platform === 'darwin', '--audio uses the Mac offline say/afconvert tools')
const adminKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
check(!authenticated || sqlAuth || adminKey, '--authenticated needs SUPABASE_SECRET_KEY; --sql-auth-fixture is the explicit PAT-only fallback')

const run = randomUUID().replaceAll('-', ''), deviceId = `smoke_${run}`, email = `faangin-smoke+${run}@example.com`
let uid = randomUUID(), deviceProof, deviceCode, password, browserToken, desktopToken, refreshToken
let fixtureAttempted = false, codeAttempted = false, checks = 0, skipped = 0, failed = false
console.log(`Smoke run ${run} on ${ref}; temporary rows carry only this run's marker.`)
const q = value => `'${String(value).replaceAll("'", "''")}'`
const headers = token => ({ apikey: config.publishableKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) })
function pass(label) { checks++; console.log(`PASS ${label}`) }
function skip(label) { skipped++; console.log(`SKIP ${label}`) }
async function http(url, init = {}, timeout = 25_000) {
  let response
  try { response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeout) }) }
  catch { throw new Error('A smoke HTTP request failed or timed out') }
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { response, data, text }
}
async function sql(query) {
  const result = await http(`https://api.supabase.com/v1/projects/${ref}/database/query`, { method: 'POST', headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) }, 40_000)
  check(result.response.ok && Array.isArray(result.data), `Management SQL failed (HTTP ${result.response.status}); query and response withheld`)
  return result.data
}
async function call(route, data, token, raw = false) {
  return http(`${account}/${route}`, { method: 'POST', headers: headers(token), body: JSON.stringify(raw ? data : { data }) })
}
function expect(result, status, label) { check(result.response.status === status, `${label} returned unexpected HTTP ${result.response.status}`); pass(label) }
function verifyLicense(result, plan) {
  check(result.response.ok && result.data?.result?.plan === plan, `${plan} license was not issued`)
  const [version, encoded, signature, ...extra] = String(result.data.result.token).split('.')
  check(version === 'v1' && encoded && signature && extra.length === 0, 'License envelope is invalid')
  const bytes = Buffer.from(encoded, 'base64url')
  check(Array.isArray(config.licensePublicKeys) && config.licensePublicKeys.some(key => {
    try { return verify(null, bytes, createPublicKey({ key: Buffer.from(key, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signature, 'base64url')) } catch { return false }
  }), 'Issued license does not verify against the release public keys')
  const payload = JSON.parse(bytes.toString('utf8'))
  check(payload.uid === uid && payload.deviceId === deviceId && payload.plan === plan && payload.exp > Date.now() && payload.grace > payload.exp, 'License identity, device, plan or validity is wrong')
  pass(`${plan} license signature, identity and device`)
}
async function createFixture() {
  fixtureAttempted = true
  if (!sqlAuth) {
    password = randomBytes(32).toString('base64url')
    const result = await http(`${base}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: adminKey, 'content-type': 'application/json', ...(adminKey.startsWith('eyJ') ? { authorization: `Bearer ${adminKey}` } : {}) }, body: JSON.stringify({ id: uid, email, password, email_confirm: true, app_metadata: { faangin_smoke: run } }) })
    check(result.response.ok && result.data?.id && result.data.email === email, `Temporary Auth Admin fixture creation failed (HTTP ${result.response.status})`)
    uid = result.data.id
    check(/^[0-9a-f-]{36}$/.test(uid), 'Auth Admin returned an invalid fixture identity')
  } else {
    const columns = await sql("select table_name,column_name,data_type,is_nullable,column_default,is_generated from information_schema.columns where table_schema='auth' and table_name in ('users','identities') order by table_name,ordinal_position")
    const users = new Map(columns.filter(row => row.table_name === 'users').map(row => [row.column_name, row]))
    const identities = new Map(columns.filter(row => row.table_name === 'identities').map(row => [row.column_name, row]))
    const userFields = { id: `${q(uid)}::uuid`, instance_id: "'00000000-0000-0000-0000-000000000000'::uuid", aud: "'authenticated'", role: "'authenticated'", email: q(email), encrypted_password: 'fixture_hash', email_confirmed_at: 'now()', raw_app_meta_data: `${q(JSON.stringify({ provider: 'email', providers: ['email'], faangin_smoke: run }))}::jsonb`, raw_user_meta_data: "'{}'::jsonb", created_at: 'now()', updated_at: 'now()', confirmation_token: "''", recovery_token: "''", email_change_token_new: "''", email_change_token_current: "''", email_change: "''", phone_change_token: "''", phone_change: "''", reauthentication_token: "''", is_sso_user: 'false', is_anonymous: 'false' }
    const identityFields = { id: 'gen_random_uuid()', provider_id: q(uid), user_id: `${q(uid)}::uuid`, provider: "'email'", identity_data: `${q(JSON.stringify({ sub: uid, email, email_verified: true, phone_verified: false }))}::jsonb`, last_sign_in_at: 'now()', created_at: 'now()', updated_at: 'now()' }
    for (const name of ['id', 'email', 'encrypted_password', 'email_confirmed_at', 'raw_app_meta_data']) check(users.has(name), 'Unsupported auth.users schema; use Auth Admin fixture instead')
    for (const name of ['id', 'provider_id', 'user_id', 'provider', 'identity_data']) check(identities.has(name), 'Unsupported auth.identities schema; use Auth Admin fixture instead')
    check(users.get('id').data_type === 'uuid' && identities.get('id').data_type === 'uuid', 'Unsupported managed Auth identity types')
    for (const [known, values] of [[users, userFields], [identities, identityFields]]) for (const column of known.values()) {
      if (column.is_nullable === 'NO' && !column.column_default && column.is_generated === 'NEVER') check(Object.hasOwn(values, column.column_name), 'Managed Auth has an unknown required column; use Auth Admin fixture instead')
    }
    const crypto = await sql("select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'")
    check(crypto.length === 1 && ['extensions', 'public'].includes(crypto[0].nspname), 'A supported pgcrypto installation is required for the temporary SQL fixture')
    const cryptoSchema = crypto[0].nspname
    userFields.encrypted_password = `${cryptoSchema}.crypt(s.password,${cryptoSchema}.gen_salt('bf',10))`
    const entries = (fields, known) => Object.entries(fields).filter(([key]) => known.has(key))
    const u = entries(userFields, users), i = entries(identityFields, identities)
    // The plaintext password is generated by Postgres and returned only in memory: it never appears in SQL text/logs.
    const created = await sql(`with secret as materialized (select encode(${cryptoSchema}.gen_random_bytes(32),'hex') as password), created_user as (insert into auth.users(${u.map(([key]) => key).join(',')}) select ${u.map(([, value]) => value).join(',')} from secret s returning id), created_identity as (insert into auth.identities(${i.map(([key]) => key).join(',')}) select ${i.map(([, value]) => value).join(',')} from created_user returning user_id) select s.password from secret s cross join created_identity`)
    check(created.length === 1 && typeof created[0].password === 'string', 'Temporary SQL Auth fixture was not created')
    password = created[0].password
  }
  pass('isolated confirmed Auth fixture created without sending email')
}
async function setEntitlement(document) {
  const rows = await sql(`select public.faangin_stripe_commit(u.id,(public.faangin_entitlement_read(u.id)->>'version')::bigint,${q(JSON.stringify(document))}::jsonb) as result from auth.users u where u.id=${q(uid)}::uuid and u.email=${q(email)} and u.raw_app_meta_data->>'faangin_smoke'=${q(run)}`)
  check(rows.length === 1 && rows[0].result?.kind === 'committed', 'Owned fixture entitlement could not be changed')
}
async function noLease(kind = 'answers') {
  for (let attempt = 0; attempt < 12; attempt++) {
    const rows = await sql(`select count(*)::integer as count from faangin.gateway_leases where uid=${q(uid)}::uuid and kind=${q(kind)}`)
    if (rows[0]?.count === 0) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Gateway ${kind} lease remained after completion/cancellation`)
}
function errorTags(data, response) {
  const tags = []
  for (const [name, value] of [['code', data?.error?.code ?? data?.code], ['type', data?.error?.type ?? data?.type]]) {
    // Error tags are identifiers only. Arbitrary server messages, URLs and input echoes stay private.
    if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) && !/^(?:sk_|rk_|sb_|sbp_|eyJ)/.test(value)) tags.push(`${name}=${value}`)
  }
  const message = data?.error?.message ?? data?.message
  if (typeof message === 'string') {
    const known = [
      [/function failed to start|worker failed to boot|worker boot error/i, 'worker failed to start'],
      [/worker failed to respond/i, 'worker failed to respond'],
      [/worker.*exceeded.*(?:resource|memory|cpu)/i, 'worker resource limit'],
      [/model.*(?:not found|does not exist|do not have access)/i, 'model unavailable'],
      [/exceeded.*quota|insufficient quota/i, 'provider quota exhausted'],
      [/rate limit/i, 'provider rate limit']
    ].find(([pattern]) => pattern.test(message))
    if (known) tags.push(`category=${known[1]}`)
  }
  for (const name of ['sb-request-id', 'x-deno-execution-id', 'x-request-id']) {
    const value = response?.headers.get(name)
    if (value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) tags.push(`${name}=${value}`)
  }
  return tags.length ? tags.join(', ') : 'no recognized error identifier; response body withheld'
}
async function responseFailure(response) {
  let text = '', size = 0, tooLarge = false
  if (response.body) {
    const reader = response.body.getReader(), decoder = new TextDecoder()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) { text += decoder.decode(); break }
        size += chunk.value.byteLength
        if (size > 65_536) { tooLarge = true; void reader.cancel().catch(() => {}); break }
        text += decoder.decode(chunk.value, { stream: true })
      }
    } catch { /* Preserve the HTTP status even when the platform closes its error stream. */ }
    finally { reader.releaseLock() }
  }
  let data
  if (!tooLarge) try { data = JSON.parse(text) } catch { /* Do not print arbitrary plain-text error bodies. */ }
  return `HTTP ${response.status}; ${errorTags(data, response)}`
}
async function answer(canceled = false) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000)
  let sawDelta = false, completed = false, bytes = 0, rest = ''
  try {
    let response
    try { response = await fetch(`${gateway}/v1/responses`, { method: 'POST', headers: headers(desktopToken), body: JSON.stringify({ model: 'fast', input: canceled ? 'Count from one to one hundred, one number per line.' : 'Reply with only the word OK.', max_output_tokens: canceled ? 128 : 32 }), redirect: 'error', signal: controller.signal }) }
    catch { throw new Error('Managed answer connection failed or timed out') }
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error(`Managed answer did not stream (${await responseFailure(response)})`)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      check(bytes <= 262_144, 'Managed smoke stream exceeded its size bound')
      if (canceled) { controller.abort(); await reader.cancel().catch(() => {}); break }
      rest += decoder.decode(chunk.value, { stream: true })
      const lines = rest.split('\n'); rest = lines.pop() ?? ''
      for (const line of lines) if (line.startsWith('data:')) {
        let event; try { event = JSON.parse(line.slice(5)) } catch { continue }
        if (event.type === 'response.output_text.delta' && event.delta) sawDelta = true
        if (event.type === 'response.completed' && event.response?.status === 'completed') completed = true
        if (['response.failed', 'error'].includes(event.type)) throw new Error(`Provider returned a failed stream event (${errorTags(event.response ?? event)})`)
      }
    }
    if (!canceled) check(sawDelta && completed, 'Managed answer did not produce text and complete')
    await noLease()
    pass(canceled ? 'managed stream cancellation releases admission lease' : 'managed answer streams text, completes and releases admission lease')
  } finally { clearTimeout(timer); controller.abort() }
}
function offline(command, argv) {
  return new Promise((resolve, reject) => execFile(command, argv, { timeout: 15_000, maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(new Error('Offline synthetic voice generation failed; command output withheld')) : resolve(stdout)))
}
function pcmFromWave(bytes) {
  check(bytes.length <= 1_048_576 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE', 'Synthetic audio is not a bounded WAV file')
  let pcm, formatOK = false
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8
    check(start + length <= bytes.length, 'Synthetic WAV contains a truncated chunk')
    if (kind === 'fmt ') formatOK = length >= 16 && bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1 && bytes.readUInt32LE(start + 4) === 24_000 && bytes.readUInt16LE(start + 14) === 16
    if (kind === 'data') pcm = bytes.subarray(start, start + length)
    offset = start + length + length % 2
  }
  check(formatOK && pcm && pcm.length >= 4800 && pcm.length <= 9 * 48_000 && pcm.length % 2 === 0, 'Synthetic audio must be PCM16 mono at 24 kHz and no longer than nine seconds')
  return Buffer.concat([Buffer.alloc(12_000), pcm, Buffer.alloc(24_000)])
}
async function transcription() {
  const directory = await mkdtemp(resolve(tmpdir(), 'faangin-audio-smoke-'))
  let transcriber, timedOut = false, timer, sessionError = false, incomplete = false
  const controller = new AbortController(), finals = new Map()
  try {
    const voices = await offline('/usr/bin/say', ['-v', '?'])
    const english = [...voices.matchAll(/^(.+?)\s+en_(?:US|GB)\s+#/gm)].map(match => match[1].trim())
    const voice = ['Samantha', 'Daniel', 'Karen', 'Fred'].find(name => english.includes(name)) ?? english.find(name => !['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Hysterical', 'Organ', 'Trinoids', 'Whisper', 'Zarvox'].includes(name))
    check(voice, 'No suitable installed English offline voice is available')
    const aiff = resolve(directory, 'synthetic.aiff'), wav = resolve(directory, 'synthetic.wav')
    await offline('/usr/bin/say', ['-v', voice, '-r', '130', '-o', aiff, 'This interview test is complete.'])
    await offline('/usr/bin/afconvert', [aiff, wav, '-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1'])
    const pcm = pcmFromWave(await readFile(wav))
    let createLiveTranscriber, createManagedTranscriber, proTransport, connections = 0
    try {
      ;({ createLiveTranscriber } = await import(pathToFileURL(resolve(root, 'src/main/inference.ts')).href))
      ;({ proTransport } = await import(pathToFileURL(resolve(root, 'src/main/faangin-cloud.ts')).href))
      if (rotation) ({ createManagedTranscriber } = await import(pathToFileURL(resolve(root, 'src/main/managed-transcriber.ts')).href))
    } catch { throw new Error('Desktop transcription modules could not load; run this script with node --import tsx') }
    const operation = async () => {
      const openedAt = Date.now()
      const create = rotation ? options => createManagedTranscriber({ ...options, createTranscriber: async config => { const ready = await createLiveTranscriber(config); connections++; return ready } }) : createLiveTranscriber
      transcriber = await create({ apiKey: 'managed-smoke-placeholder', model: 'gpt-transcribe', language: 'en', channel: 'microphone', managedTranscription: true,
        signal: controller.signal, transport: proTransport(() => desktopToken, gateway, config.publishableKey),
        deadlines: { connectMs: 12_000, flushMs: 15_000, finalizeMs: 2000, closeMs: 1000 },
        onPartial() {}, onFinal(id, text) { if (text.length > 10_000) sessionError = true; else finals.set(id, text) },
        onError() { sessionError = true }, onIncomplete() { incomplete = true }
      })
      pass('desktop transcriber reaches ready over deployed Supabase WSS')
      async function speak() {
        finals.clear()
        for (let offset = 0; offset < pcm.length; offset += 2400) {
          check(!timedOut && !sessionError, 'Managed audio session ended while sending synthetic speech')
          transcriber.write(pcm.subarray(offset, offset + 2400))
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        await transcriber.flush(true)
        check(!sessionError && !incomplete, 'Managed transcription reported an incomplete or failed turn')
        const text = [...finals.values()].join(' ').toLowerCase()
        check(['interview', 'test', 'complete'].every(word => new RegExp(`\\b${word}\\b`).test(text)), 'Managed final transcript did not contain the expected synthetic words; transcript withheld')
      }
      await speak()
      if (rotation) {
        while (Date.now() - openedAt < 115_000) {
          check(!timedOut && !sessionError, 'Managed audio failed during worker renewal')
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        check(connections >= 2, 'Managed audio did not renew its real gateway connection')
        await speak()
        pass('speech completes before and after the real 90-second connection renewal')
      }
      await transcriber.stop()
      await noLease('audio')
      let accounted = false
      for (let attempt = 0; attempt < 12; attempt++) {
        const rows = await sql(`select coalesce(sum((document->>'audioSeconds')::numeric),0)::float8 as seconds from faangin.gateway_usage where uid=${q(uid)}::uuid`)
        check(Number.isFinite(rows[0]?.seconds) && rows[0].seconds <= (pcm.length / 48_000) * (rotation ? 2 : 1) + 0.25, 'Managed audio metering exceeded the sent fixture duration')
        if (rows[0].seconds > 0) { accounted = true; break }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      check(accounted, 'Managed audio did not persist positive usage after stop')
      pass('synthetic speech finalizes, stop releases audio lease, and usage is metered')
    }
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); void transcriber?.stop(); reject(new Error('Managed audio acceptance exceeded its deadline')) }, rotation ? 150_000 : 40_000) })
    await Promise.race([operation(), deadline])
  } finally {
    clearTimeout(timer); controller.abort()
    await transcriber?.stop().catch(() => {})
    finals.clear()
    await rm(directory, { recursive: true, force: true })
  }
}
async function cleanup() {
  for (const token of new Set([browserToken, desktopToken].filter(Boolean))) {
    try { await http(`${base}/auth/v1/logout?scope=local`, { method: 'POST', headers: headers(token), body: '{}' }) } catch { /* SQL below revokes all fixture sessions too. */ }
  }
  if (!fixtureAttempted && !codeAttempted) return
  // Exact random email and server-only marker guard every Auth/app delete. Permanent accounts never match.
  const proofGuard = deviceProof ? `and device_code_hash=${q(deviceProof)}` : ''
  await sql(`begin;
do $cleanup$
declare fixture uuid; v bigint;
begin
 select id into fixture from auth.users where email=${q(email)} and raw_app_meta_data->>'faangin_smoke'=${q(run)};
 if fixture is not null then
  perform pg_advisory_xact_lock(hashtextextended(fixture::text,0));
  select (public.faangin_entitlement_read(fixture)->>'version')::bigint into v;
  perform public.faangin_stripe_commit(fixture,v,'{"plan":"none","status":"active","updatedAt":0}'::jsonb);
  delete from faangin.gateway_leases where uid=fixture;
  delete from faangin.gateway_usage where uid=fixture;
  delete from faangin.checkout_leases where uid=fixture;
  delete from faangin.device_codes where uid=fixture;
  delete from faangin.devices where uid=fixture;
  delete from faangin.customers where uid=fixture;
  delete from faangin.entitlements where uid=fixture;
  delete from auth.sessions where user_id=fixture;
  delete from auth.refresh_tokens where user_id::text=fixture::text;
  delete from auth.identities where user_id=fixture;
  delete from auth.users where id=fixture;
 end if;
 delete from faangin.device_codes where device_id=${q(deviceId)} ${proofGuard} and (uid is null or uid=${q(uid)}::uuid);
end $cleanup$;
commit;`)
  const rows = await sql(`select (select count(*) from auth.users where email=${q(email)} and raw_app_meta_data->>'faangin_smoke'=${q(run)})::integer as users,(select count(*) from faangin.device_codes where device_id=${q(deviceId)})::integer as codes`)
  check(rows[0]?.users === 0 && rows[0]?.codes === 0, 'Temporary smoke rows remained after cleanup')
  password = browserToken = desktopToken = refreshToken = deviceCode = undefined
  pass('temporary Auth sessions, device codes, entitlements, usage and seats cleaned up')
}

try {
  const health = await http(`${account}/health`, { headers: headers() })
  expect(health, 200, 'account Edge health')
  check(health.data?.ok === true && health.data.authConfigured === true, 'Account Edge health is not ready')
  expect(await http(`${gateway}/healthz`, { headers: headers() }), 200, 'gateway Edge health')
  const returned = await http(`${base}/functions/v1/billing-return/billing/success`)
  check(returned.response.ok && returned.text.includes('payment is being confirmed'), 'Billing success return page is unavailable')
  pass('billing return page')
  expect(await call('issueLicense', { deviceId, deviceName: 'Temporary launch smoke' }), 401, 'anonymous account call rejected')
  expect(await call('issueLicense', { deviceId, deviceName: 'Temporary launch smoke' }, 'fixture-invalid-token'), 401, 'invalid user token rejected')
  expect(await http(`${account}/deviceCodeStart`, { method: 'POST', headers: { ...headers(), origin: 'https://untrusted.example' }, body: JSON.stringify({ deviceId, deviceName: 'Temporary launch smoke' }) }), 401, 'foreign browser origin rejected')
  const rpc = await http(`${base}/rest/v1/rpc/faangin_entitlement_read`, { method: 'POST', headers: headers(), body: JSON.stringify({ p_uid: uid }) })
  check([401, 403, 404].includes(rpc.response.status), 'Anonymous caller can execute private account RPC')
  pass('service-only account RPC rejects anonymous role')
  codeAttempted = true
  const started = await call('deviceCodeStart', { deviceId, deviceName: 'Temporary launch smoke' }, undefined, true)
  check(started.response.ok && /^[A-Za-z0-9_-]{43}$/.test(started.data?.deviceCode ?? '') && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(started.data?.userCode ?? ''), 'Device start returned an invalid code')
  deviceCode = started.data.deviceCode; deviceProof = createHash('sha256').update(deviceCode).digest('hex')
  const pending = await call('deviceCodePoll', { deviceCode }, undefined, true)
  check(pending.response.ok && pending.data?.status === 'pending', 'New device code is not pending')
  pass('device start and unauthenticated proof polling')
  if (authenticated) {
    await createFixture()
    const login = await http(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) })
    check(login.response.ok && login.data?.access_token && login.data.user?.id === uid, `Real password sign-in failed (HTTP ${login.response.status})`)
    browserToken = login.data.access_token; password = undefined
    pass('real Supabase password session')
    const approved = await call('deviceCodeApprove', { userCode: started.data.userCode, uid: randomUUID() }, browserToken)
    check(approved.response.ok && approved.data?.result?.ok === true, 'Authenticated device approval failed')
    const polled = await call('deviceCodePoll', { deviceCode }, undefined, true)
    check(polled.response.ok && polled.data?.status === 'approved' && polled.data.uid === uid && polled.data.tokenHash, 'Approved code did not return an independent one-use session proof')
    const consumed = await call('deviceCodePoll', { deviceCode }, undefined, true)
    check(consumed.response.ok && consumed.data?.status === 'expired', 'Consumed device code could be polled again')
    const exchange = await http(`${base}/auth/v1/verify`, { method: 'POST', headers: headers(), body: JSON.stringify({ token_hash: polled.data.tokenHash, type: 'email' }) })
    check(exchange.response.ok && exchange.data?.user?.id === uid && exchange.data.access_token && exchange.data.refresh_token, 'Desktop one-use proof exchange failed')
    desktopToken = exchange.data.access_token; refreshToken = exchange.data.refresh_token
    const reused = await http(`${base}/auth/v1/verify`, { method: 'POST', headers: headers(), body: JSON.stringify({ token_hash: polled.data.tokenHash, type: 'email' }) })
    check([400, 401, 403].includes(reused.response.status), 'Device proof could be reused')
    pass('approved device proof exchanges once for the correct user')
    expect(await http(`${base}/auth/v1/logout?scope=local`, { method: 'POST', headers: headers(browserToken), body: '{}' }), 204, 'browser session local sign-out')
    browserToken = undefined
    const rotated = await http(`${base}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: refreshToken }) })
    check(rotated.response.ok && rotated.data?.user?.id === uid && rotated.data.access_token && rotated.data.refresh_token, 'Independent desktop refresh failed after browser logout')
    desktopToken = rotated.data.access_token; refreshToken = rotated.data.refresh_token
    pass('desktop session refresh survives browser sign-out')
    const protectedRpc = await http(`${base}/rest/v1/rpc/faangin_entitlement_read`, { method: 'POST', headers: headers(desktopToken), body: JSON.stringify({ p_uid: uid }) })
    check([401, 403, 404].includes(protectedRpc.response.status), 'Authenticated browser role can execute private account RPC')
    pass('service-only account RPC rejects authenticated role')
    const free = await call('issueLicense', { deviceId, deviceName: 'Temporary launch smoke', uid: randomUUID() }, desktopToken)
    check(free.response.status === 400 && free.data?.error?.status === 'FAILED_PRECONDITION', 'Unpaid account unexpectedly received a license')
    pass('unpaid account cannot obtain a paid license')
    const now = Date.now(), byok = { status: 'active', purchasedAt: now, paymentIntentId: `pi_smoke_${run}`, checkoutSessionId: `cs_smoke_${run}` }
    await setEntitlement({ plan: 'byok', status: 'active', byok, updatedAt: now })
    verifyLicense(await call('issueLicense', { deviceId, deviceName: 'Temporary launch smoke' }, desktopToken), 'byok')
    const gate = await http(`${gateway}/v1/responses`, { method: 'POST', headers: headers(desktopToken), body: JSON.stringify({ model: 'fast', input: 'Smoke admission only', max_output_tokens: 1 }) })
    if (gate.response.status === 503 && gate.data?.error?.code === 'provider_not_configured') { check(!inference, 'Live provider acceptance requested but provider is not configured'); skip('BYOK gateway admission: provider setup pending before authorization') }
    else { check(gate.response.status === 402 && gate.data?.error?.code === 'no_pro', 'BYOK account was not denied Pro admission'); pass('BYOK cannot use managed Pro inference') }
    await setEntitlement({ plan: 'pro', status: 'active', byok, updatedAt: now, pro: { status: 'active', subscriptionId: `sub_smoke_${run}`, priceLookupKey: 'faangin_pro_monthly', startedAt: now, currentPeriodStart: now, currentPeriodEnd: now + 30 * 86_400_000, cancelAtPeriodEnd: false, rampUntil: now - 1 } })
    verifyLicense(await call('issueLicense', { deviceId, deviceName: 'Temporary launch smoke' }, desktopToken), 'pro')
    if (inference) { await answer(); if (cancel) await answer(true); if (audio) await transcription() }
    else skip('live managed answer and cancellation (pass --inference [--cancel] to enable small billed requests)')
    skip('signup confirmation/recovery email delivery: this fixture bypasses email; verify separately with a real mailbox')
  } else skip('authenticated device/license flow (choose --authenticated or --sql-auth-fixture)')
} catch (error) {
  failed = true
  // Only our bounded labels leave the process; never print HTTP bodies, SQL, input values, or stacks.
  console.error(`FAIL ${error instanceof Error ? error.message.replace(/(?:sb_secret_|sbp_)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+/g, '[redacted]') : 'Acceptance check failed'}`)
} finally {
  try { await cleanup() } catch { failed = true; console.error(`FAIL temporary fixture cleanup; inspect only Auth/app rows tagged faangin_smoke=${run} and device_id=${deviceId}`) }
}
console.log(`${checks} checks passed; ${skipped} skipped; ${failed ? 'acceptance failed' : 'selected acceptance checks passed'}.`)
if (failed) process.exitCode = 1
