import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const KEYS = /export const LICENSE_PUBLIC_KEYS: readonly string\[\] = \[[^\]]*\]/

test('the app copy of the cloud client matches backend/client, apart from the shipped license keys', () => {
  const backend = readFileSync(new URL('../backend/client/faangin-cloud.ts', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/main/faangin-cloud.ts', import.meta.url), 'utf8')
  assert.ok(KEYS.test(backend) && KEYS.test(app), 'both copies declare LICENSE_PUBLIC_KEYS')
  assert.equal(app.replace(KEYS, 'KEYS'), backend.replace(KEYS, 'KEYS'), 'edit backend/client/faangin-cloud.ts first, then copy it to src/main/faangin-cloud.ts keeping this build\'s LICENSE_PUBLIC_KEYS')
})
