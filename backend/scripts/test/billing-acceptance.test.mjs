import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../supabase-billing-acceptance.mjs'), 'utf8')
const project = 'uxgphdpcgcpgwbwfibkx', account = 'acct_1UVc6oRrWEBZT5Mj'
const run = 'a'.repeat(32), uid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// All processes execute a copied script whose SDK, child processes and HTTP are local fakes.
// No installed CLI or remote service is reachable through these fakes.
function fixture(scenario = 'paid') {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-paid-acceptance-'))
  const scripts = join(dir, 'backend/scripts'), statePath = join(dir, 'backend/.env.acceptance.local.json')
  mkdirSync(scripts, { recursive: true }); mkdirSync(join(dir, 'config'))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  writeFileSync(join(dir, 'config/cloud.supabase.json'), JSON.stringify({ supabaseUrl: `https://${project}.supabase.co`, publishableKey: 'sb_publishable_fixture', licensePublicKeys: [publicDer] }))
  const credentials = ['sbp_' + 'privatefixture', 'rk_test_' + 'privatefixture', 'access-private-fixture', 'refresh-private-fixture', 'access-private-renewed', 'refresh-private-renewed']
  writeFileSync(join(dir, 'backend/.env.supabase.local'), `SUPABASE_ACCESS_TOKEN=${credentials[0]}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'backend/.env.stripe-runtime.local'), `STRIPE_WEBHOOK_KEY=${credentials[1]}\n`, { mode: 0o600 })
  const state = { v: 1, project, account, run, uid, email: `faangin-billing+${run}@example.com`, deviceId: `billing_${run}`, plan: 'byok', createdAt: Date.now() - 1000, phase: 'checkout-ready', customerId: 'cus_fixture', checkoutId: 'cs_test_fixture', checkoutUrl: 'https://checkout.stripe.com/private-fixture-url', accessToken: credentials[2], refreshToken: credentials[3], expiresAt: Date.now() + 3600000 }
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
  writeFileSync(join(dir, 'backend/.env.fake-signing-key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(join(scripts, 'acceptance.mjs'), source.replace("import { execFile } from 'node:child_process'", "import { execFile } from './mock.mjs'").replace("'./lib/stripe-env.mjs'", "'./mock.mjs'"))
  writeFileSync(join(scripts, 'mock.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs'
import { sign } from 'node:crypto'
const trace = value => appendFileSync(process.env.TRACE, value + '\\n')
const scenario = process.env.SCENARIO, uid = ${JSON.stringify(uid)}, run = ${JSON.stringify(run)}
export const API_VERSION = 'fixture'
let expired = false, renewed = false
const renewing = scenario.startsWith('renew-')
const checkout = (fresh=false) => ({ id:fresh?'cs_test_renewed':'cs_test_fixture', livemode:scenario==='renew-old-live', customer:scenario==='foreign'?'cus_other':'cus_fixture', client_reference_id:uid, metadata:{uid,plan:'byok'}, mode:scenario==='renew-wrong-mode'?'subscription':'payment', created:Math.floor(Date.now()/1000), expires_at:Math.floor(Date.now()/1000)+2700,
 status:fresh?'open':renewing?(scenario==='renew-completed'?'complete':scenario==='renew-open'?'open':scenario==='renew-unknown-status'?'unknown':'expired'):scenario==='open'&&!expired?'open':'complete',
 payment_status:fresh?'unpaid':renewing?(scenario==='renew-paid-expired'||scenario==='renew-completed'?'paid':scenario==='renew-unknown-payment'?'unknown':'unpaid'):scenario==='open'?'unpaid':'paid',
 payment_intent:'pi_fixture', invoice:'in_fixture', currency:scenario==='wrong-currency'?'eur':'usd', amount_subtotal:1000, url:fresh?'https://checkout.stripe.com/private-renewed-url':'https://checkout.stripe.com/private-fixture-url' })
const checkouts = () => {
 const rows=[checkout()]
 if(renewed&&scenario!=='renew-ambiguous')rows.push(checkout(true))
 if(scenario==='renew-open-sibling')rows.push({...checkout(),id:'cs_test_sibling',status:'open'})
 if(scenario==='renew-foreign-sibling')rows.push({...checkout(),id:'cs_test_sibling',metadata:{uid:'foreign',plan:'byok'}})
 return rows
}
const iterable = values => ({ async *[Symbol.asyncIterator]() { for(const value of values) yield value } })
export class Stripe {
 constructor() {
  this.checkout = { sessions: {
   retrieve:async () => { trace('read:checkout'); return checkout() },
   list:() => { trace('read:checkouts'); return iterable(checkouts()) },
   listLineItems:() => { trace('read:line-items'); return iterable([{quantity:1,price:{lookup_key:'faangin_byok_v1'}}]) }
  } }
  // Match the approved restricted webhook key: Customers=None. A regression to SDK customer
  // reads must fail the successful renewal test, rather than silently receiving a broad fake key.
  this.customers = { retrieve:async()=>{trace('sdk:customer-read-denied');throw Object.assign(new Error('Restricted key Customers=None'),{statusCode:403})} }
  this.subscriptions = { list:() => { trace('read:subscriptions'); return iterable(['active-sub','renew-live-sub'].includes(scenario)?[{livemode:false,status:'active',customer:'cus_fixture'}]:[]) } }
  this.charges = { list:() => { trace('read:charges'); return iterable(scenario==='renew-paid-charge'?[{livemode:false,customer:'cus_fixture',paid:true}]:[]) } }
  this.invoices = { retrieve:async () => { trace('read:invoice'); return {livemode:false,customer:'cus_fixture',status:'paid'} } }
 }
}
export function execFile(binary, args, options, callback) {
 trace('cli:'+binary+':'+args[0]+':'+(args[1]??''))
 if(binary==='git'&&args[0]==='check-ignore') return callback(null,{stdout:'',stderr:''})
 if(binary!=='stripe') return callback(new Error('Unexpected local process'))
 let data
 if(args[0]==='whoami') data={authorized:true,mode:scenario==='live'?'live':'test',account_id:scenario==='renew-wrong-account'?'acct_other':${JSON.stringify(account)}}
 else if(args[0]==='get'&&args[1]==='/v1/customers/cus_fixture') {
  if(scenario==='renew-customer-read-denied')return callback(new Error('OAuth exact customer read denied'))
  data={id:'cus_fixture',livemode:false,email:'faangin-billing+'+run+'@example.com',metadata:{uid:scenario==='renew-foreign-customer'?'foreign':uid}}
 }
 else if(args[0]==='get'&&args[1]==='/v1/events') data={data:[{id:'evt_fixture',type:'checkout.session.completed',livemode:false,data:{object:checkout()}}],has_more:false}
 else if(args[0]==='post'&&args[1]==='/v1/checkout/sessions/cs_test_fixture/expire') {expired=true;data={id:'cs_test_fixture',livemode:false,status:'expired'}}
 else return callback(new Error('Unexpected CLI operation'))
 callback(null,{stdout:JSON.stringify(data),stderr:''})
}
globalThis.fetch = async (url, init) => {
 const response = (data,status=200) => ({ok:status>=200&&status<300,status,json:async()=>data})
 if(url==='https://${project}.supabase.co/auth/v1/token?grant_type=refresh_token') {
  trace('auth:refresh')
  if(scenario==='renew-refresh-rejected')return response({},401)
  return response({user:{id:uid},access_token:'access-private-renewed',refresh_token:'refresh-private-renewed',expires_in:3600})
 }
 if(url==='https://${project}.supabase.co/auth/v1/user') {
  trace('auth:identity')
  return response({id:scenario==='renew-wrong-auth'?'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee':uid,email:'faangin-billing+'+run+'@example.com',email_confirmed_at:'2026-01-01',is_anonymous:false,app_metadata:{faangin_billing_acceptance:scenario==='renew-wrong-marker'?'other-run':run}})
 }
 if(url==='https://${project}.supabase.co/functions/v1/faangin-api/createCheckoutSession') {
  trace('app:createCheckoutSession')
  if(JSON.stringify(JSON.parse(init.body))!==JSON.stringify({data:{plan:'byok'}}))throw new Error('Checkout request included unexpected fields')
  renewed=true
  if(scenario==='renew-network-failure')throw new Error('Ambiguous response private-renewed-url')
  return response({result:{url:'https://checkout.stripe.com/private-renewed-url'}})
 }
 if(url==='https://api.supabase.com/v1/projects/${project}/database/query') {
  const query=JSON.parse(init.body).query
  if(scenario==='provider-error') throw new Error('request leaked private-fixture-url')
  if(query.startsWith('select id from auth.users')) {trace('sql:fixture-read');return response([{id:uid}])}
  if(query.startsWith('select stripe_customer_id')) {trace('sql:mapping-read');return response([{stripe_customer_id:'cus_fixture'}])}
  if(query.startsWith('select document')) {trace('sql:entitlement-read');return response([{document:scenario==='settled'||scenario==='open'?{plan:'none',status:'active'}:{plan:'byok',status:'active',byok:{status:'active',checkoutSessionId:'cs_test_fixture',paymentIntentId:'pi_fixture'}}}])}
  if(query.startsWith('select event_type')) {trace('sql:event-read');return response([{event_type:'checkout.session.completed',processed_at:'fixture',outcome:'applied'}])}
  if(query.startsWith('begin; do $cleanup$')) {
   if(!query.includes("id='${uid}'::uuid")||!query.includes("faangin_billing_acceptance'='${run}'")||!query.includes('pg_advisory_xact_lock')) throw new Error('Cleanup lost its exact ownership guard')
   trace('sql:owned-cleanup');return response([])
  }
  throw new Error('Unexpected SQL')
 }
 if(url==='https://${project}.supabase.co/functions/v1/faangin-api/issueLicense') {
  trace('app:issueLicense')
  const now=Date.now(),bytes=Buffer.from(JSON.stringify({v:1,uid,deviceId:'billing_'+run,plan:'byok',status:'active',iat:now,exp:now+3600000,grace:now+7200000}))
  const token='v1.'+bytes.toString('base64url')+'.'+sign(null,bytes,readFileSync(process.env.SIGNING_KEY)).toString('base64url')
  return response({result:{plan:'byok',token}})
 }
 throw new Error('Unexpected HTTP operation')
}
`)
  const execute = args => {
    const tracePath = join(dir, 'trace.txt')
    writeFileSync(tracePath, '')
    const result = spawnSync(process.execPath, [join(scripts, 'acceptance.mjs'), ...args, '--state', statePath], { encoding: 'utf8', env: { ...process.env, TRACE: tracePath, SCENARIO: scenario, SIGNING_KEY: join(dir, 'backend/.env.fake-signing-key') } })
    const output = result.stdout + result.stderr
    for (const secret of [...credentials, 'private-fixture-url', 'private-renewed-url', 'v1.eyJ']) assert.ok(!output.includes(secret), 'Script exposed private state or a license')
    return { ...result, trace: readFileSync(tracePath, 'utf8') }
  }
  return { dir, statePath, execute, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('paid status is read-only and withholds private URLs, sessions and licenses', () => {
  const f = fixture()
  try {
    const result = f.execute(['status'])
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.paidEventApplied, true)
    assert.equal(receipt.signedLicenseVerified, false)
    assert.equal(receipt.paidFulfillmentVerified, false)
    assert.equal(receipt.duplicatePurchaseBlocked, false)
    assert.doesNotMatch(result.trace, /app:|cli:stripe:(post|delete)|sql:owned-cleanup/)
  } finally { f.dispose() }
})

test('license verification requires explicit matching confirmations and never attempts another Checkout', () => {
  const f = fixture()
  try {
    const refused = f.execute(['status', '--verify-license'])
    assert.notEqual(refused.status, 0)
    assert.doesNotMatch(refused.trace, /app:|sql:/)
    const result = f.execute(['status', '--verify-license', '--confirm-project', project, '--confirm-run', run])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).signedLicenseVerified, true)
    assert.match(result.trace, /app:issueLicense/)
    assert.doesNotMatch(result.trace, /createCheckout|cli:stripe:(post|delete)/)
  } finally { f.dispose() }
})

