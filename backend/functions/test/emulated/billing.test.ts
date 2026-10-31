// Runs under `npm run test:emulated` (auth, firestore, functions emulators + STRIPE_API_BASE=http://127.0.0.1:4242).
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import * as fake from '../fake-stripe.js'
import { call, db, http, signInTestUser, signInVerifiedTestUser } from './harness.js'

const DAY = 24 * 60 * 60 * 1000

before(() => fake.start(4242))
after(() => fake.stop())
beforeEach(() => fake.reset())

const openFlags = () => db.collection('flags').doc('global').set({ checkoutOpen: true, proSeatCap: 200 }, { merge: true })
const entitlement = async (uid: string) => (await db.collection('entitlements').doc(uid).get()).data()
const activeSeats = async () => Number((await db.collection('stats').doc('pro').get()).data()?.activeSeats ?? 0)
const mapCustomer = (customerId: string, uid: string) => db.collection('customersByStripe').doc(customerId).set({ uid })

async function postWebhook(event: Record<string, unknown>, signature?: string): Promise<Response> {
  const payload = JSON.stringify(event)
  return http('stripeWebhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature ?? fake.signWebhook(payload) },
    body: payload
  })
}

/** Subscription events are applied from Stripe's current copy of the subscription, so the fake serves what the event describes. */
const postSubscriptionEvent = (type: string, subscription: Record<string, unknown>) => {
  fake.subscriptions.set(String(subscription.id), subscription)
  return postWebhook(fake.fakeEvent(type, subscription))
}

