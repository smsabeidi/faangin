import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type Stripe from 'npm:stripe@23.0.1'
import { EMPTY_ENTITLEMENT, entitledPlan, type Entitlement } from '../entitlements.ts'
import { applyStripeEvent, normalizeStripeEvent, normalizeSubscription, seatDelta, type NormalizedEvent } from '../fulfill.ts'
import { fakeEvent, fakeSubscription } from './stripe-fixtures.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const LATER = NOW + 3 * DAY

const subscriptionEvent = (overrides: Partial<Extract<NormalizedEvent, { kind: 'subscription' }>> = {}): NormalizedEvent => ({
  kind: 'subscription', uid: 'u1', customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active', priceLookupKey: 'faangin_pro_monthly',
  currentPeriodStart: NOW, currentPeriodEnd: NOW + 30 * DAY, cancelAtPeriodEnd: false, ...overrides
})
const byokPurchase: NormalizedEvent = { kind: 'byok_purchase', uid: 'u1', customerId: 'cus_1', purchasedAt: NOW, paymentIntentId: 'pi_byok', checkoutSessionId: 'cs_1' }

const byokActive: Entitlement = applyStripeEvent(EMPTY_ENTITLEMENT, byokPurchase, NOW)
const proActive: Entitlement = applyStripeEvent(EMPTY_ENTITLEMENT, subscriptionEvent(), NOW)

const withoutUpdatedAt = ({ updatedAt: _, ...rest }: Entitlement) => rest
const frozen = <T extends object>(value: T): T => Object.freeze(structuredClone(value))

describe('applyStripeEvent: contract event table', () => {
  it('checkout.session.completed byok paid → byok active with purchase details', () => {
    assert.deepEqual(byokActive, {
      plan: 'byok', status: 'active', stripeCustomerId: 'cus_1', updatedAt: NOW,
      byok: { status: 'active', purchasedAt: NOW, paymentIntentId: 'pi_byok', checkoutSessionId: 'cs_1' }
    })
  })

  it('subscription active → pro active with period, startedAt and ramp', () => {
    assert.deepEqual(proActive, {
      plan: 'pro', status: 'active', stripeCustomerId: 'cus_1', updatedAt: NOW,
      pro: {
        status: 'active', subscriptionId: 'sub_1', priceLookupKey: 'faangin_pro_monthly', startedAt: NOW,
        currentPeriodStart: NOW, currentPeriodEnd: NOW + 30 * DAY, cancelAtPeriodEnd: false, rampUntil: NOW + 14 * DAY
      }
    })
  })

  for (const [stripeStatus, expected] of [['trialing', 'active'], ['past_due', 'past_due'], ['unpaid', 'canceled'], ['canceled', 'canceled'], ['incomplete_expired', 'canceled'], ['paused', 'canceled']] as const) {
    it(`subscription ${stripeStatus} → ${expected}`, () => {
      const next = applyStripeEvent(proActive, subscriptionEvent({ status: stripeStatus }), LATER)
      assert.equal(next.plan, 'pro')
      assert.equal(next.status, expected)
    })
  }

  it('subscription incomplete (and unknown statuses) are ignored', () => {
    assert.equal(applyStripeEvent(EMPTY_ENTITLEMENT, subscriptionEvent({ status: 'incomplete' }), NOW), EMPTY_ENTITLEMENT)
    assert.equal(applyStripeEvent(proActive, subscriptionEvent({ status: 'something_new' }), LATER), proActive)
  })

  it('invoice.payment_failed → past_due for the active pro subscription only', () => {
    const failed: NormalizedEvent = { kind: 'payment_failed', customerId: 'cus_1', subscriptionId: 'sub_1' }
    assert.equal(applyStripeEvent(proActive, failed, LATER).status, 'past_due')
    assert.equal(applyStripeEvent(byokActive, failed, LATER), byokActive)
    assert.equal(applyStripeEvent(proActive, { ...failed, subscriptionId: 'sub_other' }, LATER), proActive)
  })

  it('charge.refunded full → revoked (refund) for the plan the charge paid', () => {
    const byokRefund: NormalizedEvent = { kind: 'refund', customerId: 'cus_1', chargeId: 'ch_1', paymentIntentId: 'pi_byok', full: true }
    const proRefund: NormalizedEvent = { kind: 'refund', customerId: 'cus_1', chargeId: 'ch_2', paymentIntentId: 'pi_invoice', subscriptionIds: ['sub_1'], full: true }
    const revokedByok = applyStripeEvent(byokActive, byokRefund, LATER)
    assert.equal(revokedByok.status, 'revoked')
    assert.equal(revokedByok.reason, 'refund')
    assert.equal(revokedByok.plan, 'byok')
    const unrelatedRefund = applyStripeEvent(byokActive, proRefund, LATER)
    assert.deepEqual(unrelatedRefund.byok, byokActive.byok, 'a non-byok charge does not touch a byok entitlement')
    assert.equal(entitledPlan(unrelatedRefund), 'byok')
    const revokedPro = applyStripeEvent(proActive, proRefund, LATER)
    assert.equal(revokedPro.status, 'revoked')
    assert.equal(revokedPro.reason, 'refund')
    assert.equal(revokedPro.plan, 'pro')
  })

  it('partial refund (refunded: false) is ignored', () => {
    assert.equal(applyStripeEvent(byokActive, { kind: 'refund', chargeId: 'ch_1', paymentIntentId: 'pi_byok', full: false }, LATER), byokActive)
  })

  it('charge.dispute.created → revoked (dispute)', () => {
    const next = applyStripeEvent(proActive, { kind: 'dispute', chargeId: 'ch_2', paymentIntentId: 'pi_invoice', subscriptionIds: ['sub_1'] }, LATER)
    assert.equal(next.status, 'revoked')
    assert.equal(next.reason, 'dispute')
    const byok = applyStripeEvent(byokActive, { kind: 'dispute', chargeId: 'ch_1', paymentIntentId: 'pi_byok' }, LATER)
    assert.equal(byok.status, 'revoked')
    assert.equal(applyStripeEvent(EMPTY_ENTITLEMENT, { kind: 'dispute', chargeId: 'ch_9' }, LATER), EMPTY_ENTITLEMENT)
  })

  it('radar.early_fraud_warning.created → revoked (fraud_warning) for Pro only', () => {
    const next = applyStripeEvent(proActive, { kind: 'fraud_warning', chargeId: 'ch_2', paymentIntentId: 'pi_invoice', subscriptionIds: ['sub_1'] }, LATER)
    assert.equal(next.status, 'revoked')
    assert.equal(next.reason, 'fraud_warning')
    assert.equal(applyStripeEvent(byokActive, { kind: 'fraud_warning', chargeId: 'ch_1', paymentIntentId: 'pi_byok' }, LATER), byokActive)
  })
})

