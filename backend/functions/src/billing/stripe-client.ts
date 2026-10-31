import Stripe from 'stripe'
import { STRIPE_API_BASE } from '../config.js'

/** One Stripe client per key. STRIPE_API_BASE (tests only) points the SDK at a local fake over plain HTTP. */
export function makeStripe(key: string): Stripe {
  const config: Stripe.StripeConfig = { maxNetworkRetries: 2, timeout: 10_000 }
  if (STRIPE_API_BASE) {
    const base = new URL(STRIPE_API_BASE)
    config.host = base.hostname
    config.port = base.port || 80
    config.protocol = 'http'
  }
  return new Stripe(key, config)
}
