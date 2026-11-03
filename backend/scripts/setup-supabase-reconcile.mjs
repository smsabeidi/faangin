#!/usr/bin/env node
/**
 * Supabase daily billing reconciliation. Default `plan` and `status` are read-only.
 *
 * node backend/scripts/setup-supabase-reconcile.mjs plan --env-file backend/.env.supabase.local
 * node backend/scripts/setup-supabase-reconcile.mjs apply --confirm-project <ref> --env-file <ignored-env>
 * node backend/scripts/setup-supabase-reconcile.mjs status --env-file <ignored-env>
 * node backend/scripts/setup-supabase-reconcile.mjs run-once --confirm-project <ref> --env-file <ignored-env>
 *
 * apply enables pg_cron/pg_net, creates or reuses a DB-generated Vault secret, synchronizes
 * the Edge secret and protected local env, then installs one daily job. It never rotates an
 * existing owned Vault secret. run-once invokes billing reconciliation and is separate from setup.
 * No secret is interpolated into SQL, a process argument, console output, or the cron command.
 * The pg_net queue receives only a short-lived HMAC and a single-use nonce, never the key.
 */
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const JOB = 'faangin-daily-billing-reconcile'
export const SCHEDULE = '15 3 * * *' // 03:15 UTC; verify cron.timezone before applying.
const SECRET_NAME = 'faangin_reconcile_secret'
const COMMAND = 'select faangin.enqueue_reconciliation();'
const migrationPath = resolve(root, 'supabase/migrations/20261101025523_faangin_reconcile_scheduler.sql')
const q = value => `'${String(value).replaceAll("'", "''")}'`
function check(ok, message) { if (!ok) throw new Error(message) }

export function projectConfig(config) {
  const project = new URL(config.supabaseUrl)
  check(project.protocol === 'https:' && /^[a-z]{20}\.supabase\.co$/.test(project.hostname) && project.pathname === '/' && !project.search && !project.hash && !project.username && !project.password, 'Config must identify an HTTPS Supabase project origin')
  check(typeof config.publishableKey === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey), 'Config needs a publishable key')
  return { ref: project.hostname.split('.')[0], origin: project.origin, publishableKey: config.publishableKey }
}

/** All interpolated values below are public config or validated identifiers, never credentials. */
export function setupSql(config, randomSchema = 'extensions') {
  const project = projectConfig(config)
  check(/^[a-z_][a-z0-9_]*$/.test(randomSchema), 'Unsupported pgcrypto schema')
  return {
    extensions: 'create extension if not exists pg_cron with schema pg_catalog;\ncreate extension if not exists pg_net with schema extensions;',
    secret: `do $setup$
begin
  perform pg_advisory_xact_lock(hashtextextended('faangin:reconcile-setup',0));
  if not exists(select 1 from vault.secrets where name=${q(SECRET_NAME)}) then
    perform vault.create_secret(encode("${randomSchema}".gen_random_bytes(32),'hex'),${q(SECRET_NAME)},'Faangin daily reconciliation internal credential');
  end if;
end $setup$;`,
    scheduler: `create or replace function faangin.enqueue_reconciliation() returns bigint
language plpgsql security invoker set search_path='' as $job$
declare credential text; signature text; request_id_value bigint; nonce_value uuid:=gen_random_uuid(); signed_at bigint:=floor(extract(epoch from clock_timestamp()))::bigint;
begin
  select decrypted_secret into strict credential from vault.decrypted_secrets where name=${q(SECRET_NAME)};
  signature:=encode("${randomSchema}".hmac('faangin-reconcile'||chr(10)||signed_at::text||chr(10)||nonce_value::text,credential,'sha256'),'hex');
  insert into faangin.reconcile_dispatches(nonce,signed_at_seconds) values(nonce_value,signed_at);
  request_id_value:=net.http_post(
    url:=${q(project.origin + '/functions/v1/faangin-api/reconcile')},
    headers:=jsonb_build_object('content-type','application/json','apikey',${q(project.publishableKey)},'x-faangin-reconcile-time',signed_at::text,'x-faangin-reconcile-nonce',nonce_value::text,'x-faangin-reconcile-signature',signature),
    body:='{}'::jsonb,
    timeout_milliseconds:=110000
  );
  update faangin.reconcile_dispatches d set request_id=request_id_value where d.nonce=nonce_value;
  delete from faangin.reconcile_dispatches where requested_at < now()-interval '30 days';
  return request_id_value;
end $job$;
revoke all on function faangin.enqueue_reconciliation() from public,anon,authenticated,service_role;
select cron.schedule(${q(JOB)},${q(SCHEDULE)},${q(COMMAND)}) as job_id;`
  }
}

export function safeHttpStatus(row) {
  let result
  try { result = JSON.parse(row.content)?.result } catch { /* Never echo an HTTP response body. */ }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  return { requestId: row.request_id, requestedAt: row.requested_at, responseAvailable: row.status_code != null || row.timed_out === true || row.transport_error === true,
    httpStatus: Number.isInteger(row.status_code) ? row.status_code : null, timedOut: row.timed_out === true, transportError: row.transport_error === true,
    checked: count(result?.checked), failed: count(result?.failed) }
}

