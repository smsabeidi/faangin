// Pure decisions for Stripe fulfilment. No I/O: the webhook and reconcile feed events in and write the result out.
import type Stripe from 'npm:stripe@23.0.1'
import { PRICE_LOOKUP, RAMP_DAYS } from './config.ts'
import type { Entitlement, EntitlementStatus } from './entitlements.ts'

const RAMP_MS = RAMP_DAYS * 24 * 60 * 60 * 1000

/** What a Stripe event means to us, with ids flattened and times in Unix ms. */
export type NormalizedEvent =
  | { kind: 'byok_purchase'; uid?: string; customerId?: string; purchasedAt: number; paymentIntentId: string; checkoutSessionId: string; revokedReason?: 'refund' | 'dispute' }
  | {
      kind: 'subscription'; uid?: string; customerId?: string; subscriptionId: string; status: string; priceLookupKey: string
      currentPeriodStart: number; currentPeriodEnd: number; cancelAtPeriodEnd: boolean
    }
  | { kind: 'payment_failed'; customerId?: string; subscriptionId: string }
  | { kind: 'refund'; customerId?: string; chargeId: string; paymentIntentId?: string; subscriptionIds?: string[]; full: boolean }
  | { kind: 'dispute'; customerId?: string; chargeId: string; paymentIntentId?: string; subscriptionIds?: string[] }
  | { kind: 'fraud_warning'; customerId?: string; chargeId: string; paymentIntentId?: string; subscriptionIds?: string[] }

const SUBSCRIPTION_STATUS: Record<string, EntitlementStatus | undefined> = {
  active: 'active', trialing: 'active',
  past_due: 'past_due', // Stripe is still retrying the card: access continues
  unpaid: 'canceled', // every retry failed and the Dashboard kept the subscription: access ends until an invoice is paid
  canceled: 'canceled', incomplete_expired: 'canceled',
  paused: 'canceled' // no invoices are created while paused; a resume arrives as an active subscription event
  // incomplete (and anything new) → no change
}

const id = (value: string | { id: string } | null | undefined): string | undefined =>
  typeof value === 'string' ? value : value?.id

/** Subscription period: items.data[0].current_period_* (API 2025-03-31+), else the old top-level fields. Seconds → ms. */
type SubscriptionLike = Stripe.Subscription & { current_period_start?: number; current_period_end?: number }

export function normalizeSubscription(sub: Stripe.Subscription): Extract<NormalizedEvent, { kind: 'subscription' }> {
  const s = sub as SubscriptionLike
  const item = s.items?.data?.[0]
  const periodStart = item?.current_period_start ?? s.current_period_start ?? 0
  const periodEnd = item?.current_period_end ?? s.current_period_end ?? 0
  // The portal can set cancel_at without the legacy flag. A cancellation within this
  // period shortens its effective end; a later-period cancellation still renews this one.
  const cancelAt = s.cancel_at
  const cancelsThisPeriod = typeof cancelAt === 'number' && Number.isSafeInteger(cancelAt) && cancelAt > 0
    && Number.isSafeInteger(periodEnd) && periodEnd > 0 && cancelAt <= periodEnd
    && (cancelAt === periodEnd || (Number.isSafeInteger(periodStart) && periodStart > 0 && cancelAt > periodStart))
  return {
    kind: 'subscription',
    uid: s.metadata?.uid || undefined,
    customerId: id(s.customer),
    subscriptionId: s.id,
    status: s.status,
    priceLookupKey: item?.price?.lookup_key ?? '',
    currentPeriodStart: periodStart * 1000,
    currentPeriodEnd: (cancelsThisPeriod ? cancelAt : periodEnd) * 1000,
    cancelAtPeriodEnd: Boolean(s.cancel_at_period_end) || cancelsThisPeriod
  }
}