describe('applyStripeEvent: invariants', () => {
  it('a late BYOK checkout cannot revive a refunded purchase or replace a newer purchase', () => {
    const revoked = applyStripeEvent(byokActive, { kind: 'refund', chargeId: 'ch', paymentIntentId: 'pi_byok', full: true }, LATER)
    assert.equal(applyStripeEvent(revoked, byokPurchase, LATER + DAY), revoked)
    const newer = applyStripeEvent(revoked, { ...byokPurchase, purchasedAt: LATER, paymentIntentId: 'pi_new', checkoutSessionId: 'cs_new' } as NormalizedEvent, LATER)
    assert.equal(newer.byok?.status, 'active')
    assert.equal(applyStripeEvent(newer, byokPurchase, LATER + DAY), newer)
  })

  it('never mutates its input', () => {
    const current = frozen(proActive)
    assert.doesNotThrow(() => applyStripeEvent(current, subscriptionEvent({ status: 'canceled' }), LATER))
    assert.doesNotThrow(() => applyStripeEvent(current, { kind: 'dispute', chargeId: 'ch', paymentIntentId: 'pi', subscriptionIds: ['sub_1'] }, LATER))
    assert.deepEqual(current, proActive)
  })

  it('revoking something already revoked changes nothing: same entitlement, first reason kept, no repeat', () => {
    const refundedPro = applyStripeEvent(proActive, { kind: 'refund', chargeId: 'c1', paymentIntentId: 'pi_x', subscriptionIds: ['sub_1'], full: true }, LATER)
    assert.equal(refundedPro.pro?.status, 'revoked')
    assert.equal(applyStripeEvent(refundedPro, { kind: 'dispute', chargeId: 'c1', paymentIntentId: 'pi_x', subscriptionIds: ['sub_1'] }, LATER + DAY), refundedPro, 'dispute after refund')
    assert.equal(applyStripeEvent(refundedPro, { kind: 'fraud_warning', chargeId: 'c1', paymentIntentId: 'pi_x', subscriptionIds: ['sub_1'] }, LATER + DAY), refundedPro, 'fraud warning after refund')
    const refundedByok = applyStripeEvent(byokActive, { kind: 'refund', chargeId: 'c2', paymentIntentId: 'pi_byok', full: true }, LATER)
    assert.equal(refundedByok.byok?.status, 'revoked')
    assert.equal(applyStripeEvent(refundedByok, { kind: 'dispute', chargeId: 'c2', paymentIntentId: 'pi_byok' }, LATER + DAY), refundedByok)
  })

  it('repeating an event is idempotent in effect', () => {
    const once = applyStripeEvent(proActive, subscriptionEvent(), LATER)
    const twice = applyStripeEvent(once, subscriptionEvent(), LATER + DAY)
    assert.deepEqual(withoutUpdatedAt(twice), withoutUpdatedAt(once))
    const revokedOnce = applyStripeEvent(proActive, { kind: 'dispute', chargeId: 'ch', paymentIntentId: 'pi', subscriptionIds: ['sub_1'] }, LATER)
    const revokedTwice = applyStripeEvent(revokedOnce, { kind: 'dispute', chargeId: 'ch', paymentIntentId: 'pi', subscriptionIds: ['sub_1'] }, LATER + DAY)
    assert.deepEqual(withoutUpdatedAt(revokedTwice), withoutUpdatedAt(revokedOnce))
  })

  it('ramp is startedAt + 14 d on first sighting and preserved afterwards', () => {
    assert.equal(proActive.pro?.startedAt, NOW)
    assert.equal(proActive.pro?.rampUntil, NOW + 14 * DAY)
    const renewed = applyStripeEvent(proActive, subscriptionEvent({ currentPeriodStart: NOW + 30 * DAY, currentPeriodEnd: NOW + 60 * DAY }), NOW + 30 * DAY)
    assert.equal(renewed.pro?.startedAt, NOW)
    assert.equal(renewed.pro?.rampUntil, NOW + 14 * DAY)
    assert.equal(renewed.pro?.currentPeriodStart, NOW + 30 * DAY)
    const replaced = applyStripeEvent(renewed, subscriptionEvent({ subscriptionId: 'sub_2' }), LATER)
    assert.equal(replaced.pro?.startedAt, LATER, 'a new subscription starts its own ramp')
    assert.equal(replaced.pro?.rampUntil, LATER + 14 * DAY)
  })

  it('cancelAtPeriodEnd is copied', () => {
    assert.equal(applyStripeEvent(proActive, subscriptionEvent({ cancelAtPeriodEnd: true }), LATER).pro?.cancelAtPeriodEnd, true)
    assert.equal(proActive.pro?.cancelAtPeriodEnd, false)
  })

  it('a revoked subscription stays revoked until a new subscription replaces it', () => {
    const revoked = applyStripeEvent(proActive, { kind: 'dispute', chargeId: 'ch', paymentIntentId: 'pi', subscriptionIds: ['sub_1'] }, LATER)
    assert.equal(applyStripeEvent(revoked, subscriptionEvent(), LATER + DAY), revoked)
    assert.equal(applyStripeEvent(revoked, subscriptionEvent({ subscriptionId: 'sub_2' }), LATER + DAY).status, 'active')
  })

  it('a revoke clears nothing else and a later state change drops the reason', () => {
    const revoked = applyStripeEvent(byokActive, { kind: 'refund', chargeId: 'ch', paymentIntentId: 'pi_byok', full: true }, LATER)
    assert.deepEqual(revoked.byok, { ...byokActive.byok, status: 'revoked' })
    const rebought = applyStripeEvent(revoked, { ...byokPurchase, paymentIntentId: 'pi_byok_2', checkoutSessionId: 'cs_2' } as NormalizedEvent, LATER + DAY)
    assert.equal(rebought.status, 'active')
    assert.equal('reason' in rebought, false)
  })

  it('seatDelta counts moves into and out of pro active/past_due', () => {
    assert.equal(seatDelta(EMPTY_ENTITLEMENT, proActive), 1)
    assert.equal(seatDelta(proActive, applyStripeEvent(proActive, subscriptionEvent({ status: 'past_due' }), LATER)), 0)
    assert.equal(seatDelta(proActive, applyStripeEvent(proActive, subscriptionEvent({ status: 'canceled' }), LATER)), -1)
    assert.equal(seatDelta(proActive, applyStripeEvent(proActive, { kind: 'dispute', chargeId: 'ch', paymentIntentId: 'pi', subscriptionIds: ['sub_1'] }, LATER)), -1)
    assert.equal(seatDelta(EMPTY_ENTITLEMENT, byokActive), 0)
  })
})

