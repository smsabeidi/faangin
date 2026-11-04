import assert from 'node:assert/strict'
import { test } from 'node:test'
import type Stripe from 'npm:stripe@23.0.1'
import { ServiceError } from '../errors.ts'
import type { NormalizedEvent } from '../fulfill.ts'
import { bindPaymentState } from '../payment-binding.ts'

type Charge = {
  id: string
  paid?: boolean
  status?: string
  refunded?: boolean
  disputed?: boolean
  amount?: number
  amount_refunded?: number
  payment_intent?: string | { id: string } | null
  customer?: string | { id: string } | null
}
type InvoicePayment = { invoice: string | { id: string } }
type Invoice = { parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }
type Call = { method: string; input: unknown }
interface FixtureOptions {
  charges?: Charge[]
  chargeListError?: Error
  retrievedCharge?: Charge
  chargeRetrieveError?: Error
  invoicePayments?: InvoicePayment[]
  invoicePaymentError?: Error
  invoicePaymentErrorAfter?: number
  invoices?: Record<string, Invoice>
  invoiceRetrieveError?: Error
}
function fixture(options: FixtureOptions = {}) {
  const calls: Call[] = []
  const stripe = {
    charges: {
      list(input: unknown) {
        calls.push({ method: 'charges.list', input })
        return (async function* () {
          if (options.chargeListError) throw options.chargeListError
          for (const charge of options.charges ?? []) { await Promise.resolve(); yield charge }
        })()
      },
      async retrieve(input: string) {
        calls.push({ method: 'charges.retrieve', input })
        if (options.chargeRetrieveError) throw options.chargeRetrieveError
        assert.ok(options.retrievedCharge, 'Unexpected charge lookup')
        return options.retrievedCharge
      }
    },
    invoicePayments: {
      list(input: unknown) {
        calls.push({ method: 'invoicePayments.list', input })
        return (async function* () {
          let read = 0
          for (const payment of options.invoicePayments ?? []) {
            if (options.invoicePaymentError && read === (options.invoicePaymentErrorAfter ?? 0)) throw options.invoicePaymentError
            await Promise.resolve(); yield payment; read++
          }
          if (options.invoicePaymentError) throw options.invoicePaymentError
        })()
      }
    },
    invoices: {
      async retrieve(input: string) {
        calls.push({ method: 'invoices.retrieve', input })
        if (options.invoiceRetrieveError) throw options.invoiceRetrieveError
        assert.ok(options.invoices && Object.hasOwn(options.invoices, input), `Unexpected invoice lookup: ${input}`)
        return options.invoices[input]
      }
    }
  } as unknown as Stripe
  return { stripe, calls }
}
const purchase = (paymentIntentId = 'pi_byok_fixture'): NormalizedEvent => ({
  kind: 'byok_purchase', uid: '0d08fe00-1234-4000-8000-000000000001', customerId: 'cus_fixture',
  purchasedAt: 1_793_491_200_000, paymentIntentId, checkoutSessionId: 'cs_test_fixture'
})
const successfulCharge = (overrides: Partial<Charge> = {}): Charge => ({
  id: 'ch_paid_fixture', customer: 'cus_fixture', payment_intent: 'pi_byok_fixture', paid: true, status: 'succeeded', refunded: false, disputed: false,
  amount: 1000, amount_refunded: 0, ...overrides
})
const revocation = (kind: 'refund' | 'dispute' | 'fraud_warning', paymentIntentId?: string): NormalizedEvent => ({
  kind, chargeId: 'ch_invoice_fixture', ...(paymentIntentId ? { paymentIntentId } : {}), ...(kind === 'refund' ? { full: true } : {})
}) as NormalizedEvent
const subscriptions = (event: NormalizedEvent): string[] => (event as { subscriptionIds?: string[] }).subscriptionIds ?? []
const revokedReason = (event: NormalizedEvent): string | undefined => (event as { revokedReason?: string }).revokedReason

for (const [label, charge, reason] of [
  ['fully refunded', successfulCharge({ refunded: true, amount_refunded: 1000 }), 'refund'],
  ['disputed', successfulCharge({ disputed: true }), 'dispute'],
  ['partially refunded', successfulCharge({ amount_refunded: 400 }), undefined],
  ['paid and retained', successfulCharge(), undefined]
] as const) {
  test(`BYOK binding reads successful payment state before admitting a ${label} purchase`, async () => {
    const f = fixture({ charges: [charge] }), event = purchase()
    const result = await bindPaymentState(event, f.stripe)
    assert.equal(revokedReason(result), reason)
    assert.equal(result.kind, 'byok_purchase')
    if (result.kind === 'byok_purchase') {
      assert.equal(result.paymentIntentId, 'pi_byok_fixture')
      assert.equal(result.checkoutSessionId, 'cs_test_fixture')
    }
    assert.deepEqual(f.calls, [{ method: 'charges.list', input: { payment_intent: 'pi_byok_fixture', limit: 100 } }])
  })
}

