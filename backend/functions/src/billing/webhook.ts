import { onRequest } from 'firebase-functions/https'
import * as logger from 'firebase-functions/logger'
import type Stripe from 'stripe'
import { db } from '../admin.js'
import { STRIPE_WEBHOOK_KEY, STRIPE_WEBHOOK_SECRET, expectLivemode } from '../config.js'
import { EMPTY_ENTITLEMENT, type Entitlement } from '../entitlements.js'
import { applyStripeEvent, holdsProSeat, normalizeStripeEvent, seatDelta, type NormalizedEvent } from './fulfill.js'
import { makeStripe } from './stripe-client.js'

/** Longer than the function timeout below, so a stale claim can only come from an instance that died mid-event. */
const STALE_CLAIM_MS = 10 * 60 * 1000

export type Claim = 'claimed' | 'processed' | 'inflight'

/**
 * Creates stripeEvents/{id}. 'processed': already applied, answer 200. 'inflight': another delivery claimed it recently and
 * has not finished, so answer 500 and let Stripe retry (answering 200 would end the retries even if that delivery then dies).
 * A claim that never reached processedAt and is older than STALE_CLAIM_MS (timeout, crash, deploy) is taken over so the retry gets applied.
 */
async function claimEvent(event: Stripe.Event, nowMs: number): Promise<Claim> {
  const ref = db.collection('stripeEvents').doc(event.id)
  return db.runTransaction(async (tx) => {
    const existing = (await tx.get(ref)).data()
    if (existing?.processedAt) return 'processed'
    if (existing && nowMs - Number(existing.receivedAt ?? 0) < STALE_CLAIM_MS) return 'inflight'
    tx.set(ref, { type: event.type, receivedAt: nowMs })
    return 'claimed'
  })
}

/**
 * uid through the Stripe customer (the ownership boundary; the charge is retrieved for disputes and fraud warnings),
 * falling back to the metadata our own Checkout Sessions carry. Both are server-written; a disagreement is logged.
 */
async function resolveUid(event: NormalizedEvent, stripe: Stripe): Promise<string | undefined> {
  const fromMetadata = 'uid' in event && event.uid ? event.uid : undefined
  let customerId = event.customerId
  if (!customerId && 'chargeId' in event && event.chargeId) {
    const customer = (await stripe.charges.retrieve(event.chargeId)).customer
    customerId = typeof customer === 'string' ? customer : customer?.id
  }
  const fromCustomer = customerId ? ((await db.collection('customersByStripe').doc(customerId).get()).data()?.uid as string | undefined) : undefined
  if (fromMetadata && fromCustomer && fromMetadata !== fromCustomer) {
    logger.error('stripeWebhook: metadata uid and customer mapping disagree', { customerId, fromMetadata, fromCustomer })
  }
  return fromCustomer ?? fromMetadata
}

/** Applies one normalized event to entitlements/{uid} and keeps stats/pro.activeSeats right, in one transaction. */
export async function applyToUid(uid: string, event: NormalizedEvent, nowMs: number): Promise<void> {
  const ref = db.collection('entitlements').doc(uid)
  const statsRef = db.collection('stats').doc('pro')
  const applied = await db.runTransaction(async (tx) => {
    const [snap, stats] = await tx.getAll(ref, statsRef)
    const current = snap.exists ? (snap.data() as Entitlement) : EMPTY_ENTITLEMENT
    const next = applyStripeEvent(current, event, nowMs)
    if (next === current) return null
    if (event.kind === 'subscription' && holdsProSeat(current) && holdsProSeat(next) && current.pro?.subscriptionId !== next.pro?.subscriptionId) {
      // Two live subscriptions on one account (double checkout): the old one keeps billing until support refunds it.
      logger.error('stripeWebhook: live subscription replaced by another; refund the old one', { uid, previous: current.pro?.subscriptionId, next: next.pro?.subscriptionId })
    }
    tx.set(ref, next)
    const delta = seatDelta(current, next)
    if (delta) tx.set(statsRef, { activeSeats: Math.max(0, Number(stats.data()?.activeSeats ?? 0) + delta) }, { merge: true })
    return { current, next }
  })
  // After the transaction, so a contention retry cannot log twice.
  if (applied && (event.kind === 'refund' || event.kind === 'dispute' || event.kind === 'fraud_warning')) {
    const { current, next } = applied
    if (current.pro && current.pro.status !== 'revoked' && next.pro?.status === 'revoked') {
      // Stripe does not cancel a subscription on a refund or fraud warning (and on a dispute only if the Dashboard says so), and the
      // read-only webhook key cannot: a human confirms the subscription is canceled (it already is after a Cancel + refund from the
      // Dashboard) and refunds an undisputed flagged charge.
      logger.error('stripeWebhook: entitlement revoked; confirm the Stripe subscription is canceled (and refund an undisputed charge)', {
        uid, kind: event.kind, reason: next.reason, subscriptionId: current.pro.subscriptionId, paymentIntentId: event.paymentIntentId
      })
    } else if (current.byok && current.byok.status !== 'revoked' && next.byok?.status === 'revoked') {
      logger.warn('stripeWebhook: BYOK license revoked', { uid, kind: event.kind, reason: next.reason, paymentIntentId: event.paymentIntentId })
    }
  }
}