describe('applyStripeEvent: BYOK and Pro are independent', () => {
  const canceled = subscriptionEvent({ status: 'canceled' })

  it('A: a BYOK owner who tries Pro and cancels keeps BYOK', () => {
    const trial = applyStripeEvent(byokActive, subscriptionEvent(), LATER)
    assert.equal(entitledPlan(trial), 'pro')
    assert.deepEqual(trial.byok, byokActive.byok)
    const ended = applyStripeEvent(trial, canceled, LATER + DAY)
    assert.equal(entitledPlan(ended), 'byok')
    assert.deepEqual([ended.plan, ended.status, ended.pro?.status], ['byok', 'active', 'canceled'])
    assert.equal(seatDelta(trial, ended), -1)
  })

  it('B: a Pro subscriber who buys BYOK stays Pro, keeps the seat and the ramp', () => {
    const both = applyStripeEvent(proActive, byokPurchase, LATER)
    assert.equal(entitledPlan(both), 'pro')
    assert.equal(seatDelta(proActive, both), 0)
    assert.deepEqual(both.pro, proActive.pro)
    assert.equal(both.byok?.status, 'active')
    const renewed = applyStripeEvent(both, subscriptionEvent({ currentPeriodStart: NOW + 30 * DAY, currentPeriodEnd: NOW + 60 * DAY }), NOW + 30 * DAY)
    assert.equal(renewed.pro?.startedAt, NOW, 'renewal is the same subscription: no new ramp')
    assert.equal(renewed.pro?.rampUntil, NOW + 14 * DAY)
    assert.equal(renewed.byok?.status, 'active')
    assert.equal(entitledPlan(applyStripeEvent(renewed, canceled, NOW + 60 * DAY)), 'byok', 'BYOK carries on after Pro ends')
  })

  it('C: a dispute on the BYOK charge revokes BYOK only, even while Pro is in force', () => {
    const both = applyStripeEvent(proActive, byokPurchase, LATER)
    const disputed = applyStripeEvent(both, { kind: 'dispute', chargeId: 'ch_1', paymentIntentId: 'pi_byok' }, LATER + DAY)
    assert.deepEqual([disputed.byok?.status, disputed.pro?.status, disputed.reason], ['revoked', 'active', 'dispute'])
    assert.equal(entitledPlan(disputed), 'pro')
    assert.equal(entitledPlan(applyStripeEvent(disputed, canceled, LATER + 2 * DAY)), 'none', 'revoked BYOK does not come back when Pro ends')
    const proDisputed = applyStripeEvent(both, { kind: 'dispute', chargeId: 'ch_2', paymentIntentId: 'pi_invoice', subscriptionIds: ['sub_1'] }, LATER + DAY)
    assert.deepEqual([proDisputed.pro?.status, proDisputed.byok?.status], ['revoked', 'active'])
    assert.equal(entitledPlan(proDisputed), 'byok')
  })

  it('a cancel for a subscription we do not hold is ignored; the one we hold still cancels', () => {
    const onSub2 = applyStripeEvent(proActive, subscriptionEvent({ subscriptionId: 'sub_2' }), LATER)
    assert.equal(onSub2.pro?.subscriptionId, 'sub_2')
    assert.equal(applyStripeEvent(onSub2, subscriptionEvent({ subscriptionId: 'sub_1', status: 'canceled' }), LATER + DAY), onSub2)
    assert.equal(applyStripeEvent(onSub2, subscriptionEvent({ subscriptionId: 'sub_3', status: 'incomplete_expired' }), LATER + DAY), onSub2)
    assert.equal(applyStripeEvent(EMPTY_ENTITLEMENT, canceled, NOW), EMPTY_ENTITLEMENT)
    assert.equal(applyStripeEvent(onSub2, subscriptionEvent({ subscriptionId: 'sub_2', status: 'canceled' }), LATER + DAY).status, 'canceled')
  })

  it('with nothing live the doc still says why, for support', () => {
    const revokedByok = applyStripeEvent(byokActive, { kind: 'refund', chargeId: 'ch_1', paymentIntentId: 'pi_byok', full: true }, LATER)
    assert.deepEqual([revokedByok.plan, revokedByok.status, revokedByok.reason], ['byok', 'revoked', 'refund'])
    const canceledPro = applyStripeEvent(proActive, canceled, LATER)
    assert.deepEqual([canceledPro.plan, canceledPro.status], ['pro', 'canceled'])
  })
})