test('BYOK binding iterates beyond unsuccessful attempts to find the actual paid charge', async () => {
  const f = fixture({ charges: [
    successfulCharge({ id: 'ch_failed', paid: false, status: 'failed', refunded: true }),
    successfulCharge({ id: 'ch_pending', paid: true, status: 'pending', disputed: true }),
    successfulCharge({ id: 'ch_final', refunded: true, amount_refunded: 1000 })
  ] })
  const result = await bindPaymentState(purchase(), f.stripe)
  assert.equal(revokedReason(result), 'refund')
  assert.equal(f.calls.length, 1)
})

for (const [label, charges] of [
  ['no charge', []],
  ['unpaid charge', [successfulCharge({ paid: false })]],
  ['unsuccessful charge', [successfulCharge({ status: 'failed' })]]
] as const) {
  test(`BYOK binding refuses ${label} with retryable unavailable instead of granting access`, async () => {
    const f = fixture({ charges: [...charges] })
    await assert.rejects(bindPaymentState(purchase(), f.stripe), error => error instanceof ServiceError && error.code === 'unavailable')
  })
}

for (const customer of ['cus_unrelated', { id: 'cus_unrelated' }, null]) {
  test(`a successful charge with ${customer === null ? 'missing' : typeof customer === 'string' ? 'another' : 'expanded unrelated'} customer cannot license the purchase`, async () => {
    const f = fixture({ charges: [successfulCharge({ customer })] })
    await assert.rejects(bindPaymentState(purchase(), f.stripe), error => error instanceof ServiceError && error.code === 'failed-precondition')
    assert.deepEqual(f.calls, [{ method: 'charges.list', input: { payment_intent: 'pi_byok_fixture', limit: 100 } }])
  })
}

test('a successful charge with an expanded matching customer binds to the same purchase owner', async () => {
  const event = purchase(), f = fixture({ charges: [successfulCharge({ customer: { id: 'cus_fixture' } })] })
  assert.deepEqual(await bindPaymentState(event, f.stripe), event)
})

test('BYOK no-payment-required purchase without a payment intent remains unchanged and performs no reads', async () => {
  const f = fixture(), event = purchase('')
  assert.deepEqual(await bindPaymentState(event, f.stripe), event)
  assert.deepEqual(f.calls, [])
})

for (const kind of ['refund', 'dispute', 'fraud_warning'] as const) {
  test(`${kind} binds the payment to every invoice subscription instead of an unrelated current plan`, async () => {
    const f = fixture({
      invoicePayments: [{ invoice: 'in_old_subscription' }, { invoice: { id: 'in_other_subscription' } }, { invoice: 'in_one_off' }],
      invoices: {
        in_old_subscription: { parent: { subscription_details: { subscription: 'sub_original_invoice' } } },
        in_other_subscription: { parent: { subscription_details: { subscription: { id: 'sub_other_invoice' } } } },
        in_one_off: { parent: null }
      }
    })
    const result = await bindPaymentState(revocation(kind, 'pi_invoice_fixture'), f.stripe)
    assert.equal(result.kind, kind)
    assert.deepEqual([...new Set(subscriptions(result))].sort(), ['sub_original_invoice', 'sub_other_invoice'].sort())
    assert.ok(subscriptions(result).every(value => typeof value === 'string' && value.length > 0))
    assert.deepEqual(f.calls, [
      { method: 'invoicePayments.list', input: { payment: { type: 'payment_intent', payment_intent: 'pi_invoice_fixture' }, limit: 100 } },
      { method: 'invoices.retrieve', input: 'in_old_subscription' },
      { method: 'invoices.retrieve', input: 'in_other_subscription' },
      { method: 'invoices.retrieve', input: 'in_one_off' }
    ])
  })
}

for (const kind of ['refund', 'dispute', 'fraud_warning'] as const) {
  test(`${kind} without a payment intent or charge ID leaves subscription targets empty`, async () => {
    const f = fixture(), event = { ...revocation(kind), chargeId: '' } as NormalizedEvent
    assert.deepEqual(subscriptions(await bindPaymentState(event, f.stripe)), [])
    assert.deepEqual(f.calls, [])
  })
}

test('a payment with no invoice allocation cannot target an arbitrary subscription', async () => {
  const f = fixture()
  assert.deepEqual(subscriptions(await bindPaymentState(revocation('dispute', 'pi_unallocated'), f.stripe)), [])
  assert.deepEqual(f.calls, [{ method: 'invoicePayments.list', input: { payment: { type: 'payment_intent', payment_intent: 'pi_unallocated' }, limit: 100 } }])
})

