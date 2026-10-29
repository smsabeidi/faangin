import { db } from './admin.js'

export type PlanName = 'none' | 'byok' | 'pro'
export type EntitlementStatus = 'active' | 'past_due' | 'canceled' | 'revoked'

/**
 * entitlements/{uid}: server-only. Written only by the Stripe webhook, reconcile and admin tooling.
 * BYOK (one-time purchase) and Pro (subscription) are tracked independently in `byok` and `pro`; the top-level
 * `plan`/`status` are the plan in force, derived by fulfill.ts (Pro while its subscription is live, else BYOK
 * while owned). The gateway and issueLicense read only those two fields.
 */
export interface Entitlement {
  plan: PlanName
  status: EntitlementStatus
  stripeCustomerId?: string
  byok?: { status: 'active' | 'revoked'; purchasedAt: number; paymentIntentId: string; checkoutSessionId: string }
  pro?: {
    status: EntitlementStatus
    subscriptionId: string
    priceLookupKey: string
    startedAt: number
    currentPeriodStart: number
    currentPeriodEnd: number
    cancelAtPeriodEnd: boolean
    /** Until this time the account may use 30% of each allowance (new subscription, new card, after refund/dispute). */
    rampUntil: number
  }
  /** Why the entitlement is revoked or canceled, for support. */
  reason?: string
  updatedAt: number
}

export const EMPTY_ENTITLEMENT: Entitlement = { plan: 'none', status: 'active', updatedAt: 0 }

export async function readEntitlement(uid: string): Promise<Entitlement> {
  const snap = await db.collection('entitlements').doc(uid).get()
  return snap.exists ? (snap.data() as Entitlement) : EMPTY_ENTITLEMENT
}

/** BYOK is a one-time purchase; Pro counts while active or past_due (Stripe is still retrying). */
export function entitledPlan(entitlement: Entitlement): PlanName {
  if (entitlement.plan === 'byok') return entitlement.status === 'revoked' ? 'none' : 'byok'
  if (entitlement.plan === 'pro') return entitlement.status === 'active' || entitlement.status === 'past_due' ? 'pro' : 'none'
  return 'none'
}
