import assert from 'node:assert/strict'
import Stripe from 'npm:stripe@23.0.1'
import { createAccountHandler } from '../faangin-api/index.ts'
import { createStripeWebhookHandler } from '../stripe-webhook/index.ts'
import { createRuntime, serviceHeaders, type AccountRuntime } from './account-runtime.ts'
import { ServiceError } from '../../../backend/supabase/errors.ts'
import { verifyLicense } from '../../../backend/supabase/license.ts'
import { boundedText } from './http.ts'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
const uid='0d08fe00-1234-4000-8000-000000000001'
function fixture() {
  const calls:Array<{name:string;data?:unknown}>=[]
  const env=new Map([['LICENSE_SIGNING_KEY','fixture-key'],['RECONCILE_SECRET','fixture-internal-job-secret']])
  const runtime={
    env:{get:(key:string)=>env.get(key)},
    account:{
      async start(data:unknown){calls.push({name:'start',data});return{userCode:'ABCD-EFGH'}},
      async poll(data:unknown){calls.push({name:'poll',data});return{status:'pending'}},
      async approve(id:string,data:unknown){calls.push({name:id,data});return{ok:true}},
      async issueLicense(id:string,data:unknown){calls.push({name:id,data});return{plan:'byok'}}
    },
    async user(request:Request){calls.push({name:'user'});if(request.headers.get('authorization')!=='Bearer fixture-user-jwt')throw new ServiceError('unauthenticated','Sign in first');return{id:uid,email:'fixture@example.test',emailVerified:true}},
    billing(){return{service:{async reconcile(){calls.push({name:'reconcile'});return{checked:0,failed:0}}}}}
  }as unknown as AccountRuntime
  const handler=createAccountHandler(()=>runtime)
  const request=(route:string,data:unknown,headers:Record<string,string>={})=>new Request(`https://project.supabase.test/functions/v1/faangin-api/${route}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)})
  return{handler,request,calls,env,runtime}
}
Deno.test('account router keeps device requests raw, verifies user calls, ignores supplied uid and refuses unknown paths',async()=>{
  const f=fixture()
  assert.equal((await f.handler(f.request('deviceCodeStart',{deviceId:'mac-fixture-01'}))).status,200)
  assert.deepEqual(f.calls,[{name:'start',data:{deviceId:'mac-fixture-01'}}])
  const denied=await f.handler(f.request('issueLicense',{data:{uid:'forged'}}));assert.equal(denied.status,401)
  const allowed=await f.handler(f.request('issueLicense',{data:{uid:'forged',deviceId:'mac-fixture-01'}},{authorization:'Bearer fixture-user-jwt'}))
  assert.deepEqual(await allowed.json(),{result:{plan:'byok'}})
  assert.equal(f.calls.at(-1)!.name,uid)
  assert.equal((await f.handler(f.request('anything',{data:{}}))).status,404)
  const invalidPrefix=new Request('https://project.supabase.test/evil/faangin-api/health')
  assert.equal((await f.handler(invalidPrefix)).status,404)
})
Deno.test('CORS permits only explicit desktop loopback origins and reconciliation requires its dedicated internal secret',async()=>{
  const f=fixture()
  const preflight=await f.handler(new Request('https://project.supabase.test/functions/v1/faangin-api/issueLicense',{method:'OPTIONS',headers:{origin:'http://127.0.0.1:41921'}}))
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'http://127.0.0.1:41921')
  const blocked=await f.handler(f.request('deviceCodeStart',{}, {origin:'https://untrusted.example'}))
  assert.equal(blocked.status,401);assert.equal(blocked.headers.get('access-control-allow-origin'),null)
  assert.equal((await f.handler(f.request('reconcile',{}, {apikey:'fixture-publishable',authorization:'Bearer fixture-user-jwt'}))).status,401)
  assert.equal((await f.handler(f.request('reconcile',{}, {'x-faangin-reconcile-secret':'fixture-internal-job-secret'}))).status,200)
  f.env.delete('RECONCILE_SECRET');assert.equal((await f.handler(f.request('reconcile',{}))).status,503)
})
Deno.test('REST runtime uses opaque server keys only as apikey and derives identity from authoritative Auth responses',async()=>{
  assert.equal(serviceHeaders('opaque-test-credential').authorization,undefined)
  const env=new Map([['SUPABASE_URL','https://project.supabase.test'],['SUPABASE_SECRET_KEYS',JSON.stringify({default:'opaque-test-credential'})],['SUPABASE_PUBLISHABLE_KEYS',JSON.stringify({default:'fixture-publishable'})]])
  const calls:Array<{url:string;headers:Headers}>=[]
  const runtime=createRuntime({env:{get:key=>env.get(key)},fetcher:async(input,init)=>{
    const url=String(input),headers=new Headers((init as RequestInit | undefined)?.headers);calls.push({url,headers})
    if(url.endsWith('/auth/v1/user'))return Response.json({id:uid,email:'buyer@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'})
    assert.equal(headers.get('apikey'),'opaque-test-credential');assert.equal(headers.get('authorization'),null)
    if(url.includes('/auth/v1/admin/users/'))return Response.json({id:uid,email:'buyer@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'})
    if(url.endsWith('/auth/v1/admin/generate_link'))return Response.json({id:uid,hashed_token:'fixture-independent-hash'})
    if(url.endsWith('/faangin_device_claim'))return Response.json({status:'claimed',uid,deviceId:'mac-fixture-01',deviceName:'Mac'})
    if(url.endsWith('/faangin_device_complete'))return Response.json(true)
    throw new Error('Unexpected test request')
  }})
  const user=await runtime.user(new Request('https://project.supabase.test',{headers:{authorization:'Bearer fixture-user-jwt'}}))
  assert.equal(user.id,uid);assert.equal(user.emailVerified,true)
  const result=await runtime.account.poll({deviceCode:'A'.repeat(43)})
  assert.deepEqual(result,{status:'approved',tokenHash:'fixture-independent-hash',uid})
  assert.ok(calls.some(call=>call.url.endsWith('/auth/v1/admin/generate_link')))
})
Deno.test('Google and password sessions for the same Supabase user reach the same license and device record', async () => {
  const keys = generateKeyPairSync('ed25519')
  const env = new Map([
    ['SUPABASE_URL', 'https://project.supabase.test'],
    ['SUPABASE_SECRET_KEY', 'fixture-server-key'],
    ['SUPABASE_PUBLISHABLE_KEY', 'fixture-publishable-key'],
    ['LICENSE_SIGNING_KEY', keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')]
  ])
  const device = { deviceId: 'mac-fixture-01', deviceName: 'Mac' }
  const sessions = new Map([['fixture-google-session', 'google'], ['fixture-password-session', 'email']])
  const touched: unknown[] = []
  const runtime = createRuntime({ env: { get: key => env.get(key) }, fetcher: async (input, init) => {
    const path = new URL(String(input)).pathname
    const request = init as RequestInit | undefined
    const headers = new Headers(request?.headers)
    if (path === '/auth/v1/user') {
      assert.equal(headers.get('apikey'), 'fixture-publishable-key')
      const provider = sessions.get(headers.get('authorization')?.slice('Bearer '.length) ?? '')
      if (!provider) return new Response(null, { status: 401 })
      return Response.json({ id: uid, email: 'buyer@example.test', app_metadata: { provider } })
    }
    assert.equal(path, '/rest/v1/rpc/faangin_device_touch')
    assert.equal(headers.get('apikey'), 'fixture-server-key')
    touched.push(JSON.parse(String(request?.body)))
    return Response.json({ document: { plan: 'byok', status: 'active', updatedAt: 0 }, version: 1, now: 1_800_000_000_000 })
  } })
  const handle = createAccountHandler(() => runtime)
  const request = (route: string, token: string) => new Request(`https://project.supabase.test/functions/v1/faangin-api/${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ data: { uid: 'forged', ...device } })
  })
  for (const route of ['issueLicense', 'createCheckoutSession', 'createPortalSession', 'deviceCodeApprove']) {
    assert.equal((await handle(request(route, 'fixture-raw-google-token'))).status, 401)
  }
  assert.deepEqual(touched, [])
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  for (const token of ['fixture-password-session', 'fixture-google-session']) {
    const response = await handle(request('issueLicense', token))
    assert.equal(response.status, 200)
    const { result } = await response.json()
    const license = verifyLicense(result.token, publicKey)
    assert.equal(license?.uid, uid)
    assert.equal(license?.deviceId, device.deviceId)
    assert.equal(license?.plan, 'byok')
  }
  const touch = { p_uid: uid, p_device_id: device.deviceId, p_name: device.deviceName }
  assert.deepEqual(touched, [touch, touch])
})
Deno.test('named server-key cutover reaches account RPC and Auth Admin without using the default or legacy key',async()=>{
  const selectedKey='sb_secret_'+'selected_fixture'
  const env=new Map([
    ['SUPABASE_URL','https://project.supabase.test'],
    ['FAANGIN_SUPABASE_SERVER_KEY_NAME','replacement'],
    ['SUPABASE_SECRET_KEYS',JSON.stringify({default:'retired-default-fixture',replacement:selectedKey})],
    ['SUPABASE_SERVICE_ROLE_KEY','retired-legacy-fixture']
  ])
  const calls:string[]=[]
  const runtime=createRuntime({env:{get:key=>env.get(key)},fetcher:async(input,init)=>{
    const url=String(input),headers=new Headers((init as RequestInit | undefined)?.headers);calls.push(url)
    assert.equal(headers.get('apikey'),selectedKey)
    assert.equal(headers.get('authorization'),null)
    if(url.endsWith('/faangin_device_claim'))return Response.json({status:'claimed',uid,deviceId:'mac-fixture-01',deviceName:'Mac'})
    if(url.includes('/auth/v1/admin/users/'))return Response.json({id:uid,email:'buyer@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'})
    if(url.endsWith('/auth/v1/admin/generate_link'))return Response.json({id:uid,hashed_token:'fixture-independent-hash'})
    if(url.endsWith('/faangin_device_complete'))return Response.json(true)
    throw new Error('Unexpected test request')
  }})
  assert.deepEqual(await runtime.account.poll({deviceCode:'B'.repeat(43)}),{status:'approved',tokenHash:'fixture-independent-hash',uid})
  assert.equal(calls.length,4)
})
Deno.test('explicit unavailable server-key selection fails before an account provider request',()=>{
  const env=new Map([
    ['SUPABASE_URL','https://project.supabase.test'],['FAANGIN_SUPABASE_SERVER_KEY_NAME','missing'],
    ['SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_default_fixture'})],['SUPABASE_SERVICE_ROLE_KEY','legacy-fixture']
  ])
  let requests=0
  assert.throws(()=>createRuntime({env:{get:key=>env.get(key)},fetcher:async()=>{requests++;return Response.json({})}}),/selected Supabase server key is unavailable/)
  assert.equal(requests,0)
})
Deno.test('billing refuses mismatched Stripe modes and overprivileged or shared keys before checkout', () => {
  const env = new Map([
    ['SUPABASE_URL', 'https://project.supabase.test'], ['SUPABASE_SECRET_KEY', 'fixture-server-key'],
    ['STRIPE_CHECKOUT_KEY', 'rk_test_checkout_fixture'], ['STRIPE_WEBHOOK_KEY', 'rk_test_webhook_fixture'],
    ['STRIPE_WEBHOOK_SECRET', 'fixture-webhook-secret']
  ])
  const runtime = () => createRuntime({ env: { get: key => env.get(key) } })
  const unavailable = (error: unknown) => error instanceof ServiceError && error.code === 'unavailable'
  assert.equal(runtime().billingConfigured, true)
  assert.ok(runtime().billing('checkout').stripe)
  env.set('STRIPE_CHECKOUT_KEY', 'rk_live_checkout_fixture')
  assert.equal(runtime().billingConfigured, false)
  assert.throws(() => runtime().billing('checkout'), unavailable)
  assert.ok(runtime().billing('webhook').stripe, 'previous sandbox payments can still fulfill')
  env.set('STRIPE_EXPECT_LIVEMODE', 'true')
  assert.throws(() => runtime().billing('checkout'), unavailable)
  assert.throws(() => runtime().billing('webhook'), unavailable)
  env.set('STRIPE_WEBHOOK_KEY', 'rk_live_webhook_fixture')
  assert.equal(runtime().billingConfigured, true)
  assert.ok(runtime().billing('checkout').stripe)
  env.set('STRIPE_CHECKOUT_KEY', 'sk_live_checkout_fixture')
  assert.throws(() => runtime().billing('checkout'), unavailable)
  env.set('STRIPE_CHECKOUT_KEY', 'rk_live_webhook_fixture')
  assert.throws(() => runtime().billing('checkout'), unavailable)
  assert.throws(() => runtime().billing('webhook'), unavailable)
  env.set('STRIPE_EXPECT_LIVEMODE', 'yes')
  env.set('STRIPE_CHECKOUT_KEY', 'rk_test_checkout_fixture')
  env.set('STRIPE_WEBHOOK_KEY', 'rk_test_webhook_fixture')
  assert.throws(() => runtime().billing('checkout'), unavailable)
  env.set('STRIPE_EXPECT_LIVEMODE', 'false')
  env.delete('STRIPE_WEBHOOK_SECRET')
  assert.throws(() => runtime().billing('checkout'), unavailable)
  assert.ok(runtime().billing('portal').stripe, 'existing customers can still manage their subscriptions')
})
Deno.test('scheduled reconciliation verifies a short-lived HMAC and consumes its DB nonce exactly once',async()=>{
  const f=fixture(),nonce:string='abac0000-1234-4000-8000-123456789abc',timestamp=String(Math.floor(Date.now()/1000)),secret=f.env.get('RECONCILE_SECRET')!
  let claims=0,claimed=false
  f.runtime.claimReconcileDispatch=async(value,time)=>{claims++;assert.equal(value,nonce);assert.equal(time,Number(timestamp));if(claimed)return false;claimed=true;return true}
  const signed=(time=timestamp,value=nonce,key=secret)=>({
    'x-faangin-reconcile-time':time,'x-faangin-reconcile-nonce':value,
    'x-faangin-reconcile-signature':createHmac('sha256',key).update(`faangin-reconcile\n${time}\n${value}`,'utf8').digest('hex')
  })
  for(const headers of [signed(timestamp,nonce,'wrong-key'),signed(String(Number(timestamp)-120)),signed(String(Number(timestamp)+120)),signed(timestamp,nonce.toUpperCase()),{...signed(),'x-faangin-reconcile-signature':'f'.repeat(64)}])assert.equal((await f.handler(f.request('reconcile',{},headers))).status,401)
  assert.equal(claims,0);assert.equal(f.calls.filter(call=>call.name==='reconcile').length,0)
  assert.equal((await f.handler(f.request('reconcile',{},signed()))).status,200)
  assert.equal(claims,1);assert.equal(f.calls.filter(call=>call.name==='reconcile').length,1)
  assert.equal((await f.handler(f.request('reconcile',{},signed()))).status,401)
  assert.equal(claims,2);assert.equal(f.calls.filter(call=>call.name==='reconcile').length,1)
})
Deno.test('valid HMACs cannot run unissued nonce rows or bypass an unavailable claim database',async()=>{
  const f=fixture(),nonce=randomUUID(),timestamp=String(Math.floor(Date.now()/1000))
  const headers={'x-faangin-reconcile-time':timestamp,'x-faangin-reconcile-nonce':nonce,'x-faangin-reconcile-signature':createHmac('sha256',f.env.get('RECONCILE_SECRET')!).update(`faangin-reconcile\n${timestamp}\n${nonce}`,'utf8').digest('hex')}
  f.runtime.claimReconcileDispatch=async()=>false
  assert.equal((await f.handler(f.request('reconcile',{},headers))).status,401)
  f.runtime.claimReconcileDispatch=async()=>{throw new ServiceError('unavailable','Dispatch database unavailable')}
  assert.equal((await f.handler(f.request('reconcile',{},headers))).status,503)
  assert.equal(f.calls.filter(call=>call.name==='reconcile').length,0)
})
Deno.test('Stripe webhook verifies the original body with async crypto before processing the event',async()=>{
  const stripe=new Stripe('fixture-stripe-key',{httpClient:Stripe.createFetchHttpClient()})
  const secret='fixture-webhook-secret',event={id:'evt_fixture',type:'customer.created',livemode:false,data:{object:{id:'cus_fixture'}}},payload=JSON.stringify(event)
  let processed=0
  const runtime={env:{get:(key:string)=>key==='STRIPE_WEBHOOK_SECRET'?secret:undefined},billing:()=>({stripe,service:{async processWebhook(value:Stripe.Event){processed++;assert.equal(value.id,event.id);return{received:true}}}})}as unknown as AccountRuntime
  const handler=createStripeWebhookHandler(()=>runtime)
  const bad=await handler(new Request('https://project.supabase.test/functions/v1/stripe-webhook',{method:'POST',body:payload}))
  assert.equal(bad.status,400);assert.equal(processed,0)
  const signature=await stripe.webhooks.generateTestHeaderStringAsync({payload,secret,cryptoProvider:Stripe.createSubtleCryptoProvider()})
  const good=await handler(new Request('https://project.supabase.test/functions/v1/stripe-webhook',{method:'POST',headers:{'stripe-signature':signature},body:payload}))
  assert.equal(good.status,200);assert.equal(processed,1)
})
Deno.test('request readers cap streamed bytes before buffering complete JSON or Stripe payloads',async()=>{
  let canceled=false
  const stream=new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(new Uint8Array(65_537))},
    cancel(){canceled=true}
  })
  const f=fixture(),request=new Request('https://project.supabase.test/functions/v1/faangin-api/deviceCodeStart',{method:'POST',body:stream})
  assert.equal((await f.handler(request)).status,400)
  assert.equal(canceled,true);assert.equal(f.calls.length,0)
  // UTF-8 bytes, rather than JavaScript character count, define the bound; split characters still decode correctly.
  const encoded=new TextEncoder().encode('é')
  const split=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoded.slice(0,1));controller.enqueue(encoded.slice(1));controller.close()}})
  assert.equal(await boundedText(new Request('https://project.supabase.test',{method:'POST',body:split}),2),'é')
  await assert.rejects(boundedText(new Request('https://project.supabase.test',{method:'POST',body:'é'}),1),ServiceError)
  const webhook=createStripeWebhookHandler(()=>({env:{get:()=> 'fixture-secret'},billing(){throw new Error('Oversized payload must be rejected before Stripe')}} as unknown as AccountRuntime))
  assert.equal((await webhook(new Request('https://project.supabase.test/functions/v1/stripe-webhook',{method:'POST',headers:{'stripe-signature':'test'},body:'x'.repeat(1_048_577)}))).status,400)
})