const byokSession = (uid: string, customer: string, overrides: Record<string, unknown> = {}) => ({
  id: `cs_test_byok_${uid}`, object: 'checkout.session', created: Math.floor(Date.now() / 1000), mode: 'payment', payment_status: 'paid',
  customer, client_reference_id: uid, payment_intent: `pi_byok_${uid}`, subscription: null, metadata: { uid, plan: 'byok' }, ...overrides
})

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (err: Error & { code?: string }) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`)
    return true
  })
}

describe('createCheckoutSession', () => {
  it('byok: returns the fake checkout url and sends the right session', async () => {
    const user = await signInTestUser()
    const { url } = await call<{ url: string }>('createCheckoutSession', { plan: 'byok' }, user.idToken)
    assert.match(url, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_/)

    const prices = fake.requests.find((r) => r.path === '/v1/prices')
    assert.ok(prices, 'price looked up')
    assert.deepEqual([...prices.query].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v), ['faangin_byok_v1'])

    const session = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')
    assert.ok(session, 'session created')
    assert.equal(session.body.mode, 'payment')
    assert.equal(session.body.client_reference_id, user.uid)
    assert.equal(session.body['metadata[uid]'], user.uid)
    assert.equal(session.body['metadata[plan]'], 'byok')
    assert.equal(session.body['line_items[0][price]'], 'price_faangin_byok_v1')
    assert.equal(session.body.allow_promotion_codes, 'false')
    assert.equal(session.body.success_url, 'https://demo-faangin.web.app/billing/success?session_id={CHECKOUT_SESSION_ID}', 'the origin is this project\'s own site, not another environment\'s')
    assert.equal(session.body.cancel_url, 'https://demo-faangin.web.app/billing/cancel')
    assert.equal(session.body['invoice_creation[enabled]'], 'true', 'the one-time purchase gets an invoice')
    assert.equal(session.body['invoice_creation[invoice_data][metadata][uid]'], user.uid)
    assert.equal(session.body['payment_intent_data[metadata][plan]'], 'byok')
    assert.equal(session.body['customer_update[name]'], 'auto')
    assert.equal(session.body['customer_update[address]'], 'auto')
    assert.match(session.body.integration_identifier, /^faangin_activate_[a-z]{8}$/)
    assert.equal(session.body['automatic_tax[enabled]'], undefined, 'automatic tax waits for flags/global.automaticTax')
    assert.equal(session.body['tax_id_collection[enabled]'], undefined)
    assert.equal(session.body['consent_collection[terms_of_service]'], undefined)
    assert.equal(Object.keys(session.body).some((k) => k.startsWith('payment_method_types')), false, 'dynamic payment methods')
    assert.equal(session.body['excluded_payment_method_types[0]'], 'us_bank_account', 'delayed bank debits are excluded for BYOK too')
    const lifetimeSeconds = Number(session.body.expires_at) - Math.floor(Date.now() / 1000)
    assert.ok(lifetimeSeconds > 30 * 60 && lifetimeSeconds <= 45 * 60 + 5, `session lives about 45 minutes, got ${lifetimeSeconds}s`)

    const customer = fake.requests.find((r) => r.path === '/v1/customers')
    assert.ok(customer, 'customer created on first checkout')
    assert.equal(customer.body['metadata[uid]'], user.uid)
    assert.equal(customer.body.email, undefined, 'an unverified email is not put on the customer: Checkout would lock it in')
    assert.match(String(customer.headers['idempotency-key']), /^faangin-customer-[0-9a-f]{40}$/, 'creation is idempotent per buyer')
    const stored = (await db.collection('customers').doc(user.uid).get()).data()
    assert.equal(stored?.stripeCustomerId, session.body.customer)
    assert.deepEqual((await db.collection('customersByStripe').doc(session.body.customer).get()).data(), { uid: user.uid })
  })

  it('byok: second checkout is failed-precondition once fulfilled, and reuses the customer', async () => {
    const user = await signInTestUser()
    await call('createCheckoutSession', { plan: 'byok' }, user.idToken)
    const customerId = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!.body.customer

    const response = await postWebhook(fake.fakeEvent('checkout.session.completed', byokSession(user.uid, customerId)))
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { outcome: string }).outcome, 'applied')
    const stored = await entitlement(user.uid)
    assert.equal(stored?.plan, 'byok')
    assert.equal(stored?.status, 'active')
    assert.equal(stored?.stripeCustomerId, customerId)
    assert.deepEqual(stored?.byok, { status: 'active', purchasedAt: stored?.byok.purchasedAt, paymentIntentId: `pi_byok_${user.uid}`, checkoutSessionId: `cs_test_byok_${user.uid}` })

    fake.reset()
    await expectCode(call('createCheckoutSession', { plan: 'byok' }, user.idToken), 'FAILED_PRECONDITION')
    assert.equal(fake.requests.length, 0, 'blocked before touching Stripe')

    const { url } = await call<{ url: string }>('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken)
    assert.ok(url)
    assert.equal(fake.requests.some((r) => r.path === '/v1/customers'), false, 'existing customer reused')
    assert.equal(fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!.body.customer, customerId)
  })

  it('pro: blocked while flags/global.checkoutOpen is false, open otherwise with subscription metadata', async () => {
    const user = await signInTestUser()
    await db.collection('flags').doc('global').set({ checkoutOpen: false }, { merge: true })
    try {
      await expectCode(call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken), 'FAILED_PRECONDITION')
      assert.equal(fake.requests.length, 0)
    } finally {
      await openFlags()
    }
    const { url } = await call<{ url: string }>('createCheckoutSession', { plan: 'pro_annual' }, user.idToken)
    assert.match(url, /^https:\/\/checkout\.stripe\.test\//)
    const prices = fake.requests.find((r) => r.path === '/v1/prices')!
    assert.deepEqual([...prices.query].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v), ['faangin_pro_annual'])
    const session = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!
    assert.equal(session.body.mode, 'subscription')
    assert.equal(session.body['subscription_data[metadata][uid]'], user.uid)
    assert.equal(session.body['subscription_data[metadata][plan]'], 'pro_annual')
    assert.equal(session.body['subscription_data[description]'], 'Faangin Pro')
    assert.equal(session.body['invoice_creation[enabled]'], undefined, 'subscriptions invoice on their own')
    assert.deepEqual(
      Object.keys(session.body).filter((k) => k.startsWith('excluded_payment_method_types')).map((k) => session.body[k]),
      ['us_bank_account', 'sepa_debit', 'bacs_debit', 'acss_debit', 'au_becs_debit', 'nz_bank_account'],
      'delayed-confirmation bank debits cannot start a subscription'
    )
  })

  it('a verified email goes on the Stripe customer; the same buyer starting twice reuses it', async () => {
    const user = await signInVerifiedTestUser()
    await call('createCheckoutSession', { plan: 'byok' }, user.idToken)
    const created = fake.requests.find((r) => r.path === '/v1/customers')
    assert.equal(created?.body.email, user.email)
    assert.equal((await db.collection('customers').doc(user.uid).get()).data()?.email, user.email)
    await call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken)
    assert.equal(fake.requests.filter((r) => r.path === '/v1/customers').length, 1)
  })

  it('two concurrent first checkouts share one Stripe customer (idempotent creation)', async () => {
    const user = await signInTestUser()
    await Promise.all([call('createCheckoutSession', { plan: 'byok' }, user.idToken), call('createCheckoutSession', { plan: 'byok' }, user.idToken)])
    assert.equal(fake.createdCustomers.length, 1, 'the second create was an idempotent replay')
    const mapped = (await db.collection('customers').doc(user.uid).get()).data()?.stripeCustomerId
    assert.equal(mapped, fake.createdCustomers[0])
    assert.deepEqual((await db.collection('customersByStripe').doc(mapped).get()).data(), { uid: user.uid })
  })

  it('expiring is per buyer and per open session: another buyer\'s session is untouched, and an expire that Stripe refuses does not block checkout', async () => {
    const a = await signInTestUser()
    const b = await signInTestUser()
    await call('createCheckoutSession', { plan: 'pro_monthly' }, b.idToken)
    const bSession = [...fake.sessions.values()][0]
    await call('createCheckoutSession', { plan: 'pro_monthly' }, a.idToken)
    const aFirst = [...fake.sessions.values()].find((s) => s.id !== bSession.id)!
    fake.requests.length = 0
    await call('createCheckoutSession', { plan: 'pro_annual' }, a.idToken)
    assert.equal(fake.sessions.get(bSession.id)?.status, 'open', 'buyer B keeps their open session')
    assert.equal(fake.sessions.get(aFirst.id)?.status, 'expired')
    const list = fake.requests.find((r) => r.method === 'GET' && r.path === '/v1/checkout/sessions')!
    assert.equal(list.query.get('status'), 'open')
    assert.equal(list.query.get('customer'), (await db.collection('customers').doc(a.uid).get()).data()?.stripeCustomerId)
    // Stripe refuses to expire a session the buyer paid a moment ago: the failure is logged and checkout still works
    const stillOpen = [...fake.sessions.values()].find((s) => s.status === 'open' && s.id !== bSession.id)!
    fake.refuseExpire.add(stillOpen.id)
    const { url } = await call<{ url: string }>('createCheckoutSession', { plan: 'pro_monthly' }, a.idToken)
    assert.match(url, /^https:\/\/checkout\.stripe\.test\//)
    assert.equal(fake.sessions.get(stillOpen.id)?.status, 'open', 'the refused session is left alone')
  })

  it('starting a new checkout expires the buyer\'s earlier open session, so two cannot both be paid', async () => {
    const user = await signInTestUser()
    await call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken)
    const [first] = [...fake.sessions.values()]
    assert.equal(first.status, 'open')
    await call('createCheckoutSession', { plan: 'pro_annual' }, user.idToken)
    const all = [...fake.sessions.values()]
    assert.equal(all.length, 2)
    assert.equal(all.find((s) => s.id === first.id)?.status, 'expired')
    assert.equal(all.filter((s) => s.status === 'open').length, 1)
    assert.ok(fake.requests.some((r) => r.method === 'POST' && r.path === `/v1/checkout/sessions/${first.id}/expire`))
  })

  it('flags/global.automaticTax and termsConsent turn on Stripe Tax, tax id collection and the terms checkbox', async () => {
    const user = await signInTestUser()
    await db.collection('flags').doc('global').set({ automaticTax: true, termsConsent: true }, { merge: true })
    try {
      await call<{ url: string }>('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken)
      const session = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!
      assert.equal(session.body['automatic_tax[enabled]'], 'true')
      assert.equal(session.body['tax_id_collection[enabled]'], 'true')
      assert.equal(session.body['consent_collection[terms_of_service]'], 'required')
      assert.equal(session.body['customer_update[address]'], 'auto', 'the address entered at Checkout is saved for tax and invoices')
    } finally {
      await db.collection('flags').doc('global').set({ automaticTax: false, termsConsent: false }, { merge: true })
    }
  })

  it('pro: refused while Stripe holds a live subscription for the customer, so a retry cannot double-bill', async () => {
    const user = await signInTestUser()
    await call('createCheckoutSession', { plan: 'byok' }, user.idToken)
    const customerId = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!.body.customer
    fake.reset()
    fake.subscriptions.set('sub_live', fake.fakeSubscription({ id: 'sub_live', customer: customerId, status: 'past_due' }))
    await expectCode(call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken), 'FAILED_PRECONDITION')
    const list = fake.requests.find((r) => r.method === 'GET' && r.path === '/v1/subscriptions')
    assert.ok(list, 'subscriptions listed')
    assert.equal(list.query.get('customer'), customerId)
    assert.equal(list.query.get('status'), 'all')
    assert.equal(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions'), false, 'no session created')

    fake.subscriptions.set('sub_live', fake.fakeSubscription({ id: 'sub_live', customer: customerId, status: 'canceled' }))
    const { url } = await call<{ url: string }>('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken)
    assert.ok(url, 'an ended subscription does not block')
  })

  it('a subscription on hold (unpaid or paused) gets a truthful message, not "Pro is already active"', async () => {
    const user = await signInTestUser()
    await call('createCheckoutSession', { plan: 'byok' }, user.idToken)
    const customerId = (await db.collection('customers').doc(user.uid).get()).data()?.stripeCustomerId
    fake.subscriptions.set('sub_hold', fake.fakeSubscription({ id: 'sub_hold', customer: customerId, status: 'unpaid' }))
    await assert.rejects(call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'FAILED_PRECONDITION')
      assert.match(err.message, /on hold/)
      return true
    })
    fake.subscriptions.set('sub_hold', fake.fakeSubscription({ id: 'sub_hold', customer: customerId, status: 'active' }))
    await assert.rejects(call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken), /already active/)
  })

  it('a string-typed flag typed into the console fails safe: "false" closes Pro checkout, BYOK stays open', async () => {
    const user = await signInTestUser()
    await db.collection('flags').doc('global').set({ checkoutOpen: 'false', automaticTax: 'true' }, { merge: true })
    try {
      await expectCode(call('createCheckoutSession', { plan: 'pro_monthly' }, user.idToken), 'FAILED_PRECONDITION')
      await call('createCheckoutSession', { plan: 'byok' }, user.idToken)
      const session = fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')!
      assert.equal(session.body['automatic_tax[enabled]'], undefined, 'the string "true" does not turn Stripe Tax on')
    } finally {
      await db.collection('flags').doc('global').set({ checkoutOpen: true, automaticTax: false }, { merge: true })
    }
  })

  it('rejects anonymous calls and unknown plans', async () => {
    const user = await signInTestUser()
    await expectCode(call('createCheckoutSession', { plan: 'byok' }), 'UNAUTHENTICATED')
    await expectCode(call('createCheckoutSession', { plan: 'enterprise' }, user.idToken), 'INVALID_ARGUMENT')
  })
})

describe('stripeWebhook', () => {
  it('rejects a bad signature with 400 and a livemode mismatch with 400', async () => {
    const event = fake.fakeEvent('customer.subscription.updated', fake.fakeSubscription({ id: 'sub_sig' }))
    assert.equal((await postWebhook(event, 't=1,v1=deadbeef')).status, 400)
    assert.equal((await postWebhook(event, fake.signWebhook(JSON.stringify(event), 'whsec_wrong'))).status, 400)
    assert.equal((await postWebhook({ ...event, livemode: true })).status, 400)
    assert.equal((await db.collection('entitlements').doc('nobody').get()).exists, false)
  })

  it('subscription.updated active → pro with period and ramp, seat counted; replay does nothing; deleted → canceled', async () => {
    const user = await signInTestUser()
    const customerId = `cus_pro_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const seatsBefore = await activeSeats()
    const periodStart = Math.floor(Date.now() / 1000)
    const periodEnd = periodStart + 30 * 86400
    const subscription = fake.fakeSubscription({ id: `sub_${user.uid}`, customer: customerId, periodStart, periodEnd, cancelAtPeriodEnd: true })

    fake.subscriptions.set(`sub_${user.uid}`, subscription)
    const event = fake.fakeEvent('customer.subscription.updated', subscription)
    const response = await postWebhook(event)
    assert.equal(response.status, 200)
    const stored = await entitlement(user.uid)
    assert.equal(stored?.plan, 'pro')
    assert.equal(stored?.status, 'active')
    assert.equal(stored?.stripeCustomerId, customerId)
    assert.equal(stored?.pro.subscriptionId, `sub_${user.uid}`)
    assert.equal(stored?.pro.status, 'active')
    assert.equal(stored?.pro.priceLookupKey, 'faangin_pro_monthly')
    assert.equal(stored?.pro.currentPeriodStart, periodStart * 1000)
    assert.equal(stored?.pro.currentPeriodEnd, periodEnd * 1000)
    assert.equal(stored?.pro.cancelAtPeriodEnd, true)
    assert.equal(stored?.pro.rampUntil, stored?.pro.startedAt + 14 * DAY)
    assert.equal(await activeSeats(), seatsBefore + 1)
    const record = (await db.collection('stripeEvents').doc(event.id).get()).data()
    assert.equal(record?.type, 'customer.subscription.updated')
    assert.ok(record?.processedAt)

    const replay = await postWebhook(event)
    assert.equal(replay.status, 200)
    assert.equal((await replay.json() as { duplicate?: boolean }).duplicate, true)
    assert.deepEqual(await entitlement(user.uid), stored)
    assert.equal(await activeSeats(), seatsBefore + 1)

    await postSubscriptionEvent('customer.subscription.deleted', { ...subscription, status: 'canceled' })
    const canceled = await entitlement(user.uid)
    assert.equal(canceled?.status, 'canceled')
    assert.equal(canceled?.pro.startedAt, stored?.pro.startedAt)
    assert.equal(await activeSeats(), seatsBefore)
  })

  it('a fresh unprocessed claim is answered 500 so Stripe retries; a stale one (instance died mid-event) is taken over', async () => {
    const user = await signInTestUser()
    const customerId = `cus_stale_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const staleSub = fake.fakeSubscription({ id: `sub_stale_${user.uid}`, customer: customerId })
    fake.subscriptions.set(`sub_stale_${user.uid}`, staleSub)
    const event = fake.fakeEvent('customer.subscription.created', staleSub)
    const claim = db.collection('stripeEvents').doc(event.id)

    await claim.set({ type: event.type, receivedAt: Date.now() })
    const fresh = await postWebhook(event)
    assert.equal(fresh.status, 500, 'another delivery is in flight: 200 would end the retries even if it dies')
    assert.equal(await entitlement(user.uid), undefined)

    await claim.set({ type: event.type, receivedAt: Date.now() - 11 * 60 * 1000 })
    const retried = await postWebhook(event)
    assert.equal(retried.status, 200)
    assert.equal((await retried.json() as { outcome: string }).outcome, 'applied')
    assert.equal((await entitlement(user.uid))?.status, 'active')
    assert.ok((await claim.get()).data()?.processedAt)
  })

  it('the same event delivered twice at once is applied once: the loser is told to retry, and the retry is a plain duplicate', async () => {
    const user = await signInTestUser()
    const customerId = `cus_twice_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const seatsBefore = await activeSeats()
    const subscription = fake.fakeSubscription({ id: `sub_twice_${user.uid}`, customer: customerId })
    fake.subscriptions.set(`sub_twice_${user.uid}`, subscription)
    const event = fake.fakeEvent('customer.subscription.created', subscription)
    const [x, y] = await Promise.all([postWebhook(event), postWebhook(event)])
    const statuses = [x.status, y.status].sort()
    assert.ok(statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 500), `one delivery wins, the other is a duplicate or told to retry, got ${statuses}`)
    assert.equal(await activeSeats(), seatsBefore + 1, 'applied once')
    assert.equal((await entitlement(user.uid))?.status, 'active')
    const retry = await postWebhook(event)
    assert.equal(retry.status, 200)
    assert.equal((await retry.json() as { duplicate?: boolean }).duplicate, true)
    assert.equal(await activeSeats(), seatsBefore + 1)
  })

  it('checkout.session.completed for a subscription fetches it from Stripe', async () => {
    const user = await signInTestUser()
    const customerId = `cus_sub_${user.uid}`
    fake.subscriptions.set(`sub_cs_${user.uid}`, fake.fakeSubscription({ id: `sub_cs_${user.uid}`, customer: customerId, uid: user.uid, lookupKey: 'faangin_pro_annual' }))
    const session = byokSession(user.uid, customerId, { id: `cs_test_sub_${user.uid}`, mode: 'subscription', subscription: `sub_cs_${user.uid}`, payment_intent: null, metadata: { uid: user.uid, plan: 'pro_annual' } })
    assert.equal((await postWebhook(fake.fakeEvent('checkout.session.completed', session))).status, 200)
    assert.ok(fake.requests.some((r) => r.method === 'GET' && r.path === `/v1/subscriptions/sub_cs_${user.uid}`))
    const stored = await entitlement(user.uid)
    assert.equal(stored?.plan, 'pro')
    assert.equal(stored?.status, 'active')
    assert.equal(stored?.pro.priceLookupKey, 'faangin_pro_annual')
    assert.equal(stored?.stripeCustomerId, customerId)
  })

  it('charge.refunded (full) revokes the byok entitlement the charge paid for', async () => {
    const user = await signInTestUser()
    const customerId = `cus_refund_${user.uid}`
    await mapCustomer(customerId, user.uid)
    await postWebhook(fake.fakeEvent('checkout.session.completed', byokSession(user.uid, customerId)))
    assert.equal((await entitlement(user.uid))?.status, 'active')

    const partial = fake.fakeEvent('charge.refunded', { id: `ch_${user.uid}`, object: 'charge', customer: customerId, payment_intent: `pi_byok_${user.uid}`, refunded: false })
    assert.equal((await postWebhook(partial)).status, 200)
    assert.equal((await entitlement(user.uid))?.status, 'active', 'partial refund keeps the plan')

    const full = fake.fakeEvent('charge.refunded', { id: `ch_${user.uid}`, object: 'charge', customer: customerId, payment_intent: `pi_byok_${user.uid}`, refunded: true })
    assert.equal((await postWebhook(full)).status, 200)
    const revoked = await entitlement(user.uid)
    assert.equal(revoked?.plan, 'byok')
    assert.equal(revoked?.status, 'revoked')
    assert.equal(revoked?.reason, 'refund')
  })

  it('charge.dispute.created resolves the customer through the charge', async () => {
    const user = await signInTestUser()
    const customerId = `cus_dispute_${user.uid}`
    await mapCustomer(customerId, user.uid)
    await postSubscriptionEvent('customer.subscription.created', fake.fakeSubscription({ id: `sub_dp_${user.uid}`, customer: customerId }))
    fake.charges.set(`ch_dp_${user.uid}`, { id: `ch_dp_${user.uid}`, object: 'charge', customer: customerId })
    assert.equal((await postWebhook(fake.fakeEvent('charge.dispute.created', { id: `dp_${user.uid}`, object: 'dispute', charge: `ch_dp_${user.uid}`, payment_intent: 'pi_invoice' }))).status, 200)
    const stored = await entitlement(user.uid)
    assert.equal(stored?.status, 'revoked')
    assert.equal(stored?.reason, 'dispute')
  })

  it('a delayed byok payment: completed-but-unpaid grants nothing, async_payment_failed only logs, async_payment_succeeded grants', async () => {
    const user = await signInTestUser()
    const customerId = `cus_async_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const unpaid = await postWebhook(fake.fakeEvent('checkout.session.completed', byokSession(user.uid, customerId, { payment_status: 'unpaid' })))
    assert.equal((await unpaid.json() as { outcome: string }).outcome, 'ignored')
    assert.equal(await entitlement(user.uid), undefined)
    const failed = await postWebhook(fake.fakeEvent('checkout.session.async_payment_failed', byokSession(user.uid, customerId, { payment_status: 'unpaid' })))
    assert.equal(failed.status, 200)
    assert.equal(await entitlement(user.uid), undefined)
    const paid = await postWebhook(fake.fakeEvent('checkout.session.async_payment_succeeded', byokSession(user.uid, customerId, { payment_status: 'paid' })))
    assert.equal((await paid.json() as { outcome: string }).outcome, 'applied')
    assert.equal((await entitlement(user.uid))?.plan, 'byok')
  })

  it('invoice.paid re-reads the subscription from Stripe and heals a past_due entitlement', async () => {
    const user = await signInTestUser()
    const customerId = `cus_inv_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const subId = `sub_inv_${user.uid}`
    await postSubscriptionEvent('customer.subscription.updated', fake.fakeSubscription({ id: subId, customer: customerId, status: 'past_due' }))
    assert.equal((await entitlement(user.uid))?.status, 'past_due')
    fake.subscriptions.set(subId, fake.fakeSubscription({ id: subId, customer: customerId, status: 'active' }))
    const response = await postWebhook(fake.fakeEvent('invoice.paid', { id: `in_${user.uid}`, object: 'invoice', customer: customerId, parent: { subscription_details: { subscription: subId } } }))
    assert.equal((await response.json() as { outcome: string }).outcome, 'applied')
    assert.ok(fake.requests.some((r) => r.method === 'GET' && r.path === `/v1/subscriptions/${subId}`), 'subscription re-read from Stripe')
    assert.equal((await entitlement(user.uid))?.status, 'active')
  })

  it('customer.subscription.paused ends access and frees the seat; resumed restores both', async () => {
    const user = await signInTestUser()
    const customerId = `cus_pause_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const subId = `sub_pause_${user.uid}`
    await postSubscriptionEvent('customer.subscription.created', fake.fakeSubscription({ id: subId, customer: customerId }))
    const seats = await activeSeats()
    await postSubscriptionEvent('customer.subscription.paused', fake.fakeSubscription({ id: subId, customer: customerId, status: 'paused' }))
    assert.equal((await entitlement(user.uid))?.status, 'canceled')
    assert.equal(await activeSeats(), seats - 1)
    await postSubscriptionEvent('customer.subscription.resumed', fake.fakeSubscription({ id: subId, customer: customerId, status: 'active' }))
    assert.equal((await entitlement(user.uid))?.status, 'active')
    assert.equal(await activeSeats(), seats)
  })

  it('a late, retried \'active\' update cannot resurrect a canceled subscription: the current copy is read from Stripe', async () => {
    const user = await signInTestUser()
    const customerId = `cus_late_${user.uid}`
    await mapCustomer(customerId, user.uid)
    const subId = `sub_late_${user.uid}`
    const active = fake.fakeSubscription({ id: subId, customer: customerId })
    await postSubscriptionEvent('customer.subscription.created', active)
    await postSubscriptionEvent('customer.subscription.deleted', { ...active, status: 'canceled' })
    assert.equal((await entitlement(user.uid))?.status, 'canceled')
    // the delayed 'active' update is delivered now; its payload is old, Stripe's current copy is canceled
    fake.subscriptions.set(subId, { ...active, status: 'canceled' })
    const late = await postWebhook(fake.fakeEvent('customer.subscription.updated', active))
    assert.equal(late.status, 200)
    assert.equal((await entitlement(user.uid))?.status, 'canceled')
  })

  it('when subscription metadata.uid disagrees with the customer mapping, the customer\'s uid gets the entitlement', async () => {
    const a = await signInTestUser()
    const b = await signInTestUser()
    await mapCustomer(`cus_dis_${a.uid}`, a.uid)
    const seats = await activeSeats()
    await postSubscriptionEvent('customer.subscription.created', fake.fakeSubscription({ id: `sub_dis_${a.uid}`, customer: `cus_dis_${a.uid}`, uid: b.uid }))
    assert.equal((await entitlement(a.uid))?.status, 'active')
    assert.equal(await entitlement(b.uid), undefined, 'metadata alone never overrides the customer mapping')
    assert.equal(await activeSeats(), seats + 1)
  })

  it('answers 200 for an unknown customer and for unhandled event types', async () => {
    const unknown = await postSubscriptionEvent('customer.subscription.updated', fake.fakeSubscription({ id: 'sub_unknown', customer: 'cus_nobody' }))
    assert.equal(unknown.status, 200)
    assert.equal((await unknown.json() as { outcome: string }).outcome, 'unknown_uid')
    const unhandled = await postWebhook(fake.fakeEvent('customer.created', { id: 'cus_x', object: 'customer' }))
    assert.equal(unhandled.status, 200)
    assert.equal((await unhandled.json() as { outcome: string }).outcome, 'ignored')
  })
})

describe('createPortalSession', () => {
  it('returns the portal url for a customer and failed-precondition without one', async () => {
    const user = await signInTestUser()
    await expectCode(call('createPortalSession', {}, user.idToken), 'FAILED_PRECONDITION')
    await call('createCheckoutSession', { plan: 'byok' }, user.idToken)
    const customerId = (await db.collection('customers').doc(user.uid).get()).data()?.stripeCustomerId
    // Only the Dashboard default exists: never use it (it may allow plan switching, which resets the metered allowances).
    fake.portalConfigurations.push({ id: 'bpc_default', object: 'billing_portal.configuration', active: true, is_default: true, metadata: {} })
    await expectCode(call('createPortalSession', {}, user.idToken), 'FAILED_PRECONDITION')
    assert.equal(fake.requests.some((r) => r.path === '/v1/billing_portal/sessions'), false, 'no portal session without the tagged configuration')

    fake.portalConfigurations.push({ id: 'bpc_faangin', object: 'billing_portal.configuration', active: true, is_default: false, metadata: { faangin: 'v1' } })
    const { url } = await call<{ url: string }>('createPortalSession', {}, user.idToken)
    assert.match(url, /^https:\/\/billing\.stripe\.test\/p\/session\/bps_test_/)
    const portal = fake.requests.find((r) => r.path === '/v1/billing_portal/sessions')!
    assert.equal(portal.body.customer, customerId)
    assert.equal(portal.body.return_url, 'https://demo-faangin.web.app/activate')
    assert.equal(portal.body.configuration, 'bpc_faangin', 'the configuration tagged by stripe-setup.mjs')
  })
})