describe('applyStripeEvent: payment identity and delivery ordering', () => {
  for (const kind of ['refund', 'dispute'] as const) {
    it(`an early BYOK ${kind} survives a delayed checkout and a CAS retry`, () => {
      const event = { kind, chargeId: 'ch_byok', paymentIntentId: 'pi_byok', ...(kind === 'refund' ? { full: true } : {}) } as NormalizedEvent
      const early = applyStripeEvent(EMPTY_ENTITLEMENT, event, NOW)
      assert.equal(early.revocations?.['pi:pi_byok'], kind)
      assert.equal(entitledPlan(early), 'none')
      // A purchase computed before the revocation retries against the committed document.
      const delayed = applyStripeEvent(early, byokPurchase, LATER)
      assert.equal(delayed.byok?.status, 'revoked')
      assert.equal(entitledPlan(delayed), 'none')
      assert.equal(applyStripeEvent(delayed, byokPurchase, LATER + DAY), delayed)
      const repurchased = applyStripeEvent(delayed, { ...byokPurchase, purchasedAt: LATER, paymentIntentId: 'pi_new', checkoutSessionId: 'cs_new' } as NormalizedEvent, LATER)
      assert.equal(entitledPlan(repurchased), 'byok', 'a different paid purchase remains usable')
      assert.equal(repurchased.revocations?.['pi:pi_byok'], kind)
    })
  }

  for (const kind of ['refund', 'dispute', 'fraud_warning'] as const) {
    it(`an early Pro ${kind} survives active delivery and reconciliation`, () => {
      const event = { kind, chargeId: 'ch_pro', paymentIntentId: 'pi_pro', subscriptionIds: ['sub_1'], ...(kind === 'refund' ? { full: true } : {}) } as NormalizedEvent
      const early = applyStripeEvent(EMPTY_ENTITLEMENT, event, NOW)
      assert.equal(early.revocations?.['sub:sub_1'], kind)
      const delivered = applyStripeEvent(early, subscriptionEvent(), LATER)
      assert.equal(delivered.pro?.status, 'revoked')
      assert.equal(entitledPlan(delivered), 'none')
      const reconciled = applyStripeEvent(delivered, normalizeSubscription(fakeSubscription({ id: 'sub_1', status: 'active' }) as unknown as Stripe.Subscription), LATER + DAY)
      assert.equal(reconciled, delivered, 'current Stripe active status cannot restore revoked access')
      const replaced = applyStripeEvent(reconciled, subscriptionEvent({ subscriptionId: 'sub_2' }), LATER + DAY)
      assert.equal(entitledPlan(replaced), 'pro')
      assert.equal(replaced.pro?.subscriptionId, 'sub_2')
      const staleOld = applyStripeEvent(replaced, subscriptionEvent(), LATER + 2 * DAY)
      assert.deepEqual(staleOld.pro, replaced.pro, 'an old revoked subscription cannot replace the newer paid subscription')
      assert.equal(entitledPlan(staleOld), 'pro')
    })
  }

  it('foreign or missing price lookups cannot grant Pro or replace its subscription', () => {
    for (const priceLookupKey of ['other_product', '', 'faangin_byok_v1']) {
      assert.equal(applyStripeEvent(EMPTY_ENTITLEMENT, subscriptionEvent({ priceLookupKey }), NOW), EMPTY_ENTITLEMENT)
      assert.equal(applyStripeEvent(proActive, subscriptionEvent({ subscriptionId: 'sub_foreign', priceLookupKey }), LATER), proActive)
    }
    const annual = applyStripeEvent(EMPTY_ENTITLEMENT, subscriptionEvent({ priceLookupKey: 'faangin_pro_annual' }), NOW)
    assert.equal(entitledPlan(annual), 'pro')
    const moved = applyStripeEvent(proActive, subscriptionEvent({ priceLookupKey: 'other_product' }), LATER)
    assert.equal(moved.pro?.status, 'canceled', 'moving the held subscription off a Faangin price removes Pro access')
    assert.equal(entitledPlan(moved), 'none')
    const both = applyStripeEvent(proActive, byokPurchase, NOW)
    assert.equal(entitledPlan(applyStripeEvent(both, subscriptionEvent({ priceLookupKey: 'other_product' }), LATER)), 'byok')
  })

  it('old BYOK, old Pro and unbound charges cannot revoke current Pro', () => {
    const oldByok = applyStripeEvent(proActive, byokPurchase, NOW)
    const both = applyStripeEvent(oldByok, { ...byokPurchase, purchasedAt: LATER, paymentIntentId: 'pi_byok_new', checkoutSessionId: 'cs_byok_new' } as NormalizedEvent, LATER)
    const events: NormalizedEvent[] = [
      { kind: 'refund', chargeId: 'ch_old_byok', paymentIntentId: 'pi_byok', full: true },
      { kind: 'dispute', chargeId: 'ch_old_pro', paymentIntentId: 'pi_old_pro', subscriptionIds: ['sub_old'] },
      { kind: 'refund', chargeId: 'ch_unbound', paymentIntentId: 'pi_unbound', full: true }
    ]
    for (const event of events) {
      const next = applyStripeEvent(both, event, LATER + DAY)
      assert.deepEqual(next.pro, both.pro)
      assert.deepEqual(next.byok, both.byok)
      assert.equal(entitledPlan(next), 'pro')
      assert.equal(seatDelta(both, next), 0)
    }
  })

  it('a completion that already observes a full refund or dispute is never active', () => {
    for (const revokedReason of ['refund', 'dispute'] as const) {
      const next = applyStripeEvent(EMPTY_ENTITLEMENT, { ...byokPurchase, revokedReason } as NormalizedEvent, NOW)
      assert.equal(next.byok?.status, 'revoked')
      assert.equal(next.revocations?.['pi:pi_byok'], revokedReason)
      assert.equal(entitledPlan(next), 'none')
    }
  })
})

