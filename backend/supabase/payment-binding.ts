import type Stripe from 'npm:stripe@23.0.1'
import type { NormalizedEvent } from './fulfill.ts'
import { ServiceError } from './errors.ts'

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id

/** Read current payment state and bind revocations to their actual subscription, never merely their customer. */
export async function bindPaymentState(event: NormalizedEvent, stripe: Stripe): Promise<NormalizedEvent> {
  if (event.kind === 'byok_purchase') {
    // A completely discounted Checkout can legitimately have no PaymentIntent.
    if (!event.paymentIntentId) return event
    let paid = false, revokedReason: 'refund' | 'dispute' | undefined
    for await (const charge of stripe.charges.list({ payment_intent: event.paymentIntentId, limit: 100 })) {
      if (!charge.paid || charge.status !== 'succeeded') continue
      if (event.customerId && id(charge.customer) !== event.customerId) throw new ServiceError('failed-precondition', 'Payment ownership does not match the purchase')
      paid = true
      if (charge.refunded) revokedReason = 'refund'
      else if (charge.disputed && !revokedReason) revokedReason = 'dispute'
    }
    if (!paid) throw new ServiceError('unavailable', 'The successful payment is not available yet; retry confirmation')
    return revokedReason ? { ...event, revokedReason } : event
  }
  if (!['refund', 'dispute', 'fraud_warning'].includes(event.kind) || (event.kind === 'refund' && !event.full)) return event
  if (event.kind !== 'refund' && event.kind !== 'dispute' && event.kind !== 'fraud_warning') return event
  let paymentIntentId = event.paymentIntentId, customerId = event.customerId
  if (!paymentIntentId && event.chargeId) {
    const charge = await stripe.charges.retrieve(event.chargeId)
    paymentIntentId = id(charge.payment_intent)
    customerId ??= id(charge.customer)
  }
  const subscriptions = new Set<string>()
  if (paymentIntentId) {
    for await (const payment of stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 100 })) {
      const invoiceId = id(payment.invoice)
      if (!invoiceId) continue
      const invoice = await stripe.invoices.retrieve(invoiceId)
      const subscription = id(invoice.parent?.subscription_details?.subscription)
      if (subscription) subscriptions.add(subscription)
    }
  }
  return { ...event, paymentIntentId, customerId, subscriptionIds: [...subscriptions] }
}
