// Pure Ed25519 license signing and verification. No Firebase imports, so unit tests need no emulator.
// Token: v1.<base64url payload JSON>.<base64url signature over the payload bytes>
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { EntitlementStatus } from '../entitlements.js'

export interface LicensePayload {
  v: 1
  uid: string
  plan: 'byok' | 'pro'
  status: EntitlementStatus
  /** Issued at, Unix ms. */
  iat: number
  /** iat + LICENSE_TTL_DAYS. */
  exp: number
  /** exp + LICENSE_GRACE_DAYS: the app keeps working until then without a refresh. */
  grace: number
  deviceId: string
  periodEnd?: number
  rampUntil?: number
  cancelAtPeriodEnd?: boolean
}

export type LicenseState = 'valid' | 'grace' | 'expired'

/** @param privateKeyBase64 base64 of a PKCS#8 DER Ed25519 private key (LICENSE_SIGNING_KEY). */
export function signLicense(payload: LicensePayload, privateKeyBase64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' })
  const bytes = Buffer.from(JSON.stringify(payload))
  return `v1.${bytes.toString('base64url')}.${sign(null, bytes, key).toString('base64url')}`
}

/**
 * Returns the payload when the signature checks out under the given public key (base64 SPKI DER), else null.
 * Does not look at time; combine with licenseState.
 */
export function verifyLicense(token: string, publicKeyBase64: string): LicensePayload | null {
  try {
    const [version, payload, signature, ...rest] = token.split('.')
    if (version !== 'v1' || !payload || !signature || rest.length) return null
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    const bytes = Buffer.from(payload, 'base64url')
    if (!verify(null, bytes, key, Buffer.from(signature, 'base64url'))) return null
    const parsed = JSON.parse(bytes.toString()) as LicensePayload
    return parsed.v === 1 && typeof parsed.uid === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** valid before exp, grace from exp until grace, expired after. */
export function licenseState(payload: Pick<LicensePayload, 'exp' | 'grace'>, nowMs: number): LicenseState {
  if (nowMs < payload.exp) return 'valid'
  if (nowMs < payload.grace) return 'grace'
  return 'expired'
}