/** Maps a Stripe event to a NormalizedEvent, or null when it has no effect on entitlements. */
export async function normalizeStripeEvent(
  event: Stripe.Event,
  fetchSubscription?: (subscriptionId: string) => Promise<Stripe.Subscription>
): Promise<NormalizedEvent | null> {
  switch (event.type) {
    // A delayed payment method (bank debit) completes the session while it is still unpaid; the money arrives later
    // as async_payment_succeeded (or never: async_payment_failed, which the webhook only logs).
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object
      if (session.mode === 'payment') {
        if (!['paid', 'no_payment_required'].includes(session.payment_status) || session.metadata?.plan !== 'byok') return null
        if (session.payment_status === 'paid' && !id(session.payment_intent)) return null
        return {
          kind: 'byok_purchase',
          uid: session.metadata?.uid || session.client_reference_id || undefined,
          customerId: id(session.customer),
          purchasedAt: (session.created ?? 0) * 1000,
          paymentIntentId: id(session.payment_intent) ?? '',
          checkoutSessionId: session.id
        }
      }
      if (session.mode === 'subscription' && fetchSubscription) {
        const subscriptionId = id(session.subscription)
        if (!subscriptionId) return null
        const normalized = normalizeSubscription(await fetchSubscription(subscriptionId))
        return { ...normalized, uid: session.metadata?.uid || normalized.uid, customerId: id(session.customer) ?? normalized.customerId }
      }
      return null
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      // Delivery order is not guaranteed: a late 'active' update must not resurrect a subscription that has since been
      // canceled. Stripe's guidance is to read the current object, so the payload is only a fallback when it is gone.
      const payload = event.data.object
      if (!fetchSubscription) return normalizeSubscription(payload)
      try {
        return normalizeSubscription(await fetchSubscription(payload.id))
      } catch (err) {
        if ((err as { code?: string }).code === 'resource_missing') return normalizeSubscription(payload)
        throw err
      }
    }
    case 'invoice.paid': {
      // Stripe considers the subscription settled; re-read it so a missed or out-of-order subscription event is healed.
      const invoice = event.data.object
      const subscriptionId = id(invoice.parent?.subscription_details?.subscription)
      if (!subscriptionId || !fetchSubscription) return null
      return normalizeSubscription(await fetchSubscription(subscriptionId))
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      const subscriptionId = id(invoice.parent?.subscription_details?.subscription)
      return subscriptionId ? { kind: 'payment_failed', customerId: id(invoice.customer), subscriptionId } : null
    }
    case 'charge.refunded': {
      const charge = event.data.object
      return { kind: 'refund', customerId: id(charge.customer), chargeId: charge.id, paymentIntentId: id(charge.payment_intent), full: charge.refunded === true }
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object
      return { kind: 'dispute', chargeId: id(dispute.charge) ?? '', paymentIntentId: id(dispute.payment_intent) }
    }
    case 'radar.early_fraud_warning.created': {
      const warning = event.data.object
      return { kind: 'fraud_warning', chargeId: id(warning.charge) ?? '', paymentIntentId: id(warning.payment_intent) }
    }
    default:
      return null
  }
}

export const isProPrice = (lookupKey: string) => lookupKey === PRICE_LOOKUP.pro_monthly || lookupKey === PRICE_LOOKUP.pro_annual

const LIVE_PRO = new Set<EntitlementStatus>(['active', 'past_due'])

/**
 * Derives the top-level plan/status from the two products: Pro while its subscription is live, else BYOK while owned,
 * else whatever is left (canceled/revoked) so support can see why. The gateway and issueLicense read only these two fields.
 */
export function withEffectivePlan(products: Omit<Entitlement, 'plan' | 'status'>): Entitlement {
  const { byok, pro } = products
  if (pro && LIVE_PRO.has(pro.status)) return { ...products, plan: 'pro', status: pro.status }
  if (byok?.status === 'active') return { ...products, plan: 'byok', status: 'active' }
  if (pro) return { ...products, plan: 'pro', status: pro.status }
  if (byok) return { ...products, plan: 'byok', status: byok.status }
  return { ...products, plan: 'none', status: 'active' }
}

/**
 * Returns the entitlement after the event. Returns `current` itself (same reference) when nothing changes. Never mutates.
 * BYOK events only touch `byok` and subscription events only touch `pro`: buying one product never loses the other.
 */
