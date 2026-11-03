import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SupabaseStore } from '../store.ts'
import { ServiceError } from '../errors.ts'
test('RPC store pins exact named service operations and includes event owner/version fences', async () => {
  const calls: Array<{name:string;args:Record<string,unknown>|undefined}> = []
  const store = new SupabaseStore({ rpc(name,args) { calls.push({name,args}); return Promise.resolve({ data: { kind: 'committed' }, error: null }) } })
  await store.commit('uid', 7, { plan: 'none', status: 'active', updatedAt: 0 }, { id: 'evt_fixture', owner: 'owner' })
  assert.deepEqual(calls[0], { name:'faangin_stripe_commit',args:{ p_uid:'uid',p_version:7,p_document:{plan:'none',status:'active',updatedAt:0},p_event_id:'evt_fixture',p_owner:'owner' } })
})
test('database errors preserve safe business messages and redact unexpected SQL details', async () => {
  const denied = new SupabaseStore({ rpc: async () => ({data:null,error:{code:'FA429',message:'Up to 3 devices in 30 days'}}) })
  await assert.rejects(denied.touchDevice('uid','device','Mac'), error => error instanceof ServiceError && error.code==='resource-exhausted')
  const outage = new SupabaseStore({ rpc: async () => ({data:null,error:{code:'XX000',message:'unexpected internal SQL text'}}) })
  await assert.rejects(outage.customer('uid'), error => error instanceof ServiceError && !error.message.includes('SQL'))
})