test('failed lock acquisition preserves the active run lock without contacting providers', () => {
  const f = fixture()
  try {
    writeFileSync(f.statePath + '.lock', 'active-process', { mode: 0o600 })
    const result = f.execute(['status'])
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(f.statePath + '.lock', 'utf8'), 'active-process')
    assert.doesNotMatch(result.trace, /cli:stripe|sql:|read:|app:/)
  } finally { f.dispose() }
})

test('unprotected credentials are refused and this process releases only its own lock', () => {
  const f = fixture()
  try {
    chmodSync(join(f.dir, 'backend/.env.supabase.local'), 0o644)
    const result = f.execute(['status'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /0600/)
    assert.equal(existsSync(f.statePath + '.lock'), false)
    assert.doesNotMatch(result.trace, /cli:stripe|sql:|read:|app:/)
  } finally { f.dispose() }
})

test('live mode, foreign ownership, unexpected currency and provider failure cannot certify fulfillment', () => {
  for (const scenario of ['live', 'foreign', 'wrong-currency', 'provider-error']) {
    const f = fixture(scenario)
    try {
      const result = f.execute(['status'])
      assert.notEqual(result.status, 0, scenario)
      assert.doesNotMatch(result.trace, /app:|cli:stripe:(post|delete)|sql:owned-cleanup/)
      assert.doesNotMatch(result.stdout, /"paidFulfillmentVerified": true/)
    } finally { f.dispose() }
  }
})

test('cleanup refuses live subscriptions and requires exact confirmation', () => {
  const f = fixture('active-sub')
  try {
    assert.notEqual(f.execute(['cleanup']).status, 0)
    const result = f.execute(['cleanup', '--confirm-project', project, '--confirm-run', run])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Cancel owned sandbox subscriptions/)
    assert.doesNotMatch(result.trace, /cli:stripe:delete|sql:owned-cleanup/)
  } finally { f.dispose() }
})

