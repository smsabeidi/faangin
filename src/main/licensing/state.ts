import type { VerifiedLicense } from '../faangin-cloud'
import type { LicenseState } from '../../shared/billing-types'

export interface LicenseStateInput {
  /** The build has an accounts backend. */
  configured: boolean
  signedIn: boolean
  /** A license token is stored, whether or not it still verifies. */
  hasToken: boolean
  /** The stored token's payload when its signature checks out for this user and device and `now < grace`. */
  verified: VerifiedLicense | null
}

/** Pure, so every boundary (grace, no plan, unverifiable token) is a unit test and nothing touches the disk. */
export function deriveLicenseState({ configured, signedIn, hasToken, verified }: LicenseStateInput): LicenseState {
  if (!configured) return { kind: 'unavailable' }
  if (!signedIn) return { kind: 'signed-out' }
  if (verified) {
    return verified.inGrace
      ? { kind: 'grace', plan: verified.plan, graceUntil: verified.grace }
      : { kind: 'active', plan: verified.plan, pastDue: verified.status === 'past_due', periodEnd: verified.periodEnd ?? null, cancelAtPeriodEnd: verified.cancelAtPeriodEnd === true }
  }
  return hasToken ? { kind: 'locked' } : { kind: 'no-plan' }
}
