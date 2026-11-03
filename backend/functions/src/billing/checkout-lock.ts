import { randomUUID } from 'node:crypto'
import { HttpsError } from 'firebase-functions/https'
import * as logger from 'firebase-functions/logger'
import { db } from '../admin.js'

// Longer than createCheckoutSession's 120-second timeout. A crashed instance cannot retain the lock forever.
const LEASE_MS = 5 * 60 * 1000

/** Stripe requests cannot run inside a retrying transaction. Lease the buyer before any customer/session work. */
export async function withCheckoutLock<T>(uid: string, action: () => Promise<T>): Promise<T> {
  const ref = db.collection('checkoutLocks').doc(uid)
  const owner = randomUUID()
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data()
    if (current && Number(current.expiresAt) > Date.now()) {
      throw new HttpsError('resource-exhausted', 'Another checkout is being prepared. Please wait a moment and try again.')
    }
    tx.set(ref, { owner, expiresAt: Date.now() + LEASE_MS })
  })
  try {
    return await action()
  } finally {
    // Failure to release must not hide a successfully created Checkout URL. The lease expires on its own.
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).data()?.owner === owner) tx.delete(ref)
    }).catch((err: unknown) => logger.error('createCheckoutSession: checkout lease release failed', { uid, err }))
  }
}