test('missing payment intent is recovered from the charge, including expanded customer and payment IDs', async () => {
  const f = fixture({
    retrievedCharge: successfulCharge({ id: 'ch_invoice_fixture', payment_intent: { id: 'pi_recovered' }, customer: { id: 'cus_recovered' } }),
    invoicePayments: [{ invoice: 'in_recovered' }],
    invoices: { in_recovered: { parent: { subscription_details: { subscription: 'sub_recovered' } } } }
  })
  const result = await bindPaymentState(revocation('dispute'), f.stripe)
  assert.equal(result.customerId, 'cus_recovered')
  assert.equal('paymentIntentId' in result && result.paymentIntentId, 'pi_recovered')
  assert.deepEqual(subscriptions(result), ['sub_recovered'])
  assert.deepEqual(f.calls, [
    { method: 'charges.retrieve', input: 'ch_invoice_fixture' },
    { method: 'invoicePayments.list', input: { payment: { type: 'payment_intent', payment_intent: 'pi_recovered' }, limit: 100 } },
    { method: 'invoices.retrieve', input: 'in_recovered' }
  ])
})

test('charge fallback also accepts string IDs and leaves absent invoice subscriptions empty', async () => {
  const f = fixture({ retrievedCharge: successfulCharge({ payment_intent: 'pi_recovered', customer: 'cus_recovered' }) })
  const result = await bindPaymentState(revocation('fraud_warning'), f.stripe)
  assert.equal(result.customerId, 'cus_recovered')
  assert.equal('paymentIntentId' in result && result.paymentIntentId, 'pi_recovered')
  assert.deepEqual(subscriptions(result), [])
})

test('a legacy charge without any payment intent does not invent a subscription binding', async () => {
  const f = fixture({ retrievedCharge: successfulCharge({ payment_intent: null, customer: 'cus_legacy' }) })
  const result = await bindPaymentState(revocation('refund'), f.stripe)
  assert.deepEqual(subscriptions(result), [])
  assert.deepEqual(f.calls, [{ method: 'charges.retrieve', input: 'ch_invoice_fixture' }])
})

for (const paymentIntentId of ['pi_partial_fixture', undefined]) {
  test(`partial refund performs no provider reads${paymentIntentId ? ' even when its payment intent is known' : ' or charge fallback'}`, async () => {
    const f = fixture(), event: NormalizedEvent = { kind: 'refund', chargeId: 'ch_partial_fixture', full: false, ...(paymentIntentId ? { paymentIntentId } : {}) }
    const result = await bindPaymentState(event, f.stripe)
    assert.equal(result.kind, 'refund')
    assert.deepEqual(subscriptions(result), [])
    assert.deepEqual(f.calls, [])
  })
}

test('unrelated subscription and payment-failure events require no payment binding reads', async () => {
  const events: NormalizedEvent[] = [
    { kind: 'payment_failed', subscriptionId: 'sub_fixture' },
    { kind: 'subscription', subscriptionId: 'sub_fixture', status: 'active', priceLookupKey: 'faangin_pro_monthly', currentPeriodStart: 1, currentPeriodEnd: 2, cancelAtPeriodEnd: false }
  ]
  const f = fixture()
  for (const event of events) assert.deepEqual(await bindPaymentState(event, f.stripe), event)
  assert.deepEqual(f.calls, [])
})

for (const stage of ['charge-list', 'charge-fallback', 'invoice-list', 'invoice-read', 'later-invoice-page'] as const) {
  test(`${stage} provider failure propagates so the webhook retries instead of accepting incomplete payment state`, async () => {
    const failure = new Error(`fixture ${stage} unavailable`)
    const options: FixtureOptions = stage === 'charge-list' ? { chargeListError: failure }
      : stage === 'charge-fallback' ? { chargeRetrieveError: failure }
        : stage === 'invoice-list' ? { invoicePaymentError: failure }
          : stage === 'invoice-read' ? { invoicePayments: [{ invoice: 'in_failure' }], invoiceRetrieveError: failure }
            : { invoicePayments: [{ invoice: 'in_first' }], invoices: { in_first: { parent: { subscription_details: { subscription: 'sub_first' } } } }, invoicePaymentError: failure, invoicePaymentErrorAfter: 1 }
    const event = stage === 'charge-list' ? purchase() : revocation('dispute', stage === 'charge-fallback' ? undefined : 'pi_invoice_fixture')
    await assert.rejects(bindPaymentState(event, fixture(options).stripe), error => error === failure)
  })
}
