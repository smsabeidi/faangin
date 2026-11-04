import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('secret scanner denies private Supabase/staged credentials without printing their values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-secret-scan-'))
  try {
    mkdirSync(join(dir, 'backend/scripts'), { recursive: true })
    cpSync(join(backend, 'scripts/check-secrets.sh'), join(dir, 'backend/scripts/check-secrets.sh'))
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0)
    const scan = expected => {
      const result = spawnSync('bash', ['backend/scripts/check-secrets.sh'], { cwd: dir, encoding: 'utf8' })
      assert.equal(result.status, expected, result.stderr)
      assert.ok(!`${result.stdout}${result.stderr}`.includes('FAKESECRET'))
    }
    const jwt = role => {
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${encode({ alg: 'HS256' })}.${encode({ role })}.${'x'.repeat(43)}`
    }
    writeFileSync(join(dir, 'public.json'), JSON.stringify({ publishableKey: 'sb_publishable_' + 'public'.repeat(8), anon: jwt('anon') }))
    scan(0)
    writeFileSync(join(dir, '.gitignore'), '.env*\n')
    writeFileSync(join(dir, '.env.local'), 'sb_secret_' + 'FAKESECRET'.repeat(5))
    scan(0)
    for (const value of ['sb_secret_' + 'FAKESECRET'.repeat(5), 'sbp_' + 'FAKESECRET'.repeat(5), jwt('service_role'), 'sk-proj-' + 'FAKESECRET'.repeat(5)]) {
      const file = join(dir, 'file with spaces\nand newline.txt')
      writeFileSync(file, value)
      scan(1)
      unlinkSync(file)
    }
    const privateName = join(dir, 'sb_secret_' + 'FAKESECRET'.repeat(5) + '.txt')
    writeFileSync(privateName, 'sb_secret_' + 'FAKESECRET'.repeat(5))
    scan(1)
    unlinkSync(privateName)
    writeFileSync(join(dir, 'staged.txt'), 'sb_secret_' + 'FAKESECRET'.repeat(5))
    assert.equal(spawnSync('git', ['add', 'staged.txt'], { cwd: dir }).status, 0)
    writeFileSync(join(dir, 'staged.txt'), 'clean working copy')
    scan(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('webhook setup preserves the creation secret through disable and saves only a protected env file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-webhook-setup-'))
  try {
    const secret = 'whsec_' + 'syntheticfixturevalue'.repeat(3)
    const stub = `
export const API_VERSION = 'fixture';
export function fail(message) { console.error(message); process.exit(1) }
export const resolveKey = () => '';
export const keyMode = () => 'test';
export async function createStripeClient() { return { stripe: new Stripe(), mode: 'test' } }
export class Stripe {
  constructor() {
    this.webhookEndpoints = {
      list: () => [],
      create: async input => ({ id: 'we_fixture', secret: ${JSON.stringify(secret)}, api_version: 'fixture', enabled_events: input.enabled_events }),
      update: async id => ({ id, api_version: 'fixture', enabled_events: [], status: 'disabled' })
    }
  }
}`
    writeFileSync(join(dir, 'stub.mjs'), stub)
    const source = readFileSync(join(backend, 'scripts/stripe-setup.mjs'), 'utf8').replace("'./lib/stripe-env.mjs'", "'./stub.mjs'")
    writeFileSync(join(dir, 'setup.mjs'), source)
    const run = args => {
      const result = spawnSync(process.execPath, [join(dir, 'setup.mjs'), 'webhook', '--url', 'https://project.supabase.test/functions/v1/stripe-webhook', ...args], { encoding: 'utf8' })
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret))
      return result
    }
    const missing = run([])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /requires --secret-out/)
    const output = join(dir, '.env.webhook.local')
    const result = run(['--secret-out', output, '--disabled'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(output, 'utf8'), `STRIPE_WEBHOOK_SECRET=${secret}\n`)
    assert.equal(statSync(output).mode & 0o777, 0o600)
    assert.notEqual(run(['--secret-out', output]).status, 0)
    assert.equal(readFileSync(output, 'utf8'), `STRIPE_WEBHOOK_SECRET=${secret}\n`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('CLI setup adapter enforces exact test account, encodes nested fields, and follows every page', async () => {
  const { createCliStripe, formFields } = await import('../lib/stripe-cli.mjs')
  assert.deepEqual(formFields({ metadata: { plan: 'pro' }, enabled_events: ['first', 'second'], active: false }), ['metadata[plan]=pro', 'enabled_events[0]=first', 'enabled_events[1]=second', 'active=false'])
  await assert.rejects(createCliStripe({ accountId: 'acct_fixture', apiVersion: 'fixture', run: async () => ({ authorized: true, mode: 'live', account_id: 'acct_fixture' }) }), /test mode/)
  await assert.rejects(createCliStripe({ accountId: 'acct_fixture', apiVersion: 'fixture', run: async () => ({ authorized: true, mode: 'test', account_id: 'acct_other' }) }), /exact expected account/)
  const calls = []
  const stripe = await createCliStripe({ accountId: 'acct_fixture', apiVersion: 'fixture', run: async args => {
    calls.push(args)
    if (args[0] === 'whoami') return { authorized: true, mode: 'test', account_id: 'acct_fixture' }
    if (args[0] === 'post') return { id: 'prod_new', livemode: false }
    return args.includes('starting_after=prod_first') ? { data: [{ id: 'prod_second', livemode: false }], has_more: false } : { data: [{ id: 'prod_first', livemode: false }], has_more: true }
  } })
  const products = []
  for await (const product of stripe.products.list({ limit: 100 })) products.push(product.id)
  assert.deepEqual(products, ['prod_first', 'prod_second'])
  await stripe.products.create({ metadata: { faangin_key: 'pro' } })
  assert.ok(calls.at(-1).includes('metadata[faangin_key]=pro'))
  assert.ok(calls.every(args => !args.includes('--live')))
  const refused = await createCliStripe({ accountId: 'acct_fixture', apiVersion: 'fixture', run: async args => args[0] === 'whoami' ? { authorized: true, mode: 'test', account_id: 'acct_fixture' } : { data: [{ livemode: true }] } })
  await assert.rejects(Promise.resolve(refused.products.list()), /Refusing a live/)
})


test('Edge secret uploader excludes management/reserved/unknown fields, cleans up, and redacts CLI diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-edge-upload-'))
  try {
    const capture = join(dir, 'capture.json')
    const source = join(dir, '.env.fixture.local')
    const values = {
      SUPABASE_ACCESS_TOKEN: 'sbp_' + 'FAKEPAT'.repeat(8),
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-reserved-service-role',
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'fixture-reserved-secret-map' }),
      UNKNOWN_SETTING: 'fixture-unknown-secret',
      FAANGIN_SUPABASE_SERVER_KEY_NAME: 'fixture-replacement',
      LICENSE_SIGNING_KEY: 'fixture-signing-key',
      STRIPE_WEBHOOK_SECRET: 'whsec_' + 'fixture-signature-value'.repeat(3),
      STRIPE_EXPECT_LIVEMODE: 'false'
    }
    writeFileSync(source, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), file = args[args.indexOf('--env-file') + 1];
const contents = fs.readFileSync(file, 'utf8');
fs.writeFileSync(process.env.FAANGIN_TEST_CAPTURE, JSON.stringify({ args, file, mode: fs.statSync(file).mode & 511, contents, token: process.env.SUPABASE_ACCESS_TOKEN }), { mode: 384 });
console.log(process.env.SUPABASE_ACCESS_TOKEN + contents + 'fixture-unknown-secret');
process.exit(process.env.FAANGIN_TEST_CLI_FAIL === '1' ? 2 : 0);
`
    const binary = join(dir, 'supabase')
    writeFileSync(binary, fake, { mode: 0o700 })
    const run = failure => spawnSync(process.execPath, [join(backend, 'scripts/upload-supabase-secrets.mjs'), '--env-file', source], {
      cwd: resolve(backend, '..'), encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAANGIN_TEST_CAPTURE: capture, FAANGIN_TEST_CLI_FAIL: failure ? '1' : '0' }
    })
    const success = run(false)
    assert.equal(success.status, 0, success.stderr)
    const record = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(record.mode, 0o600)
    assert.equal(record.token, values.SUPABASE_ACCESS_TOKEN)
    assert.ok(record.contents.includes('LICENSE_SIGNING_KEY='))
    assert.ok(record.contents.includes('STRIPE_WEBHOOK_SECRET='))
    assert.ok(record.contents.includes('FAANGIN_SUPABASE_SERVER_KEY_NAME="fixture-replacement"'))
    assert.doesNotMatch(record.contents, /^SUPABASE_/m)
    assert.ok(!record.contents.includes('UNKNOWN_SETTING'))
    for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS', 'UNKNOWN_SETTING']) assert.ok(!record.contents.includes(values[key]))
    assert.ok(!record.args.some(arg => arg.includes(values.SUPABASE_ACCESS_TOKEN)))
    assert.equal(existsSync(record.file), false)
    assert.equal(existsSync(dirname(record.file)), false)
    for (const value of Object.values(values)) if (value !== 'false') assert.ok(!`${success.stdout}${success.stderr}`.includes(value))
    const failure = run(true)
    assert.notEqual(failure.status, 0)
    assert.match(failure.stderr, /upload failed \(2\)/)
    for (const value of Object.values(values)) if (value !== 'false') assert.ok(!`${failure.stdout}${failure.stderr}`.includes(value))
    assert.equal(existsSync(JSON.parse(readFileSync(capture, 'utf8')).file), false)
    unlinkSync(capture)
    chmodSync(source, 0o644)
    const unprotected = run(false)
    assert.notEqual(unprotected.status, 0)
    assert.match(unprotected.stderr, /owner-only/)
    assert.equal(existsSync(capture), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