// 120 s covers the two Stripe calls a webhook may make (each up to 3 attempts x 10 s) with room to spare.
export const stripeWebhook = onRequest({ secrets: [STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_KEY], timeoutSeconds: 120 }, async (req, res) => {
  const stripe = makeStripe(STRIPE_WEBHOOK_KEY.value())
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'] ?? '', STRIPE_WEBHOOK_SECRET.value())
  } catch (err) {
    logger.warn('stripeWebhook: bad signature', { message: (err as Error).message })
    res.status(400).json({ error: 'bad signature' })
    return
  }
  if (event.livemode !== expectLivemode()) {
    logger.warn('stripeWebhook: livemode mismatch', { id: event.id, livemode: event.livemode })
    res.status(400).json({ error: 'livemode mismatch' })
    return
  }
  const claim = await claimEvent(event, Date.now())
  if (claim === 'processed') {
    res.status(200).json({ received: true, duplicate: true })
    return
  }
  if (claim === 'inflight') {
    // Not a failure: another delivery of this event is being processed right now. Stripe retries, finds it processed, and gets 200.
    logger.warn('stripeWebhook: event already in flight; asking Stripe to retry', { id: event.id, type: event.type })
    res.status(500).json({ error: 'event is being processed; retry' })
    return
  }

  const eventRef = db.collection('stripeEvents').doc(event.id)
  try {
    let outcome = 'ignored'
    if (event.type === 'checkout.session.async_payment_failed') {
      // Nothing was granted (the session completed unpaid); the buyer is told by Stripe and can start over.
      logger.warn('stripeWebhook: delayed payment failed', { id: event.id, session: event.data.object.id, uid: event.data.object.metadata?.uid })
    }
    if (event.type === 'invoice.finalization_failed') {
      // With Stripe Tax on, a renewal invoice that cannot be finalized (bad address, tax calculation error) is not collected.
      const invoice = event.data.object
      logger.error('stripeWebhook: invoice could not be finalized; the renewal is not being collected', {
        id: event.id, invoice: invoice.id, customer: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id, code: invoice.last_finalization_error?.code
      })
    }
    const normalized = await normalizeStripeEvent(event, (id) => stripe.subscriptions.retrieve(id))
    if (normalized) {
      const uid = await resolveUid(normalized, stripe)
      if (uid) {
        await applyToUid(uid, normalized, Date.now())
        outcome = 'applied'
      } else {
        logger.warn('stripeWebhook: no uid for event', { id: event.id, type: event.type })
        outcome = 'unknown_uid'
      }
    }
    await eventRef.update({ processedAt: Date.now(), outcome })
    res.status(200).json({ received: true, outcome })
  } catch (err) {
    logger.error('stripeWebhook: processing failed', { id: event.id, type: event.type, err })
    await eventRef.delete().catch(() => undefined) // let Stripe's retry go through
    res.status(500).json({ error: 'processing failed' })
  }
})
