// The Checkout Session the server creates for a plan. Pure and dependency-free, so the emulated tests and
// scripts/stripe-sandbox-smoke.mjs send exactly what production sends.
import type Stripe from 'stripe'
import { CHECKOUT_INTEGRATION_IDENTIFIER, PORTAL_CONFIGURATION_TAG, hostingOrigin, type Plan } from '../config.js'

export interface CheckoutInput {
  plan: Plan
  uid: string
  /** Stripe customer id (customers/{uid}); always set so metadata and the customer agree on the owner. */
  customer: string
  priceId: string
  /**
   * flags/global.automaticTax: only once Stripe Tax is active (head office set) with registrations. While Tax is pending,
   * Stripe refuses to create the session (stripe_tax_inactive); active with no registration it creates it and collects nothing.
   */
  automaticTax: boolean
  /** flags/global.termsConsent: needs the terms-of-service URL set in the Dashboard's public details first. */
  termsConsent: boolean
  /** Unix ms; defaults to now. Only used for the session's expiry. */
  now?: number
}

/** A session stays open this long. Stripe allows 30 minutes to 24 hours; a short life keeps two open checkouts for one buyer unlikely. */
export const CHECKOUT_SESSION_MINUTES = 45

/**
 * Delayed-confirmation bank debits are excluded for both plans, even if the Dashboard has them on. Pro is a subscription whose
 * access starts when Checkout completes, so a debit that settles (or fails) days later would grant Pro before the money arrives
 * and keep it on failure. BYOK would be safe for access (the webhook waits for async_payment_succeeded) but a buyer whose debit
 * is pending sees no license for days, buys again, and pays twice; instant methods avoid that whole class.
 */
export const DELAYED_PAYMENT_METHODS = ['us_bank_account', 'sepa_debit', 'bacs_debit', 'acss_debit', 'au_becs_debit', 'nz_bank_account'] as const

export function checkoutSessionParams(input: CheckoutInput): Stripe.Checkout.SessionCreateParams {
  const { plan, uid, customer, priceId, automaticTax, termsConsent, now = Date.now() } = input
  const metadata = { uid, plan }
  const origin = hostingOrigin()
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: plan === 'byok' ? 'payment' : 'subscription',
    customer,
    client_reference_id: uid,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    success_url: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing/cancel`,
    allow_promotion_codes: false,
    expires_at: Math.floor(now / 1000) + CHECKOUT_SESSION_MINUTES * 60,
    integration_identifier: CHECKOUT_INTEGRATION_IDENTIFIER,
    // The name and billing address entered at Checkout are saved on the Customer: invoices and tax calculation need
    // them, and a buyer who enters a business tax id gets its legal name on every invoice.
    customer_update: { name: 'auto', address: 'auto' }
    // No payment_method_types: Stripe picks eligible methods from the Dashboard settings (dynamic payment methods).
  }
  params.excluded_payment_method_types = [...DELAYED_PAYMENT_METHODS]
  if (plan === 'byok') {
    params.payment_intent_data = { description: 'Faangin BYOK license', metadata }
    // A one-time purchase gets a real invoice (number, PDF, hosted page), like a subscription payment would.
    params.invoice_creation = { enabled: true, invoice_data: { description: 'Faangin BYOK license, one-time purchase', metadata } }
  } else {
    params.subscription_data = { description: 'Faangin Pro', metadata }
  }
  if (automaticTax) {
    params.automatic_tax = { enabled: true }
    // Business buyers can add a VAT/GST id (reverse charge where the law allows); consumers see nothing extra.
    params.tax_id_collection = { enabled: true }
  }
  if (termsConsent) params.consent_collection = { terms_of_service: 'required' }
  return params
}

export type PortalConfigurationLike = { id: string; active: boolean; metadata: Record<string, string> | null }

/** The Customer Portal configuration tagged by scripts/stripe-setup.mjs (metadata.faangin=v1), or null to let Stripe use its Dashboard default. */
export function pickPortalConfiguration(configurations: ReadonlyArray<PortalConfigurationLike>): string | null {
  return configurations.find((c) => c.active && c.metadata?.[PORTAL_CONFIGURATION_TAG.key] === PORTAL_CONFIGURATION_TAG.value)?.id ?? null
}
