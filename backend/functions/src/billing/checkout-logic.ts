// Pure decisions behind createCheckoutSession: no I/O, so unit tests need no emulator and index.ts exports no stray symbols.
import { createHash } from 'node:crypto'
import type { Plan } from '../config.js'
import { entitledPlan, type Entitlement } from '../entitlements.js'

/** flags/global, the parts Checkout reads. Missing fields fall back to these defaults. */
export interface CheckoutFlags { checkoutOpen: boolean; proSeatCap: number; automaticTax: boolean; termsConsent: boolean }
const DEFAULT_FLAGS: CheckoutFlags = { checkoutOpen: true, proSeatCap: 200, automaticTax: false, termsConsent: false }

/**
 * flags/global is edited by hand in the console, where "false" or "200" are easy to type as strings. Strictly typed, and a wrong
 * type lands on the safe side: tax and terms stay off unless exactly true, Pro checkout closes unless the flag is absent or exactly
 * true, and a seat cap that is not a number falls back to the default. Pure.
 */
export function parseCheckoutFlags(raw: Record<string, unknown> | undefined): CheckoutFlags {
  const r = raw ?? {}
  const cap = typeof r.proSeatCap === 'number' ? r.proSeatCap : typeof r.proSeatCap === 'string' && r.proSeatCap.trim() !== '' ? Number(r.proSeatCap) : Number.NaN
  return {
    checkoutOpen: r.checkoutOpen === undefined || r.checkoutOpen === true,
    proSeatCap: Number.isFinite(cap) ? cap : DEFAULT_FLAGS.proSeatCap,
    automaticTax: r.automaticTax === true,
    termsConsent: r.termsConsent === true
  }
}

/** Why a checkout may not start, or null when it may. Pure. */
export function checkoutBlocked(plan: Plan, entitlement: Entitlement, flags: CheckoutFlags, activeSeats: number): string | null {
  if (plan === 'byok') return entitledPlan(entitlement) === 'byok' ? 'BYOK is already purchased' : null
  if (entitledPlan(entitlement) === 'pro') return 'Pro is already active'
  if (!flags.checkoutOpen) return 'Pro checkout is closed right now'
  if (activeSeats >= flags.proSeatCap) return 'Pro is full right now'
  return null
}

/** Stripe statuses that still bill or may resume billing. Anything else is over for good. */
const ENDED_SUBSCRIPTION = new Set<string>(['canceled', 'incomplete_expired', 'incomplete'])
/** Live subscriptions that do not give access: the entitlement is 'canceled' until an invoice is paid or the subscription resumes. */
const ON_HOLD_SUBSCRIPTION = new Set<string>(['unpaid', 'paused'])

/**
 * What the Stripe customer's subscriptions mean for a new Pro checkout. null: none left, checkout may start. 'access': one is
 * paying or retrying (active, trialing, past_due). 'on_hold': the only live ones are unpaid or paused, so the buyer has no Pro but
 * a second subscription would double-bill once the old invoice is paid. Pure.
 */
export function liveSubscriptionState(subscriptions: ReadonlyArray<{ status: string }>): 'access' | 'on_hold' | null {
  const live = subscriptions.filter((s) => !ENDED_SUBSCRIPTION.has(s.status))
  if (!live.length) return null
  return live.every((s) => ON_HOLD_SUBSCRIPTION.has(s.status)) ? 'on_hold' : 'access'
}

/** True when the Stripe customer already has a subscription that is not over. Pure. */
export function hasLiveSubscription(subscriptions: ReadonlyArray<{ status: string }>): boolean {
  return liveSubscriptionState(subscriptions) !== null
}

/**
 * Idempotency key for creating a customer. Deterministic within a minute, so two concurrent first checkouts (a double click, two tabs)
 * share one Stripe customer, and no raw uid leaves the server. Stripe replays a saved response, 5xx included, for 24 hours under a key,
 * so the minute bucket keeps one transient failure from locking a buyer out for a day. Pure.
 */
export function customerIdempotencyKey(uid: string, email: string | undefined, now: number = Date.now()): string {
  const bucket = Math.floor(now / 60_000)
  return `faangin-customer-${createHash('sha256').update(`${uid}|${email ?? ''}|${bucket}`).digest('hex').slice(0, 40)}`
}
