import assert from 'node:assert/strict'
import test from 'node:test'
import * as ed from '@noble/ed25519'
import type { LicensePublicKey, LicenseTokenPayload } from '../src/shared/billing-types'
import { bytesToBase64Url, signLicenseTokenForTesting, verifyLicenseToken } from '../src/main/licensing/verify'

async function makeKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: LicensePublicKey }> {
  const privateKey = ed.utils.randomPrivateKey()
  const pubBytes = await ed.getPublicKeyAsync(privateKey)
  return {
    privateKey,
    publicKey: { kid: 'test-key-1', alg: 'EdDSA', publicKey: bytesToBase64Url(pubBytes) },
  }
}

function makePayload(override: Partial<LicenseTokenPayload> = {}): LicenseTokenPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'faangin-license-v1',
    aud: 'faangin-app',
    sub: 'uid-123',
    iat: now,
    exp: now + 30 * 86_400,
    nbf: now - 60,
    jti: 'jti-' + now,
    plan: 'pro_monthly',
    status: 'active',
    deviceId: 'd'.repeat(64),
    periodEnd: now + 30 * 86_400,
    graceUntil: now + 44 * 86_400,
    ...override,
  }
}

test('verifies a well-formed Ed25519 license token', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const payload = makePayload()
  const token = await signLicenseTokenForTesting(payload, privateKey, publicKey.kid)
  const verified = await verifyLicenseToken(token, publicKey)
  assert.ok(verified)
  assert.equal(verified.sub, payload.sub)
  assert.equal(verified.plan, 'pro_monthly')
})

test('rejects a token with the wrong issuer', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const token = await signLicenseTokenForTesting(makePayload({ iss: 'malicious' as 'faangin-license-v1' }), privateKey, publicKey.kid)
  assert.equal(await verifyLicenseToken(token, publicKey), null)
})

test('rejects a token with the wrong audience', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const token = await signLicenseTokenForTesting(makePayload({ aud: 'faangin-web' as 'faangin-app' }), privateKey, publicKey.kid)
  assert.equal(await verifyLicenseToken(token, publicKey), null)
})

test('rejects an expired token', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const now = Math.floor(Date.now() / 1000)
  const token = await signLicenseTokenForTesting(makePayload({ exp: now - 3600, nbf: now - 7200, iat: now - 7200 }), privateKey, publicKey.kid)
  assert.equal(await verifyLicenseToken(token, publicKey, now), null)
})

test('rejects a token whose nbf is in the future', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const now = Math.floor(Date.now() / 1000)
  const token = await signLicenseTokenForTesting(makePayload({ nbf: now + 3600, iat: now, exp: now + 7200 }), privateKey, publicKey.kid)
  assert.equal(await verifyLicenseToken(token, publicKey, now), null)
})

test('rejects a tampered signature', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const token = await signLicenseTokenForTesting(makePayload(), privateKey, publicKey.kid)
  const parts = token.split('.')
  const flippedSig = parts[2].split('').reverse().join('')
  const tampered = `${parts[0]}.${parts[1]}.${flippedSig}`
  assert.equal(await verifyLicenseToken(tampered, publicKey), null)
})

test('rejects a token signed by a different key', async () => {
  const victim = await makeKeyPair()
  const attacker = await makeKeyPair()
  const token = await signLicenseTokenForTesting(makePayload(), attacker.privateKey, victim.publicKey.kid)
  assert.equal(await verifyLicenseToken(token, victim.publicKey), null)
})

test('rejects malformed tokens', async () => {
  const { publicKey } = await makeKeyPair()
  assert.equal(await verifyLicenseToken('', publicKey), null)
  assert.equal(await verifyLicenseToken('not-a-jwt', publicKey), null)
  assert.equal(await verifyLicenseToken('aaa.bbb', publicKey), null)
})

test('rejects a token whose header kid does not match the public key', async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const token = await signLicenseTokenForTesting(makePayload(), privateKey, 'other-kid')
  assert.equal(await verifyLicenseToken(token, publicKey), null)
})
