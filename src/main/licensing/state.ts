/**
 * Pure derivation of the user-visible license state from the cached
 * entitlement, a verified token payload, and the server-side revocation set.
 *
 * Keeping this pure means every boundary case (just-before-exp, inside grace,
 * revoked, missing cache, etc.) is covered by unit tests without a Firebase
 * dependency and without touching the file system.
 */

import type { LicenseTokenPayload, Plan } from '../../shared/billing-types'
import type { CachedEntitlement } from './entitlement-cache'

export type LicenseState =
  | { kind: 'none' }
  | { kind: 'active'; plan: Plan; renewsAt: number }
  | { kind: 'grace'; plan: Plan; graceUntil: number }
  | { kind: 'expired'; plan: Plan }
  | { kind: 'revoked' }

export interface DeriveInput {
  /** Unix seconds. */
  now: number
  cached: CachedEntitlement | null
  /**
   * The verified payload returned by verifyLicenseToken. Pass null when the
   * cached token could not be verified; we then fall back to the cache's
   * durations only for the grace window.
   */
  verifiedPayload: LicenseTokenPayload | null
  /**
   * jti values the backend has reported as revoked. Pass [] when no list is
   * available (offline); revocation then relies on the next refresh.
   */
  revokedJtis?: ReadonlyArray<string>
}

export function deriveLicenseState(input: DeriveInput): LicenseState {
  const { now, cached, verifiedPayload, revokedJtis = [] } = input

  if (!cached) return { kind: 'none' }

  // Revocation beats everything else, even an unexpired token.
  if (verifiedPayload && revokedJtis.includes(verifiedPayload.jti)) {
    return { kind: 'revoked' }
  }
  if (
    cached.entitlement.status === 'canceled' ||
    cached.entitlement.status === 'refunded' ||
    cached.entitlement.status === 'disputed'
  ) {
    return { kind: 'revoked' }
  }

  const plan = cached.entitlement.plan
  const expiresAt = verifiedPayload?.exp ?? cached.licenseExpiresAt
  const graceUntil = verifiedPayload?.graceUntil ?? cached.graceUntil

  if (verifiedPayload && now < expiresAt) {
    return { kind: 'active', plan, renewsAt: expiresAt }
  }

  if (now < graceUntil) {
    return { kind: 'grace', plan, graceUntil }
  }

  return { kind: 'expired', plan }
}

/** Convenience: did the given state unlock gated features? */
export function isLicenseUsable(state: LicenseState): boolean {
  return state.kind === 'active' || state.kind === 'grace'
}