test('settled cleanup deletes only the marked SQL fixture and retains Stripe customer/audit records', () => {
  const f = fixture('settled')
  try {
    const result = f.execute(['cleanup', '--confirm-project', project, '--confirm-run', run])
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.stripeCustomerRetained, true)
    assert.equal(receipt.auditEventsRetained, true)
    assert.match(result.trace, /sql:owned-cleanup/)
    assert.doesNotMatch(result.trace, /cli:stripe:(post|delete)|app:/)
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(saved.accessToken, undefined)
    assert.equal(saved.refreshToken, undefined)
    assert.equal(saved.checkoutUrl, undefined)
  } finally { f.dispose() }
})

const renewal = ['renew-checkout', '--confirm-project', project, '--confirm-run', run]
test('renewal uses the same protected Auth fixture and app route without a management PAT or handoff write', () => {
  const f = fixture('renew-expired')
  try {
    unlinkSync(join(f.dir, 'backend/.env.supabase.local'))
    const handoff = join(f.dir, 'backend/.env.billing-handoff.local.html')
    writeFileSync(handoff, 'existing private handoff must remain untouched', { mode: 0o600 })
    const result = f.execute(renewal)
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout), saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(receipt.managementAccessUsed, false)
    assert.equal(receipt.paymentCreated, false)
    assert.equal(receipt.handoffWritten, false)
    assert.equal(saved.run, run); assert.equal(saved.uid, uid)
    assert.equal(saved.customerId, 'cus_fixture'); assert.equal(saved.plan, 'byok')
    assert.equal(saved.checkoutId, 'cs_test_renewed'); assert.equal(saved.phase, 'checkout-ready')
    assert.equal(saved.checkoutHistory[0].checkoutId, 'cs_test_fixture')
    assert.equal(saved.checkoutHistory[0].paymentStatus, 'unpaid')
    assert.equal(saved.accessToken, 'access-private-renewed'); assert.equal(saved.refreshToken, 'refresh-private-renewed')
    assert.equal(statSync(f.statePath).mode & 0o777, 0o600)
    assert.equal(readFileSync(handoff, 'utf8'), 'existing private handoff must remain untouched')
    assert.equal(existsSync(f.statePath + '.lock'), false)
    assert.match(result.trace, /auth:refresh[\s\S]*auth:identity[\s\S]*app:createCheckoutSession/)
    assert.match(result.trace, /cli:stripe:whoami:[^\n]*\n[\s\S]*cli:stripe:get:\/v1\/customers\/cus_fixture/)
    assert.equal(result.trace.match(/app:createCheckoutSession/g)?.length, 1)
    assert.doesNotMatch(result.trace, /sdk:customer|sql:|cli:stripe:(post|delete)|app:issueLicense/)
  } finally { f.dispose() }
})