function options(args) {
  const command = args[0]?.startsWith('--') || !args.length ? 'plan' : args.shift()
  check(['plan', 'apply', 'status', 'run-once'].includes(command), 'Use plan, apply, status, or run-once')
  const out = { command, envFile: resolve(root, 'backend/.env.supabase.local'), configFile: resolve(root, 'config/cloud.supabase.json') }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    check(['--env-file', '--config', '--confirm-project'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--'), 'Unknown or incomplete option')
    out[flag === '--env-file' ? 'envFile' : flag === '--config' ? 'configFile' : 'confirmProject'] = args[++i]
  }
  out.envFile = resolve(out.envFile); out.configFile = resolve(out.configFile)
  return out
}

async function replaceLocalCredential(path, secret) {
  // Preserve unrelated credentials and comments. Atomic replacement retains owner-only access.
  const text = await readFile(path, 'utf8')
  const lines = text.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?RECONCILE_SECRET\s*=/.test(line))
  while (lines.at(-1) === '') lines.pop()
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, lines.join('\n') + `\nRECONCILE_SECRET=${secret}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: setup-supabase-reconcile.mjs [plan|status|apply|run-once] [--env-file <ignored-owner-only-env>] [--config <public-json>] [--confirm-project <ref>]')
    console.log('plan/status are read-only. apply enables extensions, synchronizes the Vault/Edge secret and schedules daily 03:15 UTC. run-once separately calls billing reconciliation.')
    return
  }
  const opt = options([...args])
  const info = await lstat(opt.envFile)
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'Credential env file must be a regular owner-only file (chmod 600)')
  const env = { ...process.env, ...parseEnv(await readFile(opt.envFile, 'utf8')) }
  check(typeof env.SUPABASE_ACCESS_TOKEN === 'string' && env.SUPABASE_ACCESS_TOKEN.length > 20, 'Scoped SUPABASE_ACCESS_TOKEN required')
  const config = JSON.parse(await readFile(opt.configFile, 'utf8')), project = projectConfig(config)
  if (['apply', 'run-once'].includes(opt.command)) check(opt.confirmProject === project.ref, 'Mutation requires --confirm-project matching the public config project')
  async function api(path, body) {
    let response
    try { response = await fetch(`https://api.supabase.com/v1/projects/${project.ref}${path}`, { method: 'POST', headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000), redirect: 'error' }) }
    catch { throw new Error('Supabase management request failed or timed out; request and response withheld') }
    const text = await response.text()
    if (!response.ok) {
      let detail = ''
      try { const error = JSON.parse(text); detail = String(error.message ?? error.error ?? '').slice(0,800) } catch { /* Keep arbitrary response bodies private. */ }
      const redact = value => { if (typeof value === 'string' && value.length > 8) detail = detail.split(value).join('[redacted]'); else if (Array.isArray(value)) value.forEach(redact); else if (value && typeof value === 'object') Object.values(value).forEach(redact) }
      redact(body); redact(env)
      throw new Error(`Supabase management HTTP ${response.status} at ${path}: ${detail || 'response withheld'}`)
    }
    try { return text ? JSON.parse(text) : null } catch { throw new Error('Supabase management returned an unexpected response; body withheld') }
  }
  async function sql(query) { const rows = await api('/database/query', { query }); check(Array.isArray(rows), 'Management SQL returned an unexpected result; body withheld'); return rows }
  const extensions = await sql("select name,default_version,installed_version from pg_available_extensions where name in ('pg_cron','pg_net','supabase_vault','pgcrypto') order by name")
  const installed = name => extensions.some(row => row.name === name && row.installed_version)
  const inspect = (await sql(`select
    (select n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='gen_random_bytes' and pg_get_function_identity_arguments(p.oid)='integer' limit 1) as random_schema,
    current_setting('cron.timezone',true) as cron_timezone,
    to_regclass('faangin.reconcile_dispatches') is not null as audit_exists,
    exists(select 1 from vault.secrets where name=${q(SECRET_NAME)}) as owned_secret_exists,
    has_table_privilege('anon','vault.decrypted_secrets','SELECT') or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') as public_vault_access`))[0]
  check(installed('supabase_vault') && installed('pgcrypto') && inspect?.random_schema, 'Vault and pgcrypto must already be enabled before scheduler setup')
  check(!inspect.public_vault_access, 'Vault has browser-role access; repair its permissions before setup')
  check(['GMT', 'UTC'].includes(inspect.cron_timezone ?? 'GMT'), 'Cron timezone must be UTC/GMT for the reviewed schedule')
  let jobs = installed('pg_cron') ? await sql(`select jobid,schedule,active,command from cron.job where jobname=${q(JOB)}`) : []
  check(jobs.length <= 1 && jobs.every(job => job.command === COMMAND), 'Owned job name conflicts with an unexpected command; refusing to overwrite it')
  const plan = { ...setupSql(config, inspect.random_schema), migration: await readFile(migrationPath, 'utf8') }
  if (opt.command === 'plan') {
    console.log(JSON.stringify({ project: project.ref, command: 'read-only plan', schedule: SCHEDULE, timezone: 'UTC', extensions, vaultSecretExists: inspect.owned_secret_exists, job: jobs.map(({ jobid, schedule, active }) => ({ jobid, schedule, active })),
      changes: ['Enable pg_cron and pg_net if absent', 'Create a 32-byte random credential inside Vault only if absent; synchronize it to the Edge secret and ignored local env', 'Create private RLS dispatch audit and a service-only single-use nonce claim RPC', 'Install private HMAC dispatch function and one daily job at 03:15 UTC'], sql: plan,
      responseRetention: 'pg_net HTTP responses last 6 hours; dispatch IDs last 30 days; cron success means queued, not HTTP success' }, null, 2))
    return
  }
  if (opt.command === 'apply') {
    check(spawnSync('git', ['check-ignore', '--quiet', '--', opt.envFile], { cwd: root }).status === 0, 'Credential destination must be gitignored')
    // Supabase manages cron grants through its extension event trigger. Do not
    // re-run CREATE EXTENSION for installed extensions or overwrite those grants.
    if (!installed('pg_cron')) await sql('create extension pg_cron with schema pg_catalog')
    if (!installed('pg_net')) await sql('create extension pg_net with schema extensions')
    await sql(plan.migration)
    await sql(plan.secret)
    // The query contains only a secret name; the decrypted result stays in memory and is never printed.
    const secret = (await sql(`select decrypted_secret as value from vault.decrypted_secrets where name=${q(SECRET_NAME)}`))[0]?.value
    check(typeof secret === 'string' && /^[a-f0-9]{64}$/.test(secret), 'Owned Vault credential has an unsupported shape; no automatic rotation was performed')
    await api('/secrets', [{ name: 'RECONCILE_SECRET', value: secret }])
    await replaceLocalCredential(opt.envFile, secret)
    await sql(plan.scheduler)
    const jobId = (await sql(`select jobid from cron.job where jobname=${q(JOB)}`))[0]?.jobid
    check(Number.isSafeInteger(jobId), 'Scheduled job ID could not be verified')
    let billingReady = false
    try {
      const response = await fetch(`${project.origin}/functions/v1/faangin-api/health`, { headers: { apikey: project.publishableKey }, signal: AbortSignal.timeout(15_000) })
      billingReady = response.ok && (await response.json()).billingConfigured === true
    } catch { /* Keep the job disabled until billing setup and the health probe succeed. */ }
    await sql(`select cron.alter_job(${jobId},active := ${billingReady})`)
    console.log(JSON.stringify({ project: project.ref, configured: true, jobId, active: billingReady, schedule: SCHEDULE, timezone: 'UTC', edgeSecretSynchronized: true, smokePerformed: false }))
    return
  }
  if (opt.command === 'run-once') {
    check(installed('pg_cron') && installed('pg_net') && inspect.audit_exists && inspect.owned_secret_exists, 'Scheduler must be installed before run-once')
    const requestId = (await sql('select faangin.enqueue_reconciliation() as request_id'))[0]?.request_id
    check(Number.isSafeInteger(requestId) && requestId > 0, 'Dispatch returned an invalid request ID')
    let row
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await sql(`select d.request_id,d.requested_at,r.status_code,r.timed_out,r.error_msg is not null as transport_error,r.content from faangin.reconcile_dispatches d left join net._http_response r on r.id=d.request_id where d.request_id=${requestId}`)
      row = response[0]
      if (row?.status_code != null || row?.timed_out || row?.transport_error) break
      await new Promise(done => setTimeout(done, 2_000))
    }
    const status = safeHttpStatus(row ?? { request_id: requestId })
    console.log(JSON.stringify({ project: project.ref, ...status }))
    check(status.httpStatus === 200 && status.failed === 0, 'Reconciliation did not confirm HTTP 200 with zero failed accounts; inspect status before retrying')
    return
  }
  const history = installed('pg_cron') ? await sql(`select runid,status,start_time,end_time from cron.job_run_details where jobid=(select jobid from cron.job where jobname=${q(JOB)}) order by start_time desc limit 5`) : []
  const responses = installed('pg_net') && inspect.audit_exists ? await sql('select d.request_id,d.requested_at,r.status_code,r.timed_out,r.error_msg is not null as transport_error,r.content from faangin.reconcile_dispatches d left join net._http_response r on r.id=d.request_id order by d.requested_at desc limit 5') : []
  console.log(JSON.stringify({ project: project.ref, jobs: jobs.map(({ jobid, schedule, active }) => ({ jobid, schedule, active })), history: history.map(row => ({ ...row, status: ['succeeded', 'failed', 'running', 'starting', 'connecting', 'sending'].includes(row.status) ? row.status : 'unknown' })), requests: responses.map(safeHttpStatus), responseRetentionHours: 6 }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`reconcile-setup: ${error instanceof Error ? error.message : 'Setup failed; details withheld'}`); process.exitCode = 1 })
