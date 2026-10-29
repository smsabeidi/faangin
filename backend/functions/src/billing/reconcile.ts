import * as logger from 'firebase-functions/logger'
import { onSchedule } from 'firebase-functions/scheduler'
import { db } from '../admin.js'
import { STRIPE_WEBHOOK_KEY } from '../config.js'
import type { Entitlement } from '../entitlements.js'
import { normalizeSubscription } from './fulfill.js'
import { makeStripe } from './stripe-client.js'
import { applyToUid } from './webhook.js'

/** Re-reads every live Pro subscription from Stripe so a missed webhook is never permanent. */
export async function reconcileAll(): Promise<{ checked: number; failed: number }> {
  const stripe = makeStripe(STRIPE_WEBHOOK_KEY.value())
  const snap = await db.collection('entitlements').where('plan', '==', 'pro').get()
  let checked = 0
  let failed = 0
  for (const doc of snap.docs) {
    const entitlement = doc.data() as Entitlement
    if (!entitlement.pro || (entitlement.status !== 'active' && entitlement.status !== 'past_due')) continue
    checked++
    try {
      const subscription = await stripe.subscriptions.retrieve(entitlement.pro.subscriptionId)
      await applyToUid(doc.id, normalizeSubscription(subscription), Date.now())
    } catch (err) {
      failed++
      logger.error('reconcile: subscription failed', { uid: doc.id, subscriptionId: entitlement.pro.subscriptionId, err })
    }
  }
  logger.info('reconcile: done', { checked, failed })
  return { checked, failed }
}

export const reconcileEntitlements = onSchedule({ schedule: 'every 24 hours', secrets: [STRIPE_WEBHOOK_KEY] }, async () => {
  await reconcileAll()
})
