/**
 * Ed25519 JWT verification for Faangin license tokens.
 *
 * Tokens are compact JWTs ("header.payload.signature") signed with Ed25519.
 * We validate iss, aud, exp, nbf, and the signature. Any failure returns
 * null; this function never throws.
 */

import * as ed from '@noble/ed25519'
import type { LicensePublicKey, LicenseTokenPayload } from '../../shared/billing-types'

const EXPECTED_ISS = 'faangin-license-v1'
const EXPECTED_AUD = 'faangin-app'
const CLOCK_SKEW_SECONDS = 60

interface JwtHeader {
  alg: string
  typ?: string
  kid?: string
}

export function parseJwtHeader(token: string): JwtHeader | null {
  try {
    const first = token.indexOf('.')
    if (first <= 0) return null
    const header = JSON.parse(base64UrlToString(token.slice(0, first)))
    if (!header || typeof header !== 'object') return null
    if (typeof header.alg !== 'string') return null
    return header as JwtHeader
  } catch {
    return null
  }
}

export async function verifyLicenseToken(
  token: string,
  publicKey: LicensePublicKey,
  now: number = Math.floor(Date.now() / 1000),
): Promise<LicenseTokenPayload | null> {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerSegment, payloadSegment, signatureSegment] = parts
  if (!headerSegment || !payloadSegment || !signatureSegment) return null

  let header: JwtHeader
  let payload: unknown
  let signature: Uint8Array
  let signedBytes: Uint8Array
  try {
    header = JSON.parse(base64UrlToString(headerSegment)) as JwtHeader
    payload = JSON.parse(base64UrlToString(payloadSegment))
    signature = base64UrlToBytes(signatureSegment)
    signedBytes = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  } catch {
    return null
  }

  if (!header || header.alg !== 'EdDSA') return null
  if (publicKey.alg !== 'EdDSA') return null
  if (header.kid && header.kid !== publicKey.kid) return null

  let verifiedKey: Uint8Array
  try {
    verifiedKey = base64UrlToBytes(publicKey.publicKey)
  } catch {
    return null
  }
  if (verifiedKey.length !== 32) return null

  let ok = false
  try {
    ok = await ed.verifyAsync(signature, signedBytes, verifiedKey)
  } catch {
    return null
  }
  if (!ok) return null

  if (!isLicensePayloadShape(payload)) return null
  const typed = payload as LicenseTokenPayload
  if (typed.iss !== EXPECTED_ISS) return null
  if (typed.aud !== EXPECTED_AUD) return null
  if (typeof typed.exp !== 'number' || typeof typed.nbf !== 'number') return null
  if (typed.nbf > now + CLOCK_SKEW_SECONDS) return null
  if (typed.exp <= now - CLOCK_SKEW_SECONDS) return null
  return typed
}

function isLicensePayloadShape(value: unknown): value is LicenseTokenPayload {
  if (!value || typeof value !== 'object') return false
  const object = value as Record<string, unknown>
  const requiredStrings = ['iss', 'aud', 'sub', 'jti', 'plan', 'status', 'deviceId']
  for (const key of requiredStrings) {
    if (typeof object[key] !== 'string') return false
  }
  const requiredNumbers = ['iat', 'exp', 'nbf', 'periodEnd', 'graceUntil']
  for (const key of requiredNumbers) {
    if (typeof object[key] !== 'number' || !Number.isFinite(object[key] as number)) return false
  }
  return true
}

export function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4)
  const binary = Buffer.from(padded, 'base64')
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
}

export function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input))
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/**
 * Build a compact JWT for tests and dev tooling. Not called by production code.
 */
export async function signLicenseTokenForTesting(
  payload: LicenseTokenPayload,
  privateKey: Uint8Array,
  kid: string,
): Promise<string> {
  const header = { alg: 'EdDSA', typ: 'JWT', kid }
  const encodedHeader = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)))
  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await ed.signAsync(new TextEncoder().encode(signingInput), privateKey)
  return `${signingInput}.${bytesToBase64Url(signature)}`
}
