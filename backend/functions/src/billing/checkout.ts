import { HttpsError, onCall } from 'firebase-functions/https'
import * as logger from 'firebase-functions/logger'
import type Stripe from 'stripe'
import { db } from '../admin.js'
import { PRICE_LOOKUP, STRIPE_CHECKOUT_KEY, hostingOrigin, type Plan } from '../config.js'
import { readEntitlement } from '../entitlements.js'
import { checkoutBlocked, customerIdempotencyKey, liveSubscriptionState, parseCheckoutFlags, type CheckoutFlags } from './checkout-logic.js'
import { checkoutSessionParams, pickPortalConfiguration } from './checkout-params.js'
import { makeStripe } from './stripe-client.js'

async function readFlagsAndSeats(): Promise<{ flags: CheckoutFlags; activeSeats: number }> {
  const [flags, stats] = await db.getAll(db.collection('flags').doc('global'), db.collection('stats').doc('pro'))
  return {
    flags: parseCheckoutFlags(flags.data()),
    activeSeats: Number(stats.data()?.activeSeats ?? 0)
  }
}

/**
 * customers/{uid} ↔ customersByStripe/{stripeCustomerId}; creates the Stripe customer on first use.
 * Only a verified email goes on the customer: Checkout prefills and locks the customer's email, so a mistyped,
 * unverified address would receive every receipt and renewal notice. Without one, Checkout asks the buyer for it.
 * The idempotency key (see customerIdempotencyKey) makes two concurrent first checkouts share one customer.
 */
async function ensureCustomer(stripe: Stripe, uid: string, email: string | undefined, emailVerified: boolean): Promise<string> {
  const ref = db.collection('customers').doc(uid)
  const existing = (await ref.get()).data()?.stripeCustomerId as string | undefined
  if (existing) return existing
  const trusted = emailVerified ? email : undefined
  const customer = await stripe.customers.create({ email: trusted, metadata: { uid } }, { idempotencyKey: customerIdempotencyKey(uid, trusted) })
  const batch = db.batch()
  batch.set(ref, { stripeCustomerId: customer.id, email: trusted ?? null, createdAt: Date.now() })
  batch.set(db.collection('customersByStripe').doc(customer.id), { uid })
  await batch.commit()
  return customer.id
}

export const createCheckoutSession = onCall({ secrets: [STRIPE_CHECKOUT_KEY], cors: true }, async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first')
  const plan = (request.data as { plan?: unknown } | undefined)?.plan
  if (typeof plan !== 'string' || !(plan in PRICE_LOOKUP)) throw new HttpsError('invalid-argument', 'plan must be byok, pro_monthly or pro_annual')

  const [entitlement, { flags, activeSeats }] = await Promise.all([readEntitlement(uid), readFlagsAndSeats()])
  const blocked = checkoutBlocked(plan as Plan, entitlement, flags, activeSeats)
  if (blocked) throw new HttpsError('failed-precondition', blocked)

  const stripe = makeStripe(STRIPE_CHECKOUT_KEY.value())
  const customer = await ensureCustomer(stripe, uid, request.auth?.token.email, request.auth?.token.email_verified === true)
  if (plan !== 'byok') {
    // Stripe is the source of truth here: the entitlement lags behind the webhook, and a second subscription would double-bill.
    const subscriptions = await stripe.subscriptions.list({ customer, status: 'all', limit: 10 })
    const live = liveSubscriptionState(subscriptions.data)
    if (live === 'access') throw new HttpsError('failed-precondition', 'Pro is already active')
    if (live === 'on_hold') throw new HttpsError('failed-precondition', 'Your Pro subscription is on hold. Use Manage billing to pay the open invoice, or contact support.')
  }
  const price = (await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP[plan as Plan]], active: true, limit: 1 })).data[0]
  if (!price) throw new HttpsError('internal', `No Stripe price for ${plan}`)

  // One open checkout per buyer: an earlier tab's session must not be payable alongside this one (two Pro subscriptions, two BYOK charges).
  const open = await stripe.checkout.sessions.list({ customer, status: 'open', limit: 10 })
  await Promise.all(open.data.map((session) => stripe.checkout.sessions.expire(session.id).catch((err) => logger.warn('createCheckoutSession: could not expire an older session', { uid, session: session.id, message: (err as Error).message }))))

  const session = await stripe.checkout.sessions.create(
    checkoutSessionParams({ plan: plan as Plan, uid, customer, priceId: price.id, automaticTax: flags.automaticTax, termsConsent: flags.termsConsent })
  )
  if (!session.url) throw new HttpsError('internal', 'Stripe returned no checkout url')
  return { url: session.url }
})

// Remembered per instance once found; a missing configuration is looked up again on every call (it is a setup-time state).
let portalConfiguration: { id: string; at: number } | undefined
const PORTAL_CONFIGURATION_TTL_MS = 10 * 60 * 1000

async function findPortalConfiguration(stripe: Stripe): Promise<string | undefined> {
  const now = Date.now()
  if (portalConfiguration && now - portalConfiguration.at < PORTAL_CONFIGURATION_TTL_MS) return portalConfiguration.id
  const id = pickPortalConfiguration((await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data)
  if (id) portalConfiguration = { id, at: now }
  return id ?? undefined
}

export const createPortalSession = onCall({ secrets: [STRIPE_CHECKOUT_KEY], cors: true }, async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first')
  const customer = (await db.collection('customers').doc(uid).get()).data()?.stripeCustomerId as string | undefined
  if (!customer) throw new HttpsError('failed-precondition', 'No billing account yet')
  const stripe = makeStripe(STRIPE_CHECKOUT_KEY.value())
  const configuration = await findPortalConfiguration(stripe)
  if (!configuration) {
    // Never fall back to the Dashboard default: it may allow plan switching, which would reset the metered allowances.
    logger.error('createPortalSession: no portal configuration tagged faangin=v1; run scripts/stripe-setup.mjs portal', { uid })
    throw new HttpsError('failed-precondition', 'Billing portal is not set up yet')
  }
  const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${hostingOrigin()}/activate`, configuration })
  return { url: session.url }
})