export function applyStripeEvent(current: Entitlement, event: NormalizedEvent, nowMs: number): Entitlement {
  const base: Entitlement = { ...current, updatedAt: nowMs }
  if (event.customerId) base.stripeCustomerId = event.customerId
  delete base.reason

  const revoke = (reason: 'refund' | 'dispute' | 'fraud_warning', paymentIntentId?: string, subscriptionIds: string[] = []): Entitlement => {
    const revocations = { ...current.revocations }
    const keys = [...(paymentIntentId && reason !== 'fraud_warning' ? [`pi:${paymentIntentId}`] : []), ...subscriptionIds.map(value => `sub:${value}`)]
    let changed = false
    for (const key of keys) if (!revocations[key]) { revocations[key] = reason; changed = true }
    const byokMatch = reason !== 'fraud_warning' && paymentIntentId && current.byok?.paymentIntentId === paymentIntentId
    const proMatch = current.pro && subscriptionIds.includes(current.pro.subscriptionId)
    const byok = byokMatch && current.byok!.status !== 'revoked' ? { ...current.byok!, status: 'revoked' as const } : current.byok
    const pro = proMatch && current.pro!.status !== 'revoked' ? { ...current.pro!, status: 'revoked' as const } : current.pro
    if (!changed && byok === current.byok && pro === current.pro) return current
    // Persist early revocations in the same CAS document as the products. A concurrent
    // purchase retries against this tombstone rather than losing the earlier refund.
    return withEffectivePlan({ ...base, ...(byok ? { byok } : {}), ...(pro ? { pro } : {}), revocations,
      ...(byok !== current.byok || pro !== current.pro ? { reason } : current.reason ? { reason: current.reason } : {}) })
  }

  switch (event.kind) {
    case 'byok_purchase': {
      // A different event id may deliver this same Checkout Session after a refund/dispute. Never revive it,
      // or let an older purchase replace the current purchase's payment intent (used to route later refunds).
      if (current.byok && (current.byok.checkoutSessionId === event.checkoutSessionId || event.purchasedAt < current.byok.purchasedAt)) return current
      const reason = event.revokedReason ?? (event.paymentIntentId ? current.revocations?.[`pi:${event.paymentIntentId}`] : undefined)
      const revoked = reason === 'refund' || reason === 'dispute'
      return withEffectivePlan({
        ...base,
        ...(revoked ? { reason, revocations: { ...current.revocations, [`pi:${event.paymentIntentId}`]: reason } } : {}),
        byok: { status: revoked ? 'revoked' : 'active', purchasedAt: event.purchasedAt, paymentIntentId: event.paymentIntentId, checkoutSessionId: event.checkoutSessionId }
      })
    }
    case 'subscription': {
      const status = SUBSCRIPTION_STATUS[event.status]
      if (!status) return current
      const same = current.pro?.subscriptionId === event.subscriptionId ? current.pro : undefined
      // A customer can own other products in the same Stripe account.
      if (!isProPrice(event.priceLookupKey)) {
        return same && same.status !== 'revoked' ? withEffectivePlan({ ...base, pro: { ...same, status: 'canceled', priceLookupKey: event.priceLookupKey }, reason: 'unsupported_price' }) : current
      }
      // A revoked subscription (refund, dispute, fraud) stays revoked; only a new subscription starts over.
      if (same?.status === 'revoked') return current
      // A cancel for a subscription we do not hold (an older one, a never-completed checkout) changes nothing.
      if (!same && status === 'canceled') return current
      const startedAt = same?.startedAt ?? nowMs
      const revokedReason = current.revocations?.[`sub:${event.subscriptionId}`]
      // An older refunded subscription must not displace a later paid replacement.
      if (revokedReason && current.pro && !same) return current
      return withEffectivePlan({
        ...base,
        ...(revokedReason ? { reason: revokedReason } : {}),
        pro: {
          status: revokedReason ? 'revoked' : status,
          subscriptionId: event.subscriptionId,
          priceLookupKey: event.priceLookupKey,
          startedAt,
          currentPeriodStart: event.currentPeriodStart,
          currentPeriodEnd: event.currentPeriodEnd,
          cancelAtPeriodEnd: event.cancelAtPeriodEnd,
          rampUntil: same?.rampUntil ?? startedAt + RAMP_MS
        }
      })
    }
    case 'payment_failed':
      return current.pro?.status === 'active' && current.pro.subscriptionId === event.subscriptionId
        ? withEffectivePlan({ ...base, pro: { ...current.pro, status: 'past_due' } })
        : current
    case 'refund':
      return event.full ? revoke('refund', event.paymentIntentId, event.subscriptionIds) : current
    case 'dispute':
      return revoke('dispute', event.paymentIntentId, event.subscriptionIds)
    case 'fraud_warning':
      return revoke('fraud_warning', event.paymentIntentId, event.subscriptionIds)
  }
}

/** A uid holds a Pro seat while its subscription is active or past_due. */
export function holdsProSeat(entitlement: Entitlement): boolean {
  return entitlement.plan === 'pro' && (entitlement.status === 'active' || entitlement.status === 'past_due')
}

/** +1, -1 or 0 for stats/pro.activeSeats when `current` becomes `next`. */
export function seatDelta(current: Entitlement, next: Entitlement): number {
  return Number(holdsProSeat(next)) - Number(holdsProSeat(current))
}
