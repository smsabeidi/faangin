import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { licenseState, signLicense, verifyLicense, type LicensePayload } from '../../src/license/sign.js'

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }
}

const keys = keyPair()
const payload: LicensePayload = {
  v: 1, uid: 'user-1', plan: 'pro', status: 'active',
  iat: 1_000, exp: 2_000, grace: 3_000, deviceId: 'mac-00000001',
  periodEnd: 5_000, rampUntil: 4_000, cancelAtPeriodEnd: false
}

test('round trip: sign then verify returns the same payload', () => {
  const token = signLicense(payload, keys.priv)
  const parts = token.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], 'v1')
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), payload)
  assert.deepEqual(verifyLicense(token, keys.pub), payload)
})

test('tampered payload is rejected', () => {
  const [v, p, s] = signLicense(payload, keys.priv).split('.')
  const forged = Buffer.from(JSON.stringify({ ...payload, uid: 'someone-else' })).toString('base64url')
  assert.equal(verifyLicense(`${v}.${forged}.${s}`, keys.pub), null)
  assert.equal(verifyLicense(`${v}.${p}.${s}`, keys.pub)?.uid, 'user-1')
})

test('tampered signature is rejected', () => {
  const [v, p, s] = signLicense(payload, keys.priv).split('.')
  const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  assert.equal(verifyLicense(`${v}.${p}.${flipped}`, keys.pub), null)
  assert.equal(verifyLicense(`${v}.${p}.${s.slice(0, -2)}`, keys.pub), null)
})

test('wrong key is rejected', () => {
  const token = signLicense(payload, keys.priv)
  assert.equal(verifyLicense(token, keyPair().pub), null)
})

test('malformed tokens are rejected, never thrown', () => {
  for (const bad of ['', 'v1', 'v1.x', 'v2.a.b', 'v1.a.b.c', 'not a token', 'v1..']) {
    assert.equal(verifyLicense(bad, keys.pub), null, bad)
  }
  assert.equal(verifyLicense(signLicense(payload, keys.priv), 'bm90IGEga2V5'), null)
})

test('licenseState: valid before exp, grace until grace, expired after', () => {
  assert.equal(licenseState(payload, 1_999), 'valid')
  assert.equal(licenseState(payload, 2_000), 'grace')
  assert.equal(licenseState(payload, 2_999), 'grace')
  assert.equal(licenseState(payload, 3_000), 'expired')
})
