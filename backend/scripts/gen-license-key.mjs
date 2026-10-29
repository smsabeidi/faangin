#!/usr/bin/env node
// Generates the production/staging license signing key pair. Pipe the private key straight into
// Secret Manager; never paste it into chat, a ticket or git. Example:
//   node scripts/gen-license-key.mjs > /tmp/license-key.txt
//   firebase functions:secrets:set LICENSE_SIGNING_KEY --project faangin-staging --data-file /tmp/license-key.txt
//   rm -P /tmp/license-key.txt
// The public key printed on stderr ships inside the desktop app (client/faangin-cloud.ts).
import { generateKeyPairSync } from 'node:crypto'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'))
process.stderr.write(`PUBLIC KEY (base64 SPKI DER, safe to ship): ${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}\n`)
