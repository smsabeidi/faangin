import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main, setupSql, safeHttpStatus } from '../setup-supabase-reconcile.mjs'
const config = { supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_publicfixture' }

test('scheduler stores no credential in SQL or cron command and queues only a short-lived signature', async () => {
  const plan = setupSql(config)
  assert.match(plan.secret, /gen_random_bytes\(32\)/)
  assert.match(plan.secret, /if not exists\(select 1 from vault.secrets/)
  assert.match(plan.scheduler, /language plpgsql security invoker set search_path=''/)
  assert.match(plan.scheduler, /from vault.decrypted_secrets/)
  const migration = await readFile(new URL('../../../supabase/migrations/20261101025523_faangin_reconcile_scheduler.sql', import.meta.url), 'utf8')
  assert.match(migration, /enable row level security/)
  assert.match(migration, /signed_at_seconds=p_timestamp and claimed_at is null and request_id is not null/)
  assert.match(plan.scheduler, /revoke all on function faangin.enqueue_reconciliation\(\) from public,anon,authenticated,service_role/)
  assert.match(plan.scheduler, /'15 3 \* \* \*','select faangin.enqueue_reconciliation\(\);'/)
  assert.match(plan.scheduler, /hmac\('faangin-reconcile'\|\|chr\(10\)\|\|signed_at::text\|\|chr\(10\)\|\|nonce_value::text,credential,'sha256'\)/)
  const queued = plan.scheduler.match(/headers:=([^;]+),\n    body:=/)[1]
  assert.doesNotMatch(queued, /credential|reconcile-secret/)
  assert.match(queued, /reconcile-signature',signature/)
  assert.doesNotMatch(JSON.stringify(plan), /sb_secret_|sbp_|RECONCILE_SECRET=/)
  assert.throws(() => setupSql(config, 'extensions; select private'), /Unsupported pgcrypto schema/)
  assert.throws(() => setupSql({ ...config, supabaseUrl: 'http://localhost' }), /HTTPS Supabase/)
})

test('status reports counts and HTTP failure flags while withholding response bodies and error content', () => {
  const canary = 'private-fixture-canary'
  const status = safeHttpStatus({ request_id: 42, status_code: 200, content: JSON.stringify({ result: { checked: 3, failed: 0, private: canary } }), error_msg: canary })
  assert.deepEqual(status, { requestId: 42, requestedAt: undefined, responseAvailable: true, httpStatus: 200, timedOut: false, transportError: false, checked: 3, failed: 0 })
  assert.ok(!JSON.stringify(status).includes(canary))
  assert.equal(safeHttpStatus({ timed_out: true, content: canary }).responseAvailable, true)
  assert.equal(safeHttpStatus({ status_code: 500, content: canary }).failed, null)
})

test('default plan performs only metadata inspection, never uploads or reveals a credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faangin-reconcile-plan-'))
  const envFile = join(directory, '.env.fixture'), configFile = join(directory, 'cloud.json')
  const token = 'sbp_' + 'synthetic-private-fixture'.repeat(3)
  const fetcher = globalThis.fetch, logger = console.log
  const queries = [], output = []
  try {
    await writeFile(envFile, `SUPABASE_ACCESS_TOKEN=${token}\nRECONCILE_SECRET=synthetic-existing-credential\n`, { mode: 0o600 })
    await writeFile(configFile, JSON.stringify(config))
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/database\/query$/)
      assert.equal(init.headers.authorization, `Bearer ${token}`)
      const { query } = JSON.parse(init.body)
      queries.push(query)
      assert.match(query, /^select/)
      return Response.json(query.includes('pg_available_extensions') ? [
        { name: 'supabase_vault', installed_version: '0.3.1' }, { name: 'pgcrypto', installed_version: '1.3' }
      ] : [{ random_schema: 'extensions', cron_timezone: 'GMT', audit_exists: false, owned_secret_exists: false, public_vault_access: false }])
    }
    console.log = text => output.push(text)
    await main(['--env-file', envFile, '--config', configFile])
    assert.equal(queries.length, 2)
    assert.ok(!output.join('').includes(token))
    assert.ok(!output.join('').includes('synthetic-existing-credential'))
    assert.equal(JSON.parse(output[0]).command, 'read-only plan')
    await assert.rejects(main(['apply', '--env-file', envFile, '--config', configFile, '--confirm-project', 'wrong']), /requires --confirm-project/)
    assert.equal(queries.length, 2, 'wrong-project apply must fail before any API call')
  } finally { globalThis.fetch = fetcher; console.log = logger; await rm(directory, { recursive: true, force: true }) }
})
