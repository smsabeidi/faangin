#!/usr/bin/env node
/**
 * Real paid sandbox acceptance. This script never pays, seeds entitlements, refunds, or cancels subscriptions.
 *
 * prepare --sql-auth-fixture --confirm-project uxgphdpcgcpgwbwfibkx [--plan byok|pro_monthly|pro_annual]
 * status [--verify-license --confirm-project uxgphdpcgcpgwbwfibkx --confirm-run <run-id>]
 * renew-checkout --confirm-project uxgphdpcgcpgwbwfibkx --confirm-run <run-id>
 * cleanup --confirm-project uxgphdpcgcpgwbwfibkx --confirm-run <printed-run-id>
 *
 * All commands use the exact project/account below. Default private JSON state is ignored by .env.*.
 * The owner completes the saved Checkout in a separate browser handoff, using only Stripe test payment data.
 * A confirmed SQL Auth fixture bypasses mail delivery; desktop UI/restart and endpoint HTTP delivery remain manual gates.
 */
import { randomUUID, createPublicKey, verify } from 'node:crypto'
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { parseArgs, parseEnv, promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Stripe, API_VERSION } from './lib/stripe-env.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PROJECT = 'uxgphdpcgcpgwbwfibkx', ACCOUNT = 'acct_1UVc6oRrWEBZT5Mj'
const BASE = `https://${PROJECT}.supabase.co`, API = `${BASE}/functions/v1/faangin-api`
const execute = promisify(execFile)
const PLANS = { byok: ['faangin_byok_v1', 1000], pro_monthly: ['faangin_pro_monthly_v2', 4999], pro_annual: ['faangin_pro_annual_v2', 35988] }
const LEGACY_PRO_PLANS = { pro_monthly: ['faangin_pro_monthly', 1499], pro_annual: ['faangin_pro_annual', 14400] }
class CheckError extends Error {}
const check = (ok, message) => { if (!ok) throw new CheckError(message) }
const q = value => `'${String(value).replaceAll("'", "''")}'`
const id = value => typeof value === 'string' ? value : value?.id
const isId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)
let lock, lockAcquired = false, statePath, state, pat, config, stripe