test('renewal requires exact confirmations and cannot switch plan or use another Stripe account', () => {
  for (const args of [['renew-checkout'], ['renew-checkout', '--confirm-project', project, '--confirm-run', 'b'.repeat(32)], [...renewal, '--plan', 'pro_monthly']]) {
    const f = fixture('renew-expired')
    try {
      const result = f.execute(args)
      assert.notEqual(result.status, 0)
      assert.doesNotMatch(result.trace, /read:|auth:|app:|sql:|cli:stripe/)
    } finally { f.dispose() }
  }
  const f = fixture('renew-wrong-account')
  try {
    const result = f.execute(renewal)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.trace, /read:|auth:|app:|sql:|cli:stripe:(post|delete)/)
  } finally { f.dispose() }
})

test('paid, completed, open, unknown, foreign and previously billed fixtures cannot renew', () => {
  for (const scenario of ['renew-completed', 'renew-paid-expired', 'renew-open', 'renew-unknown-status', 'renew-unknown-payment', 'renew-old-live', 'renew-wrong-mode', 'renew-foreign-customer', 'renew-foreign-sibling', 'renew-open-sibling', 'renew-live-sub', 'renew-paid-charge']) {
    const f = fixture(scenario)
    try {
      const result = f.execute(renewal)
      assert.notEqual(result.status, 0, scenario)
      assert.doesNotMatch(result.trace, /auth:|app:|sql:|cli:stripe:(post|delete)/, scenario)
      assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).checkoutId, 'cs_test_fixture')
    } finally { f.dispose() }
  }
})

