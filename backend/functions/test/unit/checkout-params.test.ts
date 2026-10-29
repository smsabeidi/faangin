import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkoutSessionParams, pickPortalConfiguration } from '../../src/billing/checkout-params.js'

const input = { uid: 'u1', customer: 'cus_1', priceId: 'price_1', automaticTax: false, termsConsent: false } as const

describe('checkoutSessionParams', () => {
  it('byok: payment mode with an invoice, payment-intent metadata and saved name/address', () => {
    const p = checkoutSessionParams({ ...input, plan: 'byok' })
    assert.equal(p.mode, 'payment')
    assert.equal(p.customer, 'cus_1')
    assert.equal(p.client_reference_id, 'u1')
    assert.deepEqual(p.line_items, [{ price: 'price_1', quantity: 1 }])
    assert.deepEqual(p.metadata, { uid: 'u1', plan: 'byok' })
    assert.equal(p.invoice_creation?.enabled, true)
    assert.deepEqual(p.invoice_creation?.invoice_data?.metadata, { uid: 'u1', plan: 'byok' })
    assert.deepEqual(p.payment_intent_data?.metadata, { uid: 'u1', plan: 'byok' })
    assert.equal(p.subscription_data, undefined)
    assert.deepEqual(p.customer_update, { name: 'auto', address: 'auto' })
    assert.match(p.integration_identifier ?? '', /^faangin_activate_[a-z]{8}$/)
    assert.equal(p.allow_promotion_codes, false)
    assert.equal(p.automatic_tax, undefined)
    assert.equal(p.tax_id_collection, undefined)
    assert.equal(p.consent_collection, undefined)
    assert.equal('payment_method_types' in p, false, 'dynamic payment methods: never pin payment_method_types')
    assert.deepEqual(p.excluded_payment_method_types, ['us_bank_account', 'sepa_debit', 'bacs_debit', 'acss_debit', 'au_becs_debit', 'nz_bank_account'], 'a pending bank debit would leave the buyer with no license and tempt a second purchase')
    assert.match(p.success_url, /\/billing\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/)
  })

  it('pro: subscription mode with subscription metadata and no one-off invoice', () => {
    for (const plan of ['pro_monthly', 'pro_annual'] as const) {
      const p = checkoutSessionParams({ ...input, plan })
      assert.equal(p.mode, 'subscription')
      assert.deepEqual(p.subscription_data?.metadata, { uid: 'u1', plan })
      assert.equal(p.subscription_data?.description, 'Faangin Pro')
      assert.equal(p.invoice_creation, undefined)
      assert.equal(p.payment_intent_data, undefined)
      assert.equal(p.subscription_data?.trial_period_days, undefined, 'no trial')
      assert.deepEqual(p.excluded_payment_method_types, ['us_bank_account', 'sepa_debit', 'bacs_debit', 'acss_debit', 'au_becs_debit', 'nz_bank_account'])
      assert.equal('payment_method_types' in p, false)
    }
  })

  it('flags turn on automatic tax with tax id collection, and the terms checkbox', () => {
    const taxed = checkoutSessionParams({ ...input, plan: 'pro_monthly', automaticTax: true })
    assert.deepEqual(taxed.automatic_tax, { enabled: true })
    assert.deepEqual(taxed.tax_id_collection, { enabled: true })
    assert.equal(taxed.consent_collection, undefined)
    const terms = checkoutSessionParams({ ...input, plan: 'byok', termsConsent: true })
    assert.deepEqual(terms.consent_collection, { terms_of_service: 'required' })
    assert.equal(terms.automatic_tax, undefined)
  })
})

describe('checkout session expiry', () => {
  it('expires 45 minutes after creation (Stripe allows 30 minutes to 24 hours)', () => {
    const now = Date.UTC(2026, 9, 29, 12)
    for (const plan of ['byok', 'pro_monthly'] as const) {
      assert.equal(checkoutSessionParams({ ...input, plan, now }).expires_at, Math.floor(now / 1000) + 45 * 60)
    }
  })
})

describe('pickPortalConfiguration', () => {
  it('prefers the active configuration tagged faangin=v1 over the default, ignores inactive ones, null when none', () => {
    assert.equal(pickPortalConfiguration([
      { id: 'bpc_default', active: true, metadata: {} },
      { id: 'bpc_old', active: false, metadata: { faangin: 'v1' } },
      { id: 'bpc_faangin', active: true, metadata: { faangin: 'v1' } }
    ]), 'bpc_faangin')
    assert.equal(pickPortalConfiguration([{ id: 'bpc_default', active: true, metadata: {} }]), null)
    assert.equal(pickPortalConfiguration([]), null)
    assert.equal(pickPortalConfiguration([{ id: 'bpc_x', active: true, metadata: null }]), null)
  })
})