describe('normalizeSubscription: period shapes', () => {
  const start = 1_800_000_000
  const end = start + 30 * 86400

  it('reads items.data[0].current_period_* (API 2025-03-31+) in ms', () => {
    const normalized = normalizeSubscription(fakeSubscription({ id: 'sub_a', uid: 'u1', periodStart: start, periodEnd: end, cancelAtPeriodEnd: true }) as unknown as Stripe.Subscription)
    assert.deepEqual(normalized, {
      kind: 'subscription', uid: 'u1', customerId: 'cus_fake', subscriptionId: 'sub_a', status: 'active', priceLookupKey: 'faangin_pro_monthly',
      currentPeriodStart: start * 1000, currentPeriodEnd: end * 1000, cancelAtPeriodEnd: true
    })
  })

  it('falls back to top-level current_period_* (older API)', () => {
    const normalized = normalizeSubscription(fakeSubscription({ periodStart: start, periodEnd: end, topLevelPeriod: true }) as unknown as Stripe.Subscription)
    assert.equal(normalized.currentPeriodStart, start * 1000)
    assert.equal(normalized.currentPeriodEnd, end * 1000)
    assert.equal(normalized.uid, undefined)
  })

  it('recognizes portal cancel_at at the current item period end with the legacy flag false', () => {
    const normalized = normalizeSubscription(fakeSubscription({ id: 'sub_1', periodStart: start, periodEnd: end, cancelAtPeriodEnd: false, cancelAt: end }) as unknown as Stripe.Subscription)
    assert.equal(normalized.cancelAtPeriodEnd, true)
    assert.equal(normalized.currentPeriodEnd, end * 1000)
    const next = applyStripeEvent(proActive, normalized, LATER)
    assert.equal(next.pro?.cancelAtPeriodEnd, true)
    assert.equal(entitledPlan(next), 'pro', 'scheduling cancellation must preserve paid access')
    assert.equal(seatDelta(proActive, next), 0)
  })

  it('recognizes explicit cancellation against the legacy top-level period', () => {
    const normalized = normalizeSubscription(fakeSubscription({ periodStart: start, periodEnd: end, topLevelPeriod: true, cancelAt: end }) as unknown as Stripe.Subscription)
    assert.equal(normalized.cancelAtPeriodEnd, true)
    assert.equal(normalized.currentPeriodEnd, end * 1000)
  })

  it('shortens the displayed effective end for a valid earlier cancellation in this period', () => {
    const cancelAt = start + 10 * 86400
    for (const topLevelPeriod of [false, true]) {
      const normalized = normalizeSubscription(fakeSubscription({ periodStart: start, periodEnd: end, topLevelPeriod, cancelAt }) as unknown as Stripe.Subscription)
      assert.equal(normalized.cancelAtPeriodEnd, true)
      assert.equal(normalized.currentPeriodStart, start * 1000)
      assert.equal(normalized.currentPeriodEnd, cancelAt * 1000)
      assert.equal(normalized.status, 'active')
    }
  })

  it('ignores absent, invalid and later-period cancel_at timestamps', () => {
    for (const cancelAt of [undefined, null, 0, -1, start - 1, start, end + 1, end + 30 * 86400, NaN, Infinity, -Infinity, end - 0.5, String(end)]) {
      const snapshot = { ...fakeSubscription({ periodStart: start, periodEnd: end }), cancel_at: cancelAt }
      const normalized = normalizeSubscription(snapshot as unknown as Stripe.Subscription)
      assert.equal(normalized.cancelAtPeriodEnd, false, String(cancelAt))
      assert.equal(normalized.currentPeriodEnd, end * 1000, String(cancelAt))
    }
  })

  it('uses the item period instead of a conflicting legacy end and requires a valid end', () => {
    const snapshot = { ...fakeSubscription({ periodStart: start, periodEnd: end, cancelAt: end + 86400 }), current_period_end: end + 86400 }
    assert.equal(normalizeSubscription(snapshot as unknown as Stripe.Subscription).cancelAtPeriodEnd, false)
    for (const cancelAt of [0, end]) {
      assert.equal(normalizeSubscription(fakeSubscription({ periodStart: start, periodEnd: 0, cancelAt }) as unknown as Stripe.Subscription).cancelAtPeriodEnd, false)
    }
  })

  it('preserves an existing true legacy cancellation flag', () => {
    for (const cancelAt of [null, NaN, end + 30 * 86400]) {
      const normalized = normalizeSubscription(fakeSubscription({ periodStart: start, periodEnd: end, cancelAtPeriodEnd: true, cancelAt }) as unknown as Stripe.Subscription)
      assert.equal(normalized.cancelAtPeriodEnd, true)
      assert.equal(normalized.currentPeriodEnd, end * 1000)
    }
  })
})

