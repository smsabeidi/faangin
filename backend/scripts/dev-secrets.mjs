#!/usr/bin/env node
// Writes functions/.secret.local (gitignored) with fake Stripe values and a fresh Ed25519 key pair,
// so the Functions emulator and tests run without any real secret. Idempotent: keeps an existing file.
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'functions', '.secret.local')
if (existsSync(target) && !process.argv.includes('--force')) { console.log(`kept ${target}`); process.exit(0) }
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
writeFileSync(target, [
  'STRIPE_CHECKOUT_KEY=rk_test_fake_checkout',
  'STRIPE_WEBHOOK_KEY=rk_test_fake_webhook',
  'STRIPE_WEBHOOK_SECRET=whsec_test_fake_secret',
  `LICENSE_SIGNING_KEY=${priv}`,
  `LICENSE_PUBLIC_KEY=${pub}`,
  ''
].join('\n'))
console.log(`wrote ${target}\nLICENSE_PUBLIC_KEY=${pub}`)
