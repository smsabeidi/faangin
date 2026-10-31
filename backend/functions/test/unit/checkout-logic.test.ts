import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkoutBlocked, customerIdempotencyKey, liveSubscriptionState, parseCheckoutFlags, hasLiveSubscription } from '../../src/billing/checkout-logic.js'
import { EMPTY_ENTITLEMENT, type Entitlement } from '../../src/entitlements.js'

describe('parseCheckoutFlags', () => {
  it('defaults: Pro checkout open, cap 200, tax and terms off', () => {
    assert.deepEqual(parseCheckoutFlags(undefined), { checkoutOpen: true, proSeatCap: 200, automaticTax: false, termsConsent: false })
    assert.deepEqual(parseCheckoutFlags({}), { checkoutOpen: true, proSeatCap: 200, automaticTax: false, termsConsent: false })
  })
  it('exact types are honoured', () => {
    assert.deepEqual(parseCheckoutFlags({ checkoutOpen: false, proSeatCap: 50, automaticTax: true, termsConsent: true }), { checkoutOpen: false, proSeatCap: 50, automaticTax: true, termsConsent: true })
  })
  it('console-typed strings land on the safe side: tax and terms stay off, "false" closes checkout, a numeric string is a number', () => {
    const flags = parseCheckoutFlags({ checkoutOpen: 'false', automaticTax: 'true', termsConsent: 'yes', proSeatCap: '75' })
    assert.deepEqual(flags, { checkoutOpen: false, proSeatCap: 75, automaticTax: false, termsConsent: false })
    assert.equal(parseCheckoutFlags({ checkoutOpen: 'true' }).checkoutOpen, false, 'a mistyped value closes Pro checkout rather than guessing')
    assert.equal(parseCheckoutFlags({ checkoutOpen: null }).checkoutOpen, false)
  })
  it('a seat cap that is not a number falls back to the default', () => {
    for (const bad of ['abc', '', '  ', null, NaN, Infinity, {}, []]) assert.equal(parseCheckoutFlags({ proSeatCap: bad }).proSeatCap, 200, String(bad))
    assert.equal(parseCheckoutFlags({ proSeatCap: 0 }).proSeatCap, 0, 'zero is a real cap: nobody may subscribe')
  })
})

describe('checkoutBlocked', () => {
  const flags = { checkoutOpen: true, proSeatCap: 2, automaticTax: false, termsConsent: false }
  const pro = (status: 'active' | 'past_due' | 'canceled'): Entitlement => ({ plan: 'pro', status, updatedAt: 1 })
  it('BYOK is never gated by the Pro flags, only by owning it', () => {
    assert.equal(checkoutBlocked('byok', EMPTY_ENTITLEMENT, { ...flags, checkoutOpen: false, proSeatCap: 0 }, 99), null)
    assert.equal(checkoutBlocked('byok', { plan: 'byok', status: 'active', updatedAt: 1 }, flags, 0), 'BYOK is already purchased')
    assert.equal(checkoutBlocked('byok', { plan: 'byok', status: 'revoked', updatedAt: 1 }, flags, 0), null)
  })
  it('Pro: closed flag, full seats, and an active or past_due subscription all block', () => {
    assert.equal(checkoutBlocked('pro_monthly', EMPTY_ENTITLEMENT, flags, 1), null)
    assert.equal(checkoutBlocked('pro_monthly', EMPTY_ENTITLEMENT, { ...flags, checkoutOpen: false }, 0), 'Pro checkout is closed right now')
    assert.equal(checkoutBlocked('pro_annual', EMPTY_ENTITLEMENT, flags, 2), 'Pro is full right now')
    assert.equal(checkoutBlocked('pro_monthly', pro('active'), flags, 0), 'Pro is already active')
    assert.equal(checkoutBlocked('pro_monthly', pro('past_due'), flags, 0), 'Pro is already active')
    assert.equal(checkoutBlocked('pro_monthly', pro('canceled'), flags, 0), null)
  })
})

describe('liveSubscriptionState', () => {
  const state = (...statuses: string[]) => liveSubscriptionState(statuses.map((status) => ({ status })))
  it('none live: a new checkout may start', () => {
    assert.equal(state(), null)
    assert.equal(state('canceled', 'incomplete_expired', 'incomplete'), null)
  })
  it('paying or retrying gives access', () => {
    for (const s of ['active', 'trialing', 'past_due']) assert.equal(state(s), 'access', s)
  })
  it('unpaid or paused only: on hold, no access but still blocks a second subscription', () => {
    assert.equal(state('unpaid'), 'on_hold')
    assert.equal(state('paused'), 'on_hold')
    assert.equal(state('unpaid', 'paused', 'canceled'), 'on_hold')
  })
  it('any paying subscription wins over an on-hold one', () => {
    assert.equal(state('unpaid', 'active'), 'access')
  })
  it('hasLiveSubscription is true for access and on hold', () => {
    assert.equal(hasLiveSubscription([{ status: 'unpaid' }]), true)
    assert.equal(hasLiveSubscription([{ status: 'canceled' }]), false)
  })
})

describe('customerIdempotencyKey', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 30)
  it('is stable within a minute, so concurrent first checkouts share one customer', () => {
    assert.equal(customerIdempotencyKey('u1', 'a@b.c', now), customerIdempotencyKey('u1', 'a@b.c', now + 29_000))
  })
  it('changes with the minute (a cached 5xx cannot lock a buyer out for 24 hours), the uid and the email', () => {
    const base = customerIdempotencyKey('u1', 'a@b.c', now)
    assert.notEqual(base, customerIdempotencyKey('u1', 'a@b.c', now + 60_000))
    assert.notEqual(base, customerIdempotencyKey('u2', 'a@b.c', now))
    assert.notEqual(base, customerIdempotencyKey('u1', undefined, now))
  })
  it('has a fixed shape and never contains the raw uid', () => {
    const key = customerIdempotencyKey('secretUid123', undefined, now)
    assert.match(key, /^faangin-customer-[0-9a-f]{40}$/)
    assert.equal(key.includes('secretUid123'), false)
  })
})
