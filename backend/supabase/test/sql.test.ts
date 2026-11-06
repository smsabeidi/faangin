import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type Stripe from 'npm:stripe@23.0.1'
import { createAccountService } from '../account-service.ts'
import { createBillingService } from '../billing-service.ts'
import { SupabaseStore } from '../store.ts'
import { fakeSubscription } from './stripe-fixtures.ts'
const socket = process.env.FAANGIN_TEST_PG_SOCKET
const sqlValue = (value: unknown): string => value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value === 'boolean' ? String(value) : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === 'object' ? '::jsonb' : ''}`
function query(sql: string): Promise<string> {
  return new Promise((resolve,reject) => {
    const child=spawn('psql',['-h',socket!,'-p','55491','-U','postgres','-d','postgres','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{stdio:['pipe','pipe','pipe']})
    let out='',err='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk)
    child.on('error',reject);child.on('exit',code=>code===0?resolve(out.trim()):reject(Object.assign(new Error(err),{code:err.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]})))
    child.stdin.end(sql)
  })
}
const store=new SupabaseStore({async rpc(name,args={}) {
  assert.match(name,/^faangin_[a-z_]+$/)
  for(const key of Object.keys(args))assert.match(key,/^p_[a-z_]+$/)
  try { const text=await query(`set role service_role; select coalesce(to_jsonb(public.${name}(${Object.entries(args).map(([key,value])=>`${key}=>${sqlValue(value)}`).join(',')})),'null'::jsonb)::text;`);return {data:JSON.parse(text||'null'),error:null} }
  catch(error) { const err=error as Error&{code?:string};return {data:null,error:{code:err.code,message:err.message}} }
}})
const addUser=async()=>{const uid=randomUUID();await query(`insert into auth.users(id) values('${uid}');`);return uid}
const pro=(now=Date.now())=>({plan:'pro' as const,status:'active' as const,updatedAt:now,pro:{status:'active' as const,subscriptionId:'sub_sql',priceLookupKey:'faangin_pro_monthly',startedAt:now,currentPeriodStart:now,currentPeriodEnd:now+30*86400000,cancelAtPeriodEnd:false,rampUntil:now+14*86400000}})
const testSql={skip:!socket}

test('SQL grants block public roles, checkout leases serialize callers and owner fencing protects release',testSql,async()=>{
  assert.equal(await query("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'faangin_%' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'));"),'0')
  await assert.rejects(query('set role anon; select * from faangin.entitlements;'),/permission denied/)
  const uid=await addUser(),owners=Array.from({length:8},()=>randomUUID())
  const claims=await Promise.all(owners.map(owner=>store.claimCheckout(uid,owner)))
  assert.equal(claims.filter(Boolean).length,1)
  const winner=owners[claims.indexOf(true)]
  await store.releaseCheckout(uid,randomUUID());assert.equal(await store.claimCheckout(uid,randomUUID()),false)
  await store.releaseCheckout(uid,winner);assert.equal(await store.claimCheckout(uid,randomUUID()),true)
})
test('SQL device registration accepts concurrent active devices and polling has a single independent hash issuer',testSql,async()=>{
  const uid=await addUser();await store.commit(uid,0,{plan:'byok',status:'active',updatedAt:Date.now()})
  const touches=await Promise.allSettled(Array.from({length:4},(_,i)=>store.touchDevice(uid,`mac-sql-cap-${i}`,'Test Mac')))
  assert.equal(touches.filter(result=>result.status==='fulfilled').length,4)
  let generated=0
  const account=createAccountService({store,auth:{async getUserById(){return{id:uid,email:'sql@example.test',emailVerified:true}},async generateMagicLink(){generated++;return{uid,tokenHash:'one-desktop-hash'}}},signingKey:'',activationUrl:'http://127.0.0.1:4000/activate'})
  const start=await account.start({deviceId:'mac-sql-auth-01',deviceName:'SQL Mac'})
  await account.approve(uid,{userCode:start.userCode})
  const polls=await Promise.all(Array.from({length:8},()=>account.poll({deviceCode:start.deviceCode})))
  assert.equal(polls.filter(poll=>poll.status==='approved').length,1);assert.equal(generated,1)
})
test('SQL webhook stale-owner fencing, version conflicts, seat changes and processed markers are atomic',testSql,async()=>{
  const uid=await addUser(),id=`evt_sql_${randomUUID()}`,a=randomUUID(),b=randomUUID()
  assert.equal(await store.claimEvent(id,'customer.subscription.updated',a),'claimed')
  assert.equal(await store.claimEvent(id,'customer.subscription.updated',b),'inflight')
  await query(`update faangin.stripe_events set claimed_at=now()-interval '11 minutes' where event_id='${id}';`)
  assert.equal(await store.claimEvent(id,'customer.subscription.updated',b),'claimed')
  assert.equal((await store.commit(uid,0,pro(),{id,owner:a})).kind,'lost_claim')
  const before=Number(await query("select active_seats from faangin.stats where key='pro';"))
  assert.equal((await store.commit(uid,0,pro(),{id,owner:b})).kind,'committed')
  assert.equal((await store.commit(uid,0,pro(),{id,owner:b})).kind,'processed')
  assert.equal(Number(await query("select active_seats from faangin.stats where key='pro';")),before+1)
  const second=`evt_sql_${randomUUID()}`,owner=randomUUID();await store.claimEvent(second,'customer.subscription.updated',owner)
  assert.equal((await store.commit(uid,0,pro(),{id:second,owner})).kind,'conflict')
  assert.equal(await query(`select processed_at is null from faangin.stripe_events where event_id='${second}';`),'t')
  assert.equal((await store.commit(uid,1,{...pro(),status:'canceled',pro:{...pro().pro,status:'canceled'}},{id:second,owner})).kind,'committed')
  assert.equal(Number(await query("select active_seats from faangin.stats where key='pro';")),before)
})
const byokPrice = { lookup_key: 'faangin_byok_v1', type: 'one_time', currency: 'usd', unit_amount: 1000 }
const byokLineItems = { has_more: false, data: [{ quantity: 1, price: byokPrice }] }

test('services reject new BYOK sales and preserve one uid/device through legacy fulfillment, Pro and cancellation',testSql,async()=>{
  const uid=await addUser(),user={id:uid,email:'buyer@example.test',emailVerified:true},sessions:Array<Record<string,unknown>>=[],subscriptions=new Map<string,Record<string,unknown>>()
  let customerNo=0, monthlyInterval = 'month', finishBeforeOpenList: Record<string,unknown> | undefined
  let lineItems = byokLineItems
  const iterable=(items:unknown[])=>({async *[Symbol.asyncIterator](){yield*items}})
  const stripe={
    customers:{async create(){return{id:`cus_sql_${++customerNo}`}}},
    prices:{async list({lookup_keys:[lookupKey]}:{lookup_keys:string[]}){
      const prices = {
        faangin_pro_monthly_v2: { type: 'recurring', currency: 'usd', unit_amount: 4999, recurring: { interval: monthlyInterval, interval_count: 1 } },
        faangin_pro_annual_v2: { type: 'recurring', currency: 'usd', unit_amount: 35988, recurring: { interval: 'year', interval_count: 1 } }
      }
      return { data: [{ ...prices[lookupKey as keyof typeof prices], lookup_key: lookupKey, id: `price_${lookupKey}` }] }
    }},
    subscriptions:{list:()=>iterable([...subscriptions.values()]),async retrieve(id:string){return subscriptions.get(id)!}},
    checkout:{sessions:{
      list({status}:{status:string}){
        if (status === 'open' && finishBeforeOpenList) {
          subscriptions.set(String(finishBeforeOpenList.id), finishBeforeOpenList)
          finishBeforeOpenList = undefined
          Object.assign(sessions.at(-1)!, { status: 'complete', payment_status: 'paid' })
        }
        return iterable(sessions.filter(session => session.status === status))
      },
      async listLineItems(){return lineItems},
      async expire(id:string){sessions.find(s=>s.id===id)!.status='expired'},
      async create(params:Record<string,unknown>){const s={id:`cs_sql_${sessions.length}`,status:'open',...params,url:'https://checkout.stripe.test/sql'};sessions.push(s);return s}
    }},
    billingPortal:{configurations:{async list(){return{data:[{id:'bpc_fixture',active:true,metadata:{faangin:'v1'}}]}}}},charges:{list:()=>iterable([{paid:true,status:'succeeded',customer:'cus_sql_1',refunded:false,disputed:false}]),async retrieve(){return{customer:'cus_sql_1'}}}
  }as unknown as Stripe
  const billing=createBillingService({store,stripe,hostingOrigin:'https://example.supabase.test/functions/v1/billing-return',expectLivemode:false})
  const keys=generateKeyPairSync('ed25519'),account=createAccountService({store,auth:{async getUserById(){return user},async generateMagicLink(){return{uid,tokenHash:'fixture'}}},signingKey:keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),activationUrl:'http://127.0.0.1:4000/activate'})
  const event=(id:string,type:string,object:Record<string,unknown>)=>({id,type,livemode:false,data:{object}}as unknown as Stripe.Event)
  await assert.rejects(billing.checkout(user,{plan:'byok'}), /monthly or annual Pro/)
  assert.equal(sessions.length,0)
  assert.equal(customerNo,0)
  assert.equal(await store.customer(uid),null)
  const customer='cus_sql_1'
  await store.bindCustomer(uid,customer)
  const paidByok={id:`cs_byok_${uid}`,created:Math.floor(Date.now()/1000),mode:'payment',payment_status:'paid',customer,payment_intent:`pi_byok_${uid}`,metadata:{uid,plan:'byok'}}
  const invalidLineItems = [
    { ...byokLineItems, has_more: true },
    { ...byokLineItems, data: [{ quantity: 2, price: byokPrice }] },
    { ...byokLineItems, data: [{ quantity: 1, price: { ...byokPrice, lookup_key: 'other_product' } }] },
    { ...byokLineItems, data: [{ quantity: 1, price: { ...byokPrice, currency: 'eur' } }] },
    { ...byokLineItems, data: [{ quantity: 1, price: { ...byokPrice, unit_amount: 1 } }] }
  ]
  for (const [i, items] of invalidLineItems.entries()) {
    lineItems = items
    const outcome = await billing.processWebhook(event(`evt_foreign_${i}_${uid}`,'checkout.session.completed',paidByok))
    assert.equal(outcome.outcome,'ignored')
    assert.equal((await store.readEntitlement(uid)).document.plan,'none')
  }
  lineItems = byokLineItems
  const byok=event(`evt_byok_${uid}`,'checkout.session.completed',paidByok)
  await billing.processWebhook(byok)
  assert.equal((await billing.processWebhook(byok)).duplicate,true)
  assert.equal((await account.issueLicense(uid,{deviceId:'mac-sql-flow-01',deviceName:'Journey Mac'})).plan,'byok')
  await billing.checkout(user,{plan:'pro_annual'})
  assert.deepEqual(sessions.at(-1)?.line_items,[{price:'price_faangin_pro_annual_v2',quantity:1}])
  assert.equal(sessions.at(-1)?.mode,'subscription')
  monthlyInterval = 'year'
  await assert.rejects(billing.checkout(user,{plan:'pro_monthly'}), /plan is not configured/)
  assert.deepEqual(sessions.at(-1)?.line_items,[{price:'price_faangin_pro_annual_v2',quantity:1}])
  monthlyInterval = 'month'
  await billing.checkout(user,{plan:'pro_monthly'})
  assert.deepEqual(sessions.at(-1)?.line_items,[{price:'price_faangin_pro_monthly_v2',quantity:1}])
  const subId=`sub_${uid}`,subscription=fakeSubscription({id:subId,customer:customer!,uid,lookupKey:'faangin_pro_monthly_v2'})
  finishBeforeOpenList = subscription
  await assert.rejects(billing.checkout(user,{plan:'pro_monthly'}), /Pro is already active/)
  assert.equal(sessions.length,2)
  const active=event(`evt_active_${uid}`,'customer.subscription.created',subscription)
  await billing.processWebhook(active);assert.equal((await billing.processWebhook(active)).duplicate,true)
  assert.equal((await account.issueLicense(uid,{deviceId:'mac-sql-flow-01',deviceName:'Journey Mac'})).plan,'pro')
  await assert.rejects(billing.checkout(user,{plan:'pro_monthly'}),/Pro is already active/)
  subscriptions.set(subId,{...subscription,status:'canceled'})
  await billing.processWebhook(event(`evt_cancel_${uid}`,'customer.subscription.deleted',subscription))
  assert.equal((await account.issueLicense(uid,{deviceId:'mac-sql-flow-01',deviceName:'Journey Mac'})).plan,'byok')
  assert.equal(await query(`select count(*) from faangin.devices where uid='${uid}';`),'1')
})

test('concurrent refund wins over a purchase that already read an earlier SQL version', {...testSql,timeout:15000}, async()=>{
  const uid=await addUser(),customer=`cus_race_${uid}`,intent=`pi_race_${uid}`,purchaseId=`evt_purchase_${uid}`
  await store.bindCustomer(uid,customer)
  const iterable=(items:unknown[])=>({async *[Symbol.asyncIterator](){yield*items}})
  const stripe={checkout:{sessions:{async listLineItems(){return byokLineItems}}},charges:{list:()=>iterable([{paid:true,status:'succeeded',customer,refunded:false,disputed:false}])},invoicePayments:{list:()=>iterable([])}} as unknown as Stripe
  let signalCommit!:()=>void,releaseCommit!:()=>void,first=true
  const atCommit=new Promise<void>(resolve=>{signalCommit=resolve}),resume=new Promise<void>(resolve=>{releaseCommit=resolve})
  const guardedStore=new Proxy(store,{get(target,key){
    if(key==='commit') return async(...args:Parameters<SupabaseStore['commit']>)=>{
      if(args[3]?.id===purchaseId&&first){first=false;signalCommit();await resume}
      return target.commit(...args)
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const billing=createBillingService({store:guardedStore,stripe,hostingOrigin:'https://example.test',expectLivemode:false})
  const event=(id:string,type:string,object:Record<string,unknown>)=>({id,type,livemode:false,data:{object}}as unknown as Stripe.Event)
  const purchase=billing.processWebhook(event(purchaseId,'checkout.session.completed',{id:`cs_${uid}`,created:Math.floor(Date.now()/1000),mode:'payment',payment_status:'paid',customer,payment_intent:intent,metadata:{uid,plan:'byok'}}))
  try{
    await Promise.race([atCommit,purchase.then(()=>{throw new Error('Purchase committed without the race barrier')})])
    await billing.processWebhook(event(`evt_refund_${uid}`,'charge.refunded',{id:`ch_${uid}`,customer,payment_intent:intent,refunded:true}))
  }finally{releaseCommit()}
  await purchase
  const state=await store.readEntitlement(uid)
  assert.equal(state.document.byok?.status,'revoked')
  assert.equal(state.document.revocations?.[`pi:${intent}`],'refund')
  assert.equal(state.version,2,'purchase retried after the refund committed its tombstone')
  assert.equal(await query(`select count(*) from faangin.stripe_events where event_id in ('${purchaseId}','evt_refund_${uid}') and processed_at is not null;`),'2')
})
