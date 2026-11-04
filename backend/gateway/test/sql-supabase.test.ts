import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { SupabaseStore } from '../src/supabase.js'
import { decideAnswer } from '../src/meter.js'
import type { UsageDelta } from '../src/store.js'

const socket = process.env.FAANGIN_TEST_PG_SOCKET
const port = process.env.FAANGIN_TEST_PG_PORT ?? '55491'
if (socket && !socket.startsWith('/private/tmp/faangin')) throw new Error('Gateway SQL fixtures require an isolated local Postgres socket')
const literal = (value: unknown): string => value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value === 'boolean' ? String(value) : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === 'object' ? '::jsonb' : ''}`
function query(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-h', socket!, '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', error = ''
    child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(error)))
    child.stdin.end(sql)
  })
}
const store = new SupabaseStore(async (name, args) => {
  assert.match(name, /^faangin_gateway_[a-z_]+$/)
  for (const key of Object.keys(args)) assert.match(key, /^p_[a-z_]+$/)
  return JSON.parse(await query(`set role service_role; select coalesce(to_jsonb(public.${name}(${Object.entries(args).map(([key, value]) => `${key}=>${literal(value)}`).join(',')})),'null'::jsonb)::text;`))
})
const addUser = async () => { const uid = randomUUID(); await query(`insert into auth.users(id) values('${uid}')`); return uid }
const input = (mode: 'fast' | 'smart' | 'handsfree' = 'fast', ramped = false) => ({ mode, day: '2026-10-31', ramped, flags: { smartToFast: false, handsfreeOff: false }, leaseId: randomUUID(), now: Date.now(), expiresAt: Date.now() + 135000 })
const localOnly = { skip: !socket }

test('gateway SQL permissions exclude browser roles and admission/count increments serialize across callers', localOnly, async () => {
  assert.equal(await query("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'faangin_gateway_%' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'));"), '0')
  await assert.rejects(query("set role anon; select public.faangin_gateway_usage('00000000-0000-0000-0000-000000000000','period')"), /permission denied/)
  await assert.rejects(query('set role authenticated; select * from faangin.gateway_usage'), /permission denied/)
  const uid = await addUser()
  try {
    await store.increment(uid, 'one', '2026-10-31', { fast: 499 })
    const admissions = await Promise.all(Array.from({ length: 12 }, () => store.admitAnswer(uid, 'one', input())))
    assert.equal(admissions.filter(value => value.kind === 'run').length, 1)
    assert.equal((await store.read(uid, 'one')).fast, 500)
    assert.equal(await query(`select count(*) from faangin.gateway_leases where uid='${uid}'`), '1')
  } finally { await query(`delete from auth.users where id='${uid}'`) }
})

test('gateway SQL answer/audio leases span periods, expire after crashes and cannot be resurrected by a late heartbeat', localOnly, async () => {
  const uid = await addUser()
  try {
    const requests = Array.from({ length: 8 }, () => input())
    const admissions = await Promise.all(requests.map((request, index) => store.admitAnswer(uid, `period-${index}`, request)))
    assert.equal(admissions.filter(value => value.kind === 'run').length, 2)
    assert.equal(admissions.filter(value => value.kind === 'concurrency').length, 6)
    await Promise.all(requests.map(request => store.releaseLease(uid, 'answers', request.leaseId)))
    const now = Date.now()
    const ids = Array.from({ length: 8 }, () => randomUUID())
    const claims = await Promise.all(ids.map(id => store.claimLease(uid, 'audio', id, now, now + 1000, 2)))
    assert.equal(claims.filter(Boolean).length, 2)
    const recovered = randomUUID()
    assert.equal(await store.claimLease(uid, 'audio', recovered, now + 1001, now + 2001, 2), true)
    await store.releaseLease(uid, 'audio', recovered)
    assert.equal(await store.claimLease(uid, 'audio', recovered, now + 1002, now + 2002, 2, true), false)
    const grace = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claimGrace(uid, 'grace-period', now + index)))
    assert.equal(new Set(grace).size, 1)
  } finally { await query(`delete from auth.users where id='${uid}'`) }
})

test('SQL admission stays equivalent to the pure meter decisions for limits, ramp, downgrade and spend', localOnly, async () => {
  const cases: Array<{ mode: 'fast' | 'smart' | 'handsfree'; delta: UsageDelta; ramped?: boolean }> = [
    { mode: 'fast', delta: {} }, { mode: 'fast', delta: { fast: 500 } }, { mode: 'fast', delta: { fast: 150 }, ramped: true },
    { mode: 'smart', delta: { smart: 25 } }, { mode: 'smart', delta: { smart: 25, fast: 500 } },
    { mode: 'handsfree', delta: { handsfree: 1500 } }, { mode: 'smart', delta: { spendUsd: 16 } }
  ]
  for (const sample of cases) {
    const uid = await addUser()
    try {
      const request = input(sample.mode, sample.ramped)
      await store.increment(uid, 'meter', request.day, sample.delta)
      const usage = await store.read(uid, 'meter')
      const expected = decideAnswer({ ...request, usage, inFlight: 0 })
      assert.deepEqual(await store.admitAnswer(uid, 'meter', request), expected)
    } finally { await query(`delete from auth.users where id='${uid}'`) }
  }
})