test('a rejected refresh or changed Auth identity/marker cannot request a Checkout', () => {
  for (const scenario of ['renew-refresh-rejected', 'renew-wrong-auth', 'renew-wrong-marker']) {
    const f = fixture(scenario)
    try {
      const result = f.execute(renewal)
      assert.notEqual(result.status, 0, scenario)
      assert.match(result.trace, /auth:refresh/)
      assert.doesNotMatch(result.trace, /app:|sql:|cli:stripe:(post|delete)/)
      const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
      assert.equal(saved.checkoutId, 'cs_test_fixture'); assert.equal(saved.phase, 'checkout-ready')
    } finally { f.dispose() }
  }
})

test('failure of the guarded exact customer CLI read cannot fall back to a broader key or mutate the fixture', () => {
  const f = fixture('renew-customer-read-denied')
  try {
    const result = f.execute(renewal)
    assert.notEqual(result.status, 0)
    assert.match(result.trace, /cli:stripe:get:\/v1\/customers\/cus_fixture/)
    assert.doesNotMatch(result.trace, /sdk:customer|auth:|app:|sql:|cli:stripe:(post|delete)/)
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(saved.phase, 'checkout-ready'); assert.equal(saved.checkoutId, 'cs_test_fixture')
  } finally { f.dispose() }
})

test('renewal cannot fall back to a cached access token when the protected refresh session is missing', () => {
  const f = fixture('renew-expired')
  try {
    const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
    delete saved.refreshToken
    writeFileSync(f.statePath, JSON.stringify(saved), { mode: 0o600 })
    const result = f.execute(renewal)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no saved Auth session/)
    assert.doesNotMatch(result.trace, /auth:|app:|sql:|cli:stripe:(post|delete)/)
    assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).checkoutId, 'cs_test_fixture')
  } finally { f.dispose() }
})

test('ambiguous renewal preserves private recovery state and refuses to issue a second Checkout', () => {
  for (const scenario of ['renew-ambiguous', 'renew-network-failure']) {
    const f = fixture(scenario)
    try {
      const first = f.execute(renewal)
      assert.notEqual(first.status, 0, scenario)
      assert.equal(first.trace.match(/app:createCheckoutSession/g)?.length, 1)
      const saved = JSON.parse(readFileSync(f.statePath, 'utf8'))
      assert.equal(saved.phase, 'checkout-renewal-requested')
      assert.equal(saved.checkoutId, 'cs_test_fixture')
      assert.equal(saved.accessToken, 'access-private-renewed')
      if (scenario === 'renew-ambiguous') assert.equal(saved.pendingCheckoutUrl, 'https://checkout.stripe.com/private-renewed-url')
      const second = f.execute(renewal)
      assert.notEqual(second.status, 0)
      assert.doesNotMatch(second.trace, /app:|auth:|sql:|read:/)
    } finally { f.dispose() }
  }
})