async function protectedFile(path) {
  const info = await lstat(path)
  check(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077), 'Private files must be regular, non-symlink files with mode 0600')
  check(process.getuid?.() === undefined || info.uid === process.getuid(), 'Private file is not owned by the current user')
  return readFile(path, 'utf8')
}
async function ignored(path) {
  try { await execute('git', ['check-ignore', '--quiet', '--', path], { cwd: ROOT }) }
  catch { throw new CheckError('Credential and state destinations must be gitignored') }
}
async function save() {
  const temporary = `${statePath}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, statePath) }
  finally { await unlink(temporary).catch(() => {}) }
}
async function http(url, init = {}) {
  let response
  try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(40_000) }) }
  catch { throw new CheckError('HTTP request failed or timed out; request and response withheld') }
  let data
  try { data = await response.json() } catch { data = null }
  return { status: response.status, ok: response.ok, data }
}
const headers = token => ({ apikey: config.publishableKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) })
async function sql(query) {
  const result = await http(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, { method: 'POST', headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  check(result.ok && Array.isArray(result.data), `Management SQL failed (HTTP ${result.status}); query and response withheld`)
  return result.data
}
async function cli(args) {
  // Force the approved OAuth login rather than an ambient API-key override. Never extract its stored token.
  const env = { ...process.env }; delete env.STRIPE_API_KEY; delete env.STRIPE_SECRET_KEY
  let output
  try { output = (await execute('stripe', args, { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout }
  catch { throw new CheckError('Stripe CLI request failed; output withheld') }
  let data
  try { data = JSON.parse(output.slice(output.search(/^\{/m))) } catch { throw new CheckError('Stripe CLI response was not JSON; output withheld') }
  check(!data.error && data.livemode !== true && !data.data?.some?.(row => row.livemode === true), 'Stripe rejected the request or returned live data; body withheld')
  return data
}
async function accountGuard() {
  const identity = await cli(['whoami', '--format', 'json'])
  check(identity.authorized === true && identity.mode === 'test' && identity.account_id === ACCOUNT, 'Stripe CLI must be authorized in test mode for Selmou AI sandbox')
}
async function cliRequest(method, path, fields = []) {
  return cli([method, path, '--color', 'off', '--stripe-version', API_VERSION, ...(method === 'get' ? [] : ['--confirm']), ...fields.flatMap(value => ['-d', value])])
}
async function authenticated(forceRefresh = false) {
  if (!forceRefresh && state.accessToken && state.expiresAt > Date.now() + 60_000) return state.accessToken
  check(state.refreshToken, 'Fixture has no saved Auth session; use owned cleanup and start a new run')
  const result = await http(`${BASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: state.refreshToken }) })
  const lifetime = Number(result.data?.expires_in)
  check(result.ok && result.data?.user?.id === state.uid && typeof result.data.access_token === 'string' && result.data.access_token.length > 0 && typeof result.data.refresh_token === 'string' && result.data.refresh_token.length > 0 && Number.isFinite(lifetime) && lifetime > 60 && lifetime <= 86_400, 'Fixture Auth refresh failed; credentials withheld')
  state.accessToken = result.data.access_token; state.refreshToken = result.data.refresh_token
  state.expiresAt = Date.now() + Number(result.data.expires_in) * 1000
  await save(); return state.accessToken
}
async function call(route, data) {
  return http(`${API}/${route}`, { method: 'POST', headers: headers(await authenticated()), body: JSON.stringify({ data }) })
}
function validateState() {
  check(state?.v === 1 && state.project === PROJECT && state.account === ACCOUNT && /^[a-f0-9]{32}$/.test(state.run), 'Private state does not identify this acceptance workflow')
  check(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.uid) && state.email === `faangin-billing+${state.run}@example.com` && state.deviceId === `billing_${state.run}` && Object.hasOwn(PLANS, state.plan), 'Private fixture identity is invalid')
}
async function ownedFixture() {
  const rows = await sql(`select id from auth.users where id=${q(state.uid)}::uuid and email=${q(state.email)} and raw_app_meta_data->>'faangin_billing_acceptance'=${q(state.run)}`)
  check(rows.length === 1, 'Exact owned Auth fixture was not found; no unrelated account will be used')
}
async function createFixture() {
  const columns = await sql("select table_name,column_name,data_type,is_nullable,column_default,is_generated from information_schema.columns where table_schema='auth' and table_name in ('users','identities') order by table_name,ordinal_position")
  const users = new Map(columns.filter(row => row.table_name === 'users').map(row => [row.column_name, row]))
  const identities = new Map(columns.filter(row => row.table_name === 'identities').map(row => [row.column_name, row]))
  const user = { id: `${q(state.uid)}::uuid`, instance_id: "'00000000-0000-0000-0000-000000000000'::uuid", aud: "'authenticated'", role: "'authenticated'", email: q(state.email), encrypted_password: 'fixture_hash', email_confirmed_at: 'now()', raw_app_meta_data: `${q(JSON.stringify({ provider: 'email', providers: ['email'], faangin_billing_acceptance: state.run }))}::jsonb`, raw_user_meta_data: "'{}'::jsonb", created_at: 'now()', updated_at: 'now()', confirmation_token: "''", recovery_token: "''", email_change_token_new: "''", email_change_token_current: "''", email_change: "''", phone_change_token: "''", phone_change: "''", reauthentication_token: "''", is_sso_user: 'false', is_anonymous: 'false' }
  const identity = { id: 'gen_random_uuid()', provider_id: q(state.uid), user_id: `${q(state.uid)}::uuid`, provider: "'email'", identity_data: `${q(JSON.stringify({ sub: state.uid, email: state.email, email_verified: true, phone_verified: false }))}::jsonb`, last_sign_in_at: 'now()', created_at: 'now()', updated_at: 'now()' }
  for (const name of ['id', 'email', 'encrypted_password', 'email_confirmed_at', 'raw_app_meta_data']) check(users.has(name), 'Unsupported managed Auth schema')
  for (const name of ['id', 'provider_id', 'user_id', 'provider', 'identity_data']) check(identities.has(name), 'Unsupported managed Auth identity schema')
  check(users.get('id').data_type === 'uuid' && identities.get('id').data_type === 'uuid', 'Unsupported managed Auth identity types')
  for (const [known, values] of [[users, user], [identities, identity]]) for (const column of known.values()) {
    if (column.is_nullable === 'NO' && !column.column_default && column.is_generated === 'NEVER') check(Object.hasOwn(values, column.column_name), 'Managed Auth has an unknown required column')
  }
  const crypto = await sql("select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'")
  check(crypto.length === 1 && ['extensions', 'public'].includes(crypto[0].nspname), 'A supported existing pgcrypto installation is required')
  const schema = crypto[0].nspname
  user.encrypted_password = `${schema}.crypt(s.password,${schema}.gen_salt('bf',10))`
  const entries = (fields, known) => Object.entries(fields).filter(([key]) => known.has(key))
  const u = entries(user, users), i = entries(identity, identities)
  // Generate the password inside Postgres so it never appears in query text, process arguments, or logs.
  const created = await sql(`with secret as materialized (select encode(${schema}.gen_random_bytes(32),'hex') as password), created_user as (insert into auth.users(${u.map(([key]) => key).join(',')}) select ${u.map(([, value]) => value).join(',')} from secret s returning id), created_identity as (insert into auth.identities(${i.map(([key]) => key).join(',')}) select ${i.map(([, value]) => value).join(',')} from created_user returning user_id) select s.password from secret s cross join created_identity`)
  check(created.length === 1 && typeof created[0].password === 'string', 'Owned SQL Auth fixture creation failed')
  state.phase = 'fixture-created'; await save()
  const login = await http(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: state.email, password: created[0].password }) })
  created[0].password = undefined
  check(login.ok && login.data?.user?.id === state.uid && login.data.access_token && login.data.refresh_token, 'Owned Auth password session failed')
  state.accessToken = login.data.access_token; state.refreshToken = login.data.refresh_token
  state.expiresAt = Date.now() + Number(login.data.expires_in) * 1000; state.phase = 'authenticated'; await save()
}
async function discoverCheckout() {
  const mappings = await sql(`select stripe_customer_id from faangin.customers where uid=${q(state.uid)}::uuid`)
  if (!mappings.length) return null
  check(mappings.length === 1 && isId(mappings[0].stripe_customer_id, 'cus'), 'Fixture customer mapping is invalid')
  const customer = mappings[0].stripe_customer_id
  check(!state.customerId || state.customerId === customer, 'Fixture customer mapping changed')
  state.customerId = customer; await save()
  if (!state.checkoutId) {
    const candidates = []
    for await (const session of stripe.checkout.sessions.list({ customer, limit: 100 })) {
      check(session.livemode === false && session.metadata?.uid === state.uid, 'Customer contains a foreign Checkout; review privately')
      if (session.metadata.plan === state.plan && session.created >= Math.floor(state.createdAt / 1000) - 5) candidates.push(session)
    }
    check(candidates.length <= 1, 'Multiple owned Checkout candidates require private review')
    if (!candidates.length) return null
    state.checkoutId = candidates[0].id; state.checkoutUrl ??= candidates[0].url; await save()
  }
  check(isId(state.checkoutId, 'cs_test'), 'Expected a test-mode Checkout ID')
  const session = await stripe.checkout.sessions.retrieve(state.checkoutId)
  check(session.livemode === false && id(session.customer) === customer && session.client_reference_id === state.uid && session.metadata?.uid === state.uid && session.metadata.plan === state.plan, 'Checkout ownership, mode, or plan does not match the fixture')
  return session
}
function ownedUnpaidCheckout(session, expectedId) {
  check(session?.id === expectedId && isId(session.id, 'cs_test') && session.livemode === false && id(session.customer) === state.customerId && session.client_reference_id === state.uid && session.metadata?.uid === state.uid && session.metadata.plan === state.plan && session.mode === (state.plan === 'byok' ? 'payment' : 'subscription'), 'Checkout identity, customer, mode, or metadata does not match the exact unpaid fixture')
  check(session.payment_status === 'unpaid', 'Renewal refuses paid, no-payment-required, or unknown payment states')
}
async function expectedCheckoutPrice(session, allowLegacy = false) {
  const items = []
  for await (const item of stripe.checkout.sessions.listLineItems(session.id, { limit: 100 })) {
    check(items.length < 2, 'Fixture Checkout has too many line items'); items.push(item)
  }
  const lookupKey = items[0]?.price?.lookup_key
  const matches = expected => expected && lookupKey === expected[0] && session.amount_subtotal === expected[1]
  check(items.length === 1 && items[0].quantity === 1 && session.currency === 'usd'
    && (matches(PLANS[state.plan]) || (allowLegacy && matches(LEGACY_PRO_PLANS[state.plan]))), 'Fixture Checkout price, quantity, currency, or subtotal is unexpected')
  return lookupKey
}
async function renewCheckout() {
  check(state.phase === 'checkout-ready' && !state.eventId && !state.verifiedAt && !state.subscriptionId && !state.pendingCheckoutUrl, 'Only an unverified prepared fixture can renew; ambiguous or completed runs require management-backed review')
  check(!state.checkoutHistory || Array.isArray(state.checkoutHistory), 'Private Checkout history requires review before renewal')
  check(isId(state.customerId, 'cus') && isId(state.checkoutId, 'cs_test'), 'Renewal needs the saved exact customer and test Checkout identities')
  const oldId = state.checkoutId
  const old = await stripe.checkout.sessions.retrieve(oldId)
  ownedUnpaidCheckout(old, oldId)
  check(old.status === 'expired', 'Renewal requires the old Checkout to be expired; open, completed, or unknown sessions are refused')
  await expectedCheckoutPrice(old, true)
  // The approved webhook read key intentionally has no Customers permission. Use only the
  // existing accountGuard-verified OAuth CLI for this exact read; do not broaden that key.
  const customer = await cliRequest('get', `/v1/customers/${state.customerId}`)
  check(!customer.deleted && customer.id === state.customerId && customer.livemode === false && customer.metadata?.uid === state.uid && customer.email === state.email, 'Stripe customer does not match the exact saved sandbox fixture')
  let seen = 0, foundOld = false
  for await (const session of stripe.checkout.sessions.list({ customer: state.customerId, limit: 100 })) {
    check(++seen <= 100, 'Fixture Checkout history exceeds the bounded renewal review')
    ownedUnpaidCheckout(session, session.id)
    check(session.status === 'expired', 'Another open, completed, or unknown Checkout exists; renewal will not expire or replace it')
    if (session.id === oldId) foundOld = true
  }
  check(foundOld, 'The saved expired Checkout was not found under the owned customer')
  let subscriptions = 0
  for await (const subscription of stripe.subscriptions.list({ customer: state.customerId, status: 'all', limit: 100 })) {
    check(++subscriptions <= 100 && subscription.livemode === false && id(subscription.customer) === state.customerId, 'Fixture subscription ownership is unknown')
    throw new CheckError('Fixture already has a subscription; management-backed status and cleanup are required')
  }
  let charges = 0
  for await (const charge of stripe.charges.list({ customer: state.customerId, limit: 100 })) check(++charges <= 100 && charge.livemode === false && id(charge.customer) === state.customerId && charge.paid === false, 'Fixture has a paid or unknown charge; management-backed status and cleanup are required')
  // Refresh even a cached access token, persist its rotated refresh credential, and verify the
  // permanent user's server-owned marker. No management PAT or direct database read is needed.
  const token = await authenticated(true)
  const user = await http(`${BASE}/auth/v1/user`, { headers: headers(token) })
  check(user.ok && user.data?.id === state.uid && user.data.email === state.email && user.data.email_confirmed_at && user.data.is_anonymous !== true && user.data.app_metadata?.faangin_billing_acceptance === state.run, 'Authoritative Auth identity or server-owned fixture marker did not match; no Checkout was requested')
  const requestedAt = Date.now()
  state.phase = 'checkout-renewal-requested'; state.renewalRequestedAt = requestedAt; await save()
  const created = await call('createCheckoutSession', { plan: state.plan })
  check(created.ok && typeof created.data?.result?.url === 'string', 'App renewal failed or is ambiguous; do not retry until management-backed review')
  const url = new URL(created.data.result.url)
  check(url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password, 'App returned an unexpected renewal destination; private review is required')
  state.pendingCheckoutUrl = url.href; await save()
  const candidates = []
  seen = 0
  for await (const session of stripe.checkout.sessions.list({ customer: state.customerId, limit: 100 })) {
    check(++seen <= 100, 'Renewed Checkout history exceeds the bounded review')
    ownedUnpaidCheckout(session, session.id)
    if (session.status === 'open') {
      check(session.id !== oldId && session.url === url.href, 'An unexpected open Checkout appeared; review the private pending URL before taking any further action')
      candidates.push(session)
    } else check(session.status === 'expired', 'A completed or unknown Checkout appeared during renewal; private review is required')
  }
  check(candidates.length === 1, 'App renewal could not be identified uniquely; private pending state is retained and automatic retry is refused')
  const renewed = candidates[0]
  check(renewed.created >= Math.floor(requestedAt / 1000) - 5 && Number.isSafeInteger(renewed.expires_at) && renewed.expires_at * 1000 > Date.now(), 'Renewed Checkout time or expiry is invalid')
  await expectedCheckoutPrice(renewed)
  state.checkoutHistory = [...(state.checkoutHistory ?? []), { checkoutId: oldId, status: 'expired', paymentStatus: 'unpaid', replacedAt: Date.now() }]
  state.checkoutId = renewed.id; state.checkoutUrl = renewed.url; state.pendingCheckoutUrl = undefined
  state.phase = 'checkout-ready'; state.renewedAt = Date.now(); await save()
  return { run: state.run, phase: state.phase, previousCheckoutId: oldId, checkoutId: renewed.id, customerId: state.customerId, plan: state.plan, privateStateFile: statePath, paymentCreated: false, managementAccessUsed: false, handoffWritten: false, note: 'Only the same private fixture JSON was updated. No payment or handoff was created. Status and cleanup still require a renewed management PAT.' }
}
async function checkoutEvent() {
  if (state.eventId) {
    check(isId(state.eventId, 'evt'), 'Saved event identity is invalid')
    const event = await cliRequest('get', `/v1/events/${state.eventId}`)
    check(event.livemode === false && event.type === 'checkout.session.completed' && event.data?.object?.id === state.checkoutId, 'Saved event does not match this test Checkout')
    return event
  }
  let cursor
  for (let page = 0; page < 10; page++) {
    const result = await cliRequest('get', '/v1/events', ['type=checkout.session.completed', `created[gte]=${Math.floor(state.createdAt / 1000) - 5}`, 'limit=100', ...(cursor ? [`starting_after=${cursor}`] : [])])
    for (const event of result.data ?? []) if (event.data?.object?.id === state.checkoutId) {
      check(event.livemode === false && id(event.data.object.customer) === state.customerId, 'Checkout event ownership mismatch')
      state.eventId = event.id; await save(); return event
    }
    if (!result.has_more) return null
    cursor = result.data.at(-1)?.id; check(isId(cursor, 'evt'), 'Event pagination returned an invalid cursor')
  }
  throw new CheckError('Event search reached its bounded limit; review this owned Checkout privately')
}
function signature(token, plan) {
  const [version, encoded, signed, ...extra] = String(token).split('.')
  check(version === 'v1' && encoded && signed && !extra.length, 'License envelope is invalid')
  const bytes = Buffer.from(encoded, 'base64url')
  check(config.licensePublicKeys.some(key => { try { return verify(null, bytes, createPublicKey({ key: Buffer.from(key, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signed, 'base64url')) } catch { return false } }), 'License signature did not match release keys')
  const payload = JSON.parse(bytes.toString('utf8'))
  check(payload.v === 1 && payload.uid === state.uid && payload.deviceId === state.deviceId && payload.plan === plan && ['active', 'past_due'].includes(payload.status) && [payload.iat, payload.exp, payload.grace].every(Number.isFinite) && payload.iat >= 0 && payload.iat <= Date.now() + 300_000 && payload.exp > payload.iat && payload.exp > Date.now() && payload.grace >= payload.exp, 'Signed license identity, product, or validity is incorrect')
}
async function status(verifyLicense = false) {
  await ownedFixture()
  const session = await discoverCheckout()
  if (!session) return { run: state.run, phase: state.phase, readyForPayment: false, note: 'No owned Checkout found; use cleanup before a new prepare' }
  const result = { run: state.run, uid: state.uid, customerId: state.customerId, checkoutId: state.checkoutId, plan: state.plan, checkoutStatus: session.status, paymentStatus: session.payment_status, paidFulfillmentVerified: false, deliveryHttpVerified: false, emailDeliveryVerified: false, desktopUiVerified: false }
  if (session.status !== 'complete' || session.payment_status !== 'paid') return result
  const lookupKey = await expectedCheckoutPrice(session, true)
  const document = (await sql(`select document from faangin.entitlements where uid=${q(state.uid)}::uuid`))[0]?.document
  const plan = state.plan === 'byok' ? 'byok' : 'pro'
  if (plan === 'byok') check(document?.byok?.checkoutSessionId === session.id && document.byok.paymentIntentId === id(session.payment_intent) && document.byok.status === 'active', 'Paid BYOK fulfillment has not settled as active ownership')
  else {
    const subscription = await stripe.subscriptions.retrieve(id(session.subscription))
    check(subscription.livemode === false && id(subscription.customer) === state.customerId && subscription.metadata?.uid === state.uid && subscription.items.data[0]?.price.lookup_key === lookupKey, 'Paid subscription ownership or price is incorrect')
    check(document?.pro?.subscriptionId === subscription.id && ['active', 'past_due'].includes(document.pro.status), 'Paid Pro fulfillment has not settled as active ownership')
    state.subscriptionId = subscription.id
  }
  const invoiceId = id(session.invoice)
  check(isId(invoiceId, 'in'), 'Paid Checkout has no expected invoice')
  const invoice = await stripe.invoices.retrieve(invoiceId)
  check(invoice.livemode === false && id(invoice.customer) === state.customerId && invoice.status === 'paid', 'Owned paid invoice is not settled')
  const event = await checkoutEvent()
  check(event, 'Actual Checkout completion event has not been found yet')
  const processed = (await sql(`select event_type,processed_at,outcome from faangin.stripe_events where event_id=${q(event.id)}`))[0]
  check(processed?.event_type === event.type && processed.processed_at && processed.outcome === 'applied', 'The actual Checkout event is not processed/applied by the deployed webhook yet')
  if (verifyLicense) {
    // This explicit opt-in registers/touches the disposable device. Ordinary status performs reads only.
    const license = await call('issueLicense', { deviceId: state.deviceId, deviceName: 'Disposable billing acceptance' })
    check(license.ok && license.data?.result?.plan === plan, 'Actual paid entitlement did not issue the expected license')
    signature(license.data.result.token, plan)
    state.phase = 'paid-verified'; state.verifiedAt = Date.now(); await save()
  }
  return { ...result, eventId: event.id, invoiceId, subscriptionId: state.subscriptionId, paidEventApplied: true, entitlementVerified: true, signedLicenseVerified: verifyLicense, duplicatePurchaseBlocked: false, paidFulfillmentVerified: verifyLicense, note: 'Workbench endpoint HTTP 2xx, duplicate purchase rejection, mail, desktop UI/restart, upgrade/fallback and replay remain separate checks' }
}
async function cleanup() {
  const rows = await sql(`select id from auth.users where id=${q(state.uid)}::uuid and email=${q(state.email)} and raw_app_meta_data->>'faangin_billing_acceptance'=${q(state.run)}`)
  if (rows.length) {
    const session = await discoverCheckout()
    if (session?.status === 'open') await cliRequest('post', `/v1/checkout/sessions/${session.id}/expire`)
    if (state.customerId) {
      for await (const checkout of stripe.checkout.sessions.list({ customer: state.customerId, limit: 100 })) check(checkout.livemode === false && checkout.metadata?.uid === state.uid && checkout.status !== 'open', 'An owned or foreign Checkout is still open; review it before cleanup')
      for await (const subscription of stripe.subscriptions.list({ customer: state.customerId, status: 'all', limit: 100 })) check(subscription.livemode === false && ['canceled', 'incomplete_expired'].includes(subscription.status), 'Cancel owned sandbox subscriptions and wait for their webhooks before cleanup')
      for await (const charge of stripe.charges.list({ customer: state.customerId, limit: 100 })) check(charge.livemode === false && (!charge.paid || charge.refunded === true), 'Refund owned paid sandbox charges and wait for their webhooks before cleanup')
    }
    const doc = (await sql(`select document from faangin.entitlements where uid=${q(state.uid)}::uuid`))[0]?.document
    check(!doc || doc.plan === 'none' || ['canceled', 'revoked'].includes(doc.status), 'Entitlement is still live; wait for cancellation/refund fulfillment before cleanup')
    // Never delete the Stripe customer here: that can cancel subscriptions if provider state changes.
    // The exact marker, uid, email and mapping are rechecked inside the deletion transaction.
    await sql(`begin; do $cleanup$ declare fixture uuid; document jsonb; begin
      select id into fixture from auth.users where id=${q(state.uid)}::uuid and email=${q(state.email)} and raw_app_meta_data->>'faangin_billing_acceptance'=${q(state.run)};
      if fixture is null then raise exception 'Owned fixture missing'; end if;
      perform pg_advisory_xact_lock(hashtextextended(fixture::text,0));
      select e.document into document from faangin.entitlements e where uid=fixture;
      if document->>'plan'<>'none' and document->>'status' in ('active','past_due') then raise exception 'Owned entitlement is live'; end if;
      if exists(select 1 from faangin.customers where uid=fixture and stripe_customer_id<>${q(state.customerId ?? '')}) then raise exception 'Mapping changed'; end if;
      delete from faangin.gateway_leases where uid=fixture; delete from faangin.gateway_usage where uid=fixture;
      delete from faangin.checkout_leases where uid=fixture; delete from faangin.device_codes where uid=fixture;
      delete from faangin.devices where uid=fixture; delete from faangin.customers where uid=fixture; delete from faangin.entitlements where uid=fixture;
      delete from auth.sessions where user_id=fixture; delete from auth.refresh_tokens where user_id::text=fixture::text;
      delete from auth.identities where user_id=fixture; delete from auth.users where id=fixture;
    end $cleanup$; commit;`)
  }
  state.accessToken = state.refreshToken = state.checkoutUrl = undefined; state.phase = 'cleaned'; await save()
  return { run: state.run, phase: 'cleaned', auditEventsRetained: true, stripeCustomerRetained: Boolean(state.customerId) }
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, 'env-file': { type: 'string' }, 'runtime-env-file': { type: 'string' }, state: { type: 'string' }, plan: { type: 'string' }, 'sql-auth-fixture': { type: 'boolean' }, 'verify-license': { type: 'boolean' }, 'confirm-project': { type: 'string' }, 'confirm-run': { type: 'string' } } })
  if (values.help) {
    console.log('Usage: node backend/scripts/supabase-billing-acceptance.mjs prepare|status|renew-checkout|cleanup [--state <ignored-0600-json>] [--env-file <ignored-0600-env>] [--runtime-env-file <ignored-0600-env>]')
    console.log(`prepare requires --sql-auth-fixture --confirm-project ${PROJECT} [--plan byok|pro_monthly|pro_annual]. cleanup requires --confirm-project ${PROJECT} --confirm-run <run-id>; it expires the owned open Checkout, removes settled SQL fixtures, and retains the Stripe customer/audit events. status only reads provider/account data and saves private local state. --verify-license additionally registers/touches the fixture device and requires matching project/run confirmations. No command pays, refunds, cancels subscriptions, or deletes Stripe customers.`)
    console.log('renew-checkout requires matching --confirm-project and --confirm-run, the existing protected fixture refresh session, and the approved restricted Stripe read key. It only renews the exact expired unpaid sandbox fixture through the app route, writes no handoff, and does not use the management PAT. Ambiguous renewals require management-backed review; status and cleanup still need management access.')
  } else {
    const command = positionals[0]; check(positionals.length === 1 && ['prepare', 'status', 'renew-checkout', 'cleanup'].includes(command), 'Choose prepare, status, renew-checkout, or cleanup; use --help')
    check(!values['verify-license'] || command === 'status', '--verify-license is supported only with status')
    if (command === 'prepare') check(values['confirm-project'] === PROJECT && values['sql-auth-fixture'] === true, 'Prepare requires explicit project and confirmed SQL Auth fixture flags')
    if (command === 'renew-checkout') check(values['confirm-project'] === PROJECT && values['confirm-run'] && !values.plan && !values['sql-auth-fixture'], 'Renewal requires explicit project/run confirmation and cannot change the plan or create an Auth fixture')
    statePath = resolve(values.state ?? resolve(ROOT, 'backend/.env.supabase-billing-acceptance.local.json'))
    const envPath = resolve(values['env-file'] ?? resolve(ROOT, 'backend/.env.supabase.local'))
    const runtimePath = resolve(values['runtime-env-file'] ?? resolve(ROOT, 'backend/.env.stripe-runtime.local'))
    await ignored(statePath); if (command !== 'renew-checkout') await ignored(envPath); await ignored(runtimePath)
    check(statePath !== envPath && statePath !== runtimePath, 'State must not overwrite a credential file')
    lock = `${statePath}.lock`; await writeFile(lock, String(process.pid), { mode: 0o600, flag: 'wx' }); lockAcquired = true
    const runtime = parseEnv(await protectedFile(runtimePath))
    if (command !== 'renew-checkout') {
      const env = parseEnv(await protectedFile(envPath))
      pat = env.SUPABASE_ACCESS_TOKEN; check(pat?.startsWith('sbp_'), 'Protected env requires the scoped management PAT')
    }
    check(runtime.STRIPE_WEBHOOK_KEY?.startsWith('rk_test_'), 'Protected runtime env requires the approved restricted test webhook key')
    config = JSON.parse(await readFile(resolve(ROOT, 'config/cloud.supabase.json'), 'utf8'))
    check(config.supabaseUrl === BASE && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) && Array.isArray(config.licensePublicKeys) && config.licensePublicKeys.length, 'Public config must match the exact target project and license keys')
    stripe = new Stripe(runtime.STRIPE_WEBHOOK_KEY, { apiVersion: API_VERSION, timeout: 20_000, maxNetworkRetries: 1 })
    if (command === 'renew-checkout') {
      state = JSON.parse(await protectedFile(statePath)); validateState()
      check(values['confirm-run'] === state.run, 'Renewal requires the exact matching run ID')
      await accountGuard()
      console.log(JSON.stringify(await renewCheckout(), null, 2))
    } else if (command === 'prepare') {
      await accountGuard()
      try { await lstat(statePath); throw new CheckError('Private state already exists; use status/cleanup or a new ignored state path') } catch (error) { if (error.code !== 'ENOENT') throw error }
      const health = await http(`${API}/health`, { headers: headers() })
      check(health.ok && health.data?.billingConfigured === true && health.data.licenseConfigured === true, 'Deployed billing and licensing must be configured before preparing a purchase')
      const run = randomUUID().replaceAll('-', ''), plan = values.plan ?? 'byok'; check(Object.hasOwn(PLANS, plan), 'Unsupported plan')
      state = { v: 1, project: PROJECT, account: ACCOUNT, run, uid: randomUUID(), email: `faangin-billing+${run}@example.com`, deviceId: `billing_${run}`, plan, createdAt: Date.now(), phase: 'fixture-attempted' }; await save()
      await createFixture()
      const unpaid = await call('issueLicense', { deviceId: state.deviceId, deviceName: 'Disposable billing acceptance' })
      check(unpaid.status === 400 && unpaid.data?.error?.status === 'FAILED_PRECONDITION', 'Unpaid fixture unexpectedly received a license')
      state.phase = 'checkout-requested'; await save()
      const created = await call('createCheckoutSession', { plan })
      check(created.ok && typeof created.data?.result?.url === 'string', 'App-created Checkout failed; status can recover an ambiguous owned session')
      const url = new URL(created.data.result.url); check(url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password, 'App returned an unexpected Checkout destination')
      state.checkoutUrl = url.href; await save()
      const session = await discoverCheckout(); check(session && session.url === state.checkoutUrl && session.status === 'open', 'App-created Checkout was not found as an owned open test session')
      await expectedCheckoutPrice(session)
      state.phase = 'checkout-ready'; await save()
      console.log(JSON.stringify({ run, phase: state.phase, uid: state.uid, customerId: state.customerId, checkoutId: state.checkoutId, plan, privateStateFile: statePath, paymentCreated: false, note: 'Owner must complete the private saved sandbox Checkout separately; URL and credentials withheld' }, null, 2))
    } else {
      await accountGuard()
      state = JSON.parse(await protectedFile(statePath)); validateState()
      check(state.phase !== 'cleaned', 'This run is already cleaned; choose a new private state path')
      if (command === 'cleanup') check(values['confirm-project'] === PROJECT && values['confirm-run'] === state.run, 'Cleanup requires explicit matching project and run ID')
      if (values['verify-license']) check(command === 'status' && values['confirm-project'] === PROJECT && values['confirm-run'] === state.run, 'License verification requires status and explicit matching project and run ID')
      console.log(JSON.stringify(await (command === 'cleanup' ? cleanup() : status(values['verify-license'] === true)), null, 2))
    }
  }
} catch (error) {
  console.error(error instanceof CheckError ? error.message : 'Billing acceptance failed; provider details, state contents and credentials withheld')
  process.exitCode = 1
} finally { if (lockAcquired) await unlink(lock).catch(() => {}) }
