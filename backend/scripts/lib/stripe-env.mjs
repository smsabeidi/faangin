// Shared by scripts/stripe-*.mjs: the Stripe SDK the functions use, its pinned API version, and key resolution.
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(root, 'functions', 'package.json'))
export const Stripe = require('stripe')

export function fail(message) { console.error(`stripe-scripts: ${message}`); process.exit(1) }

/** The API version pinned by the installed SDK; webhook endpoints are created with it so payload shapes match the code. */
export const API_VERSION = readFileSync(join(dirname(require.resolve('stripe')), 'apiVersion.js'), 'utf8').match(/ApiVersion = '([^']+)'/)?.[1]
if (!API_VERSION) fail('could not read the Stripe SDK API version from functions/node_modules/stripe')

export function readEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/**
 * STRIPE_SECRET_KEY from the environment, or with --sandbox the STRIPE_SANDBOX_SECRET_KEY line of .env.stripe-sandbox
 * (gitignored, owner-written). Live keys need --live as well, and are refused outright when allowLive is false.
 */
export function resolveKey(args, { allowLive = true } = {}) {
  let key = process.env.STRIPE_SECRET_KEY
  if (!key && args.includes('--sandbox')) {
    const file = join(root, '.env.stripe-sandbox')
    if (!existsSync(file)) fail(`--sandbox: ${file} is missing (one line: STRIPE_SANDBOX_SECRET_KEY=sk_test_...)`)
    key = readEnvFile(file).STRIPE_SANDBOX_SECRET_KEY
  }
  if (!key) fail('set STRIPE_SECRET_KEY or pass --sandbox')
  if (!/^(sk|rk)_(test|live)_/.test(key)) fail('the key does not look like a Stripe secret or restricted key')
  if (/^(sk|rk)_live_/.test(key)) {
    if (!allowLive) fail('live key refused: this script is sandbox-only')
    if (!args.includes('--live')) fail('live key refused without --live')
  }
  if (args.includes('--live') && !/^(sk|rk)_live_/.test(key)) fail('--live was given but the key is a test-mode key')
  return key
}

/** 'live' or 'test', from the key prefix (the account's charges_enabled says nothing about the mode of the key in use). */
export function keyMode(key) { return /^(sk|rk)_live_/.test(key) ? 'live' : 'test' }
