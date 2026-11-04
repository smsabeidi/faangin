#!/usr/bin/env node
/** Upload an explicit Edge allowlist; the management PAT never enters the Edge environment. */
import { spawn } from 'node:child_process'
import { lstat, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'

const { values } = parseArgs({ options: { 'env-file': { type: 'string', multiple: true }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: node backend/scripts/upload-supabase-secrets.mjs --env-file <owner-only ignored env> [--env-file <another env>]')
  process.exit(0)
}
const allowed = new Set(['LICENSE_SIGNING_KEY', 'OPENAI_API_KEY', 'RECONCILE_SECRET', 'STRIPE_CHECKOUT_KEY', 'STRIPE_WEBHOOK_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_EXPECT_LIVEMODE', 'FAST_MODEL', 'SMART_MODEL', 'TRANSCRIBE_MODEL', 'FAANGIN_HOSTING_ORIGIN', 'FAANGIN_ACTIVATION_URL', 'FAANGIN_SUPABASE_SERVER_KEY_NAME'])
const files = values['env-file'] ?? ['backend/.env.supabase.local']
let credentials = {}
let directory
try {
  for (const file of files) {
    const path = resolve(file), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Each env file must be a regular owner-only file (chmod 600).')
    credentials = { ...credentials, ...parseEnv(await readFile(path, 'utf8')) }
  }
  const token = credentials.SUPABASE_ACCESS_TOKEN ?? process.env.SUPABASE_ACCESS_TOKEN
  if (!token?.startsWith('sbp_')) throw new Error('A scoped SUPABASE_ACCESS_TOKEN is required.')
  const selected = Object.fromEntries(Object.entries(credentials).filter(([name]) => allowed.has(name)))
  if (!Object.keys(selected).length) throw new Error('No allowed Edge settings found.')
  if (Object.values(selected).some(value => /[\r\n\0]/.test(value))) throw new Error('Edge env values must be single-line strings.')
  const config = JSON.parse(await readFile(new URL('../../config/cloud.supabase.json', import.meta.url), 'utf8'))
  const origin = new URL(config.supabaseUrl)
  if (!/^[a-z]{20}\.supabase\.co$/.test(origin.hostname) || origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('Invalid Supabase public project configuration.')
  const ref = origin.hostname.split('.')[0]
  directory = await mkdtemp(join(tmpdir(), 'faangin-edge-secrets-'))
  const path = join(directory, 'edge.env')
  await writeFile(path, Object.entries(selected).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
  const outcome = await new Promise((resolveRun, reject) => {
    const child = spawn('supabase', ['secrets', 'set', '--project-ref', ref, '--env-file', path], { env: { ...process.env, SUPABASE_ACCESS_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''
    const collect = chunk => { diagnostic = (diagnostic + chunk).slice(-4000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', () => reject(new Error('Supabase CLI could not start.')))
    child.on('close', code => resolveRun({ code, diagnostic }))
  })
  if (outcome.code !== 0) {
    let diagnostic = outcome.diagnostic
    for (const value of [...Object.values(credentials), token]) if (value) diagnostic = diagnostic.split(value).join('[redacted]')
    throw new Error(`Supabase secret upload failed (${outcome.code}): ${diagnostic.slice(-600)}`)
  }
  console.log(`Configured ${Object.keys(selected).sort().join(', ')} on ${ref}. Management credentials excluded.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Supabase secret upload failed.')
  process.exitCode = 1
} finally {
  if (directory) await rm(directory, { recursive: true, force: true })
}