describe('normalizeStripeEvent', () => {
  const session = (overrides: Record<string, unknown>) => ({
    id: 'cs_1', object: 'checkout.session', created: NOW / 1000, customer: 'cus_1', client_reference_id: 'u1',
    mode: 'payment', payment_status: 'paid', payment_intent: 'pi_byok', subscription: null, metadata: { uid: 'u1', plan: 'byok' }, ...overrides
  })
  const asEvent = (type: string, object: Record<string, unknown>) => fakeEvent(type, object) as unknown as Stripe.Event

  it('byok checkout paid → byok_purchase; unpaid or other plans → null', async () => {
    assert.deepEqual(await normalizeStripeEvent(asEvent('checkout.session.completed', session({}))), {
      kind: 'byok_purchase', uid: 'u1', customerId: 'cus_1', purchasedAt: NOW, paymentIntentId: 'pi_byok', checkoutSessionId: 'cs_1'
    })
    assert.equal(await normalizeStripeEvent(asEvent('checkout.session.completed', session({ payment_status: 'unpaid' }))), null)
    assert.equal(await normalizeStripeEvent(asEvent('checkout.session.completed', session({ metadata: { uid: 'u1', plan: 'other' } }))), null)
  })

  it('a delayed byok payment: completed-but-unpaid grants nothing, async_payment_succeeded does; no_payment_required counts as paid', async () => {
    assert.equal((await normalizeStripeEvent(asEvent('checkout.session.async_payment_succeeded', session({ payment_status: 'paid' }))))?.kind, 'byok_purchase')
    assert.equal(await normalizeStripeEvent(asEvent('checkout.session.completed', session({ payment_status: 'unpaid' }))), null)
    assert.equal(await normalizeStripeEvent(asEvent('checkout.session.async_payment_failed', session({ payment_status: 'unpaid' }))), null)
    assert.equal((await normalizeStripeEvent(asEvent('checkout.session.completed', session({ payment_status: 'no_payment_required', payment_intent: null }))))?.kind, 'byok_purchase')
    assert.equal(await normalizeStripeEvent(asEvent('checkout.session.completed', session({ payment_status: 'paid', payment_intent: null }))), null, 'a paid session must identify its payment')
  })

  it('subscription events are applied from Stripe\'s current copy, not the (possibly stale) payload', async () => {
    const stalePayload = fakeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'active' })
    const current = async (id: string) => fakeSubscription({ id, customer: 'cus_1', status: 'canceled' }) as unknown as Stripe.Subscription
    for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed']) {
      const normalized = await normalizeStripeEvent(asEvent(type, stalePayload), current)
      assert.equal(normalized?.kind === 'subscription' ? normalized.status : 'n/a', 'canceled', type)
    }
    // payload used when Stripe no longer has the object; any other failure propagates so Stripe retries the delivery
    const gone = async () => { throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' }) }
    assert.equal((await normalizeStripeEvent(asEvent('customer.subscription.updated', stalePayload), gone))?.kind, 'subscription')
    const down = async () => { throw new Error('network down') }
    await assert.rejects(normalizeStripeEvent(asEvent('customer.subscription.updated', stalePayload), down), /network down/)
  })

  it('invoice.paid re-reads the subscription; paused and resumed map like updated', async () => {
    const fetched: string[] = []
    const fetcher = async (id: string) => { fetched.push(id); return fakeSubscription({ id, customer: 'cus_1' }) as unknown as Stripe.Subscription }
    const invoice = { id: 'in_1', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } } }
    assert.equal((await normalizeStripeEvent(asEvent('invoice.paid', invoice), fetcher))?.kind, 'subscription')
    assert.deepEqual(fetched, ['sub_1'])
    assert.equal(await normalizeStripeEvent(asEvent('invoice.paid', { id: 'in_2', customer: 'cus_1', parent: null }), fetcher), null, 'a one-off invoice has no subscription')
    assert.equal(await normalizeStripeEvent(asEvent('invoice.paid', invoice)), null, 'without a fetcher there is nothing to apply')
    const paused = await normalizeStripeEvent(asEvent('customer.subscription.paused', fakeSubscription({ id: 'sub_1', status: 'paused' })))
    assert.ok(paused?.kind === 'subscription')
    assert.equal(paused.status, 'paused')
    assert.equal((await normalizeStripeEvent(asEvent('customer.subscription.resumed', fakeSubscription({ id: 'sub_1' }))))?.kind, 'subscription')
  })

  it('subscription checkout fetches the subscription and keeps the session uid', async () => {
    const fetched: string[] = []
    const normalized = await normalizeStripeEvent(
      asEvent('checkout.session.completed', session({ mode: 'subscription', subscription: 'sub_9', metadata: { uid: 'u1', plan: 'pro_monthly' } })),
      async (id) => { fetched.push(id); return fakeSubscription({ id, customer: 'cus_1' }) as unknown as Stripe.Subscription }
    )
    assert.deepEqual(fetched, ['sub_9'])
    assert.equal(normalized?.kind, 'subscription')
    assert.equal(normalized && 'uid' in normalized ? normalized.uid : undefined, 'u1')
    assert.equal(await normalizeStripeEvent(asEvent('checkout.session.completed', session({ mode: 'subscription', subscription: 'sub_9' }))), null, 'without a fetcher there is nothing to apply')
  })

  it('maps the remaining event types and ignores the rest', async () => {
    assert.equal((await normalizeStripeEvent(asEvent('customer.subscription.updated', fakeSubscription({ id: 'sub_1' }))))?.kind, 'subscription')
    assert.deepEqual(await normalizeStripeEvent(asEvent('invoice.payment_failed', { id: 'in_1', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } } })), { kind: 'payment_failed', customerId: 'cus_1', subscriptionId: 'sub_1' })
    assert.equal(await normalizeStripeEvent(asEvent('invoice.payment_failed', { id: 'in_2', customer: 'cus_1', parent: null })), null)
    assert.deepEqual(await normalizeStripeEvent(asEvent('charge.refunded', { id: 'ch_1', customer: 'cus_1', payment_intent: 'pi_byok', refunded: true })), { kind: 'refund', customerId: 'cus_1', chargeId: 'ch_1', paymentIntentId: 'pi_byok', full: true })
    assert.deepEqual(await normalizeStripeEvent(asEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_byok' })), { kind: 'dispute', chargeId: 'ch_1', paymentIntentId: 'pi_byok' })
    assert.deepEqual(await normalizeStripeEvent(asEvent('radar.early_fraud_warning.created', { id: 'issfr_1', charge: 'ch_1', payment_intent: 'pi_byok' })), { kind: 'fraud_warning', chargeId: 'ch_1', paymentIntentId: 'pi_byok' })
    assert.equal(await normalizeStripeEvent(asEvent('customer.created', { id: 'cus_1' })), null)
  })
})
