/** Who is calling, and whether they may use Pro. Mirrors functions/src/entitlements.ts (the packages share no code). */

export type PlanName = 'none' | 'byok' | 'pro'
export type EntitlementStatus = 'active' | 'past_due' | 'canceled' | 'revoked'

/** entitlements/{uid}: server-only, written by the Stripe webhook and reconcile. */
export interface Entitlement {
  plan: PlanName
  status: EntitlementStatus
  stripeCustomerId?: string
  byok?: { purchasedAt: number; paymentIntentId: string; checkoutSessionId: string }
  pro?: {
    subscriptionId: string
    priceLookupKey: string
    startedAt: number
    currentPeriodStart: number
    currentPeriodEnd: number
    cancelAtPeriodEnd: boolean
    /** Until this time the account may use 30% of each allowance. */
    rampUntil: number
  }
  reason?: string
  updatedAt: number
}

export const EMPTY_ENTITLEMENT: Entitlement = { plan: 'none', status: 'active', updatedAt: 0 }

/** BYOK is a one-time purchase; Pro counts while active or past_due (Stripe is still retrying). */
export function entitledPlan(entitlement: Entitlement): PlanName {
  if (entitlement.plan === 'byok') return entitlement.status === 'revoked' ? 'none' : 'byok'
  if (entitlement.plan === 'pro') return entitlement.status === 'active' || entitlement.status === 'past_due' ? 'pro' : 'none'
  return 'none'
}

/** flags/global: kill switches edited in the console. */
export interface Flags {
  checkoutOpen: boolean
  proSessionsOpen: boolean
  smartToFast: boolean
  handsfreeOff: boolean
  transcriptionOff: boolean
  blockedUids: string[]
  proSeatCap: number
}

export const DEFAULT_FLAGS: Flags = {
  checkoutOpen: true,
  proSessionsOpen: true,
  smartToFast: false,
  handsfreeOff: false,
  transcriptionOff: false,
  blockedUids: [],
  proSeatCap: 200
}

export interface AuthDeps {
  verifyIdToken(idToken: string): Promise<{ uid: string }>
  loadEntitlement(uid: string): Promise<Entitlement>
  loadFlags(): Promise<Flags>
}

export interface AuthOk { ok: true; uid: string; entitlement: Entitlement; flags: Flags }
export interface AuthFail { ok: false; status: 401 | 402 | 403 | 503; body: { error: { code: string; message: string } } }

const fail = (status: AuthFail['status'], code: string, message: string): AuthFail => ({ ok: false, status, body: { error: { code, message } } })

/** Every route: Bearer ID token -> 401; not Pro -> 402; blocked -> 403; Pro paused -> 503. */
export async function authorize(deps: AuthDeps, authorization: string | undefined): Promise<AuthOk | AuthFail> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!token) return fail(401, 'unauthorized', 'Missing or malformed Authorization header')
  let uid: string
  try {
    ;({ uid } = await deps.verifyIdToken(token))
  } catch {
    return fail(401, 'unauthorized', 'Invalid ID token')
  }
  const [entitlement, flags] = await Promise.all([deps.loadEntitlement(uid), deps.loadFlags()])
  if (entitledPlan(entitlement) !== 'pro') return fail(402, 'no_pro', 'Faangin Pro is required for this endpoint')
  if (flags.blockedUids.includes(uid)) return fail(403, 'blocked', 'This account is blocked')
  if (!flags.proSessionsOpen) return fail(503, 'pro_paused', 'Pro sessions are paused, try again later')
  return { ok: true, uid, entitlement, flags }
}
