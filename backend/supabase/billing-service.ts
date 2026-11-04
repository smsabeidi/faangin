import { randomUUID } from 'node:crypto'
import type Stripe from 'npm:stripe@23.0.1'
import { CHECKOUT_PRICE_USD_CENTS, isCheckoutPlan, LEGACY_BYOK_PRICE, PRICE_LOOKUP, type Plan } from './config.ts'
import { ServiceError } from './errors.ts'
import { applyStripeEvent, normalizeStripeEvent, normalizeSubscription, type NormalizedEvent } from './fulfill.ts'
import { checkoutBlocked, customerIdempotencyKey, liveSubscriptionState, parseCheckoutFlags } from './checkout-logic.ts'
import { checkoutSessionParams, pickPortalConfiguration } from './checkout-params.ts'
import { bindPaymentState } from './payment-binding.ts'
import type { BillingStore } from './store.ts'
import type { AccountUser } from './account-service.ts'

export interface BillingDeps {
  store: BillingStore
  stripe: Stripe
  hostingOrigin: string
  expectLivemode: boolean
  now?: () => number
  owner?: () => string
  log?: (event: string, fields?: Record<string, unknown>) => void
}
export function createBillingService(deps: BillingDeps) {
  const { store, stripe } = deps, now = deps.now ?? Date.now, owner = deps.owner ?? randomUUID
  const log = deps.log ?? (() => {})
  const origin = deps.hostingOrigin.replace(/\/$/, '')
  function isConfiguredPrice(price: Stripe.Price | null | undefined, plan: Plan) {
    if (price?.lookup_key !== PRICE_LOOKUP[plan] || price.currency !== 'usd' || price.unit_amount !== CHECKOUT_PRICE_USD_CENTS[plan]) return false
    const interval = plan === 'pro_monthly' ? 'month' : 'year'
    return price.type === 'recurring' && price.recurring?.interval === interval && price.recurring.interval_count === 1
  }
  async function isLegacyByokCheckout(sessionId: string) {
    const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 })
    const price = items.data[0]?.price
    return !items.has_more && items.data.length === 1 && items.data[0].quantity === 1 &&
      price?.lookup_key === LEGACY_BYOK_PRICE.lookupKey && price.currency === 'usd' &&
      price.unit_amount === LEGACY_BYOK_PRICE.amountUsdCents && price.type === 'one_time' && !price.recurring
  }
  async function customer(user: AccountUser) {
    const existing = await store.customer(user.id)
    if (existing) return existing
    const email = user.emailVerified ? user.email : undefined
    const created = await stripe.customers.create({ email, metadata: { uid: user.id } }, { idempotencyKey: customerIdempotencyKey(user.id, email, now()) })
    return store.bindCustomer(user.id, created.id, email)
  }
  async function apply(uid: string, normalized: NormalizedEvent, event?: { id: string; owner: string }) {
    let current = await store.readEntitlement(uid)
    for (let retry = 0; retry < 8; retry++) {
      const next = applyStripeEvent(current.document, normalized, now())
      const result = await store.commit(uid, current.version, next, event)
      if (result.kind === 'committed' || result.kind === 'processed') return
      if (result.kind === 'lost_claim') throw new ServiceError('unavailable', 'The payment event is being processed by another worker')
      current = { document: result.document, version: result.version }
    }
    throw new ServiceError('unavailable', 'The account changed during payment confirmation; retry the event')
  }
  async function resolveUid(normalized: NormalizedEvent) {
    const metadata = 'uid' in normalized ? normalized.uid : undefined
    let customerId = normalized.customerId
    if (!customerId && 'chargeId' in normalized && normalized.chargeId) {
      const charge = await stripe.charges.retrieve(normalized.chargeId)
      customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id
    }
    const mapped = customerId ? await store.customerUid(customerId) : null
    if (mapped && metadata && mapped !== metadata) log('stripe_owner_disagreement', { customerId, mapped, metadata })
    // Metadata is server-written, but legacy/foreign metadata must not reach a UUID-typed RPC.
    const candidate = mapped ?? metadata
    return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ? candidate : undefined
  }
  return {
    async checkout(user: AccountUser, input: unknown) {
      if (!user.id) throw new ServiceError('unauthenticated', 'Sign in first')
      const plan = input && typeof input === 'object' ? (input as Record<string, unknown>).plan : undefined
      if (!isCheckoutPlan(plan)) throw new ServiceError('invalid-argument', 'Choose a monthly or annual Pro plan.')
      const lease = owner()
      if (!(await store.claimCheckout(user.id, lease))) throw new ServiceError('resource-exhausted', 'Another checkout is being prepared. Please wait a moment and try again.')
      try {
        const state = await store.billingState(user.id), flags = parseCheckoutFlags(state.flags)
        const blocked = checkoutBlocked(state.entitlement.document, flags, state.activeSeats)
        if (blocked) throw new ServiceError('failed-precondition', blocked)
        const customerId = await customer(user)
        const price = (await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP[plan]], active: true, limit: 1 })).data[0]
        if (!isConfiguredPrice(price, plan)) throw new ServiceError('unavailable', 'This plan is not configured for checkout yet')
        // Resolve open sessions before checking for payments. A session that completes during this check
        // either fails expiration or appears in the subsequent paid-state check.
        for await (const earlier of stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 })) {
          try { await stripe.checkout.sessions.expire(earlier.id) } catch {
            throw new ServiceError('unavailable', 'Your previous checkout is still resolving. Please wait a moment and try again.')
          }
        }
        const subscriptions = []
        for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) subscriptions.push(subscription)
        const live = liveSubscriptionState(subscriptions)
        if (live === 'access') throw new ServiceError('failed-precondition', 'Pro is already active')
        if (live === 'on_hold') throw new ServiceError('failed-precondition', 'Your Pro subscription is on hold. Use Manage billing to pay the open invoice, or contact support.')
        const session = await stripe.checkout.sessions.create(checkoutSessionParams({ plan, uid: user.id, customer: customerId, priceId: price.id, hostingOrigin: origin, automaticTax: flags.automaticTax, termsConsent: flags.termsConsent, now: now() }))
        if (!session.url) throw new ServiceError('unavailable', 'Stripe returned no checkout URL')
        return { url: session.url }
      } finally {
        await store.releaseCheckout(user.id, lease).catch(() => log('checkout_lease_release_failed', { uid: user.id }))
      }
    },
    async portal(user: AccountUser) {
      if (!user.id) throw new ServiceError('unauthenticated', 'Sign in first')
      const customerId = await store.customer(user.id)
      if (!customerId) throw new ServiceError('failed-precondition', 'No billing account yet')
      const configuration = pickPortalConfiguration((await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data)
      if (!configuration) throw new ServiceError('failed-precondition', 'Billing portal is not set up yet')
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, configuration, return_url: `${origin}/activate` })
      return { url: session.url }
    },
    /** The Edge entry point MUST verify the raw Stripe signature before calling this method. */
    async processWebhook(event: Stripe.Event) {
      if (event.livemode !== deps.expectLivemode) throw new ServiceError('invalid-argument', 'Stripe event mode does not match this deployment')
      const lease = owner(), claim = await store.claimEvent(event.id, event.type, lease)
      if (claim === 'processed') return { received: true, duplicate: true }
      if (claim === 'inflight') throw new ServiceError('unavailable', 'Payment event is already being processed; retry')
      try {
        if (event.type === 'invoice.finalization_failed') log('invoice_finalization_failed', { id: event.id, invoice: event.data.object.id })
        const raw = await normalizeStripeEvent(event, id => stripe.subscriptions.retrieve(id))
        const normalized = raw && (raw.kind !== 'byok_purchase' || await isLegacyByokCheckout(raw.checkoutSessionId))
          ? await bindPaymentState(raw, stripe) : null
        if (normalized) {
          const uid = await resolveUid(normalized)
          if (uid) {
            await apply(uid, normalized, { id: event.id, owner: lease })
            if (['refund', 'dispute', 'fraud_warning'].includes(normalized.kind)) log('stripe_revocation_review', { uid, kind: normalized.kind })
            return { received: true, outcome: 'applied' }
          }
        }
        const outcome = normalized ? 'unknown_uid' : 'ignored'
        if (!(await store.ignoreEvent(event.id, lease, outcome))) throw new ServiceError('unavailable', 'Payment event ownership changed; retry')
        return { received: true, outcome }
      } catch (error) {
        await store.releaseEvent(event.id, lease).catch(() => log('stripe_claim_release_failed', { id: event.id }))
        throw error
      }
    },
    /** Root's cron route must authenticate its caller separately; this method is not a public endpoint. */
    async reconcile() {
      let after: string | undefined, checked = 0, failed = 0
      for (;;) {
        const rows = await store.reconcilePage(after)
        for (const row of rows) {
          checked++
          try {
            if (row.document.pro) await apply(row.uid, normalizeSubscription(await stripe.subscriptions.retrieve(row.document.pro.subscriptionId)))
          } catch { failed++; log('reconcile_failed', { uid: row.uid }) }
        }
        if (rows.length < 200) break
        after = rows.at(-1)!.uid
      }
      return { checked, failed }
    }
  }
}
