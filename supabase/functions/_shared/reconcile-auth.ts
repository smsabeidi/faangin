import { createHmac, timingSafeEqual } from 'node:crypto'
import { ServiceError } from '../../../backend/supabase/errors.ts'
import type { AccountRuntime } from './account-runtime.ts'

const denied = () => new ServiceError('unauthenticated', 'An internal reconciliation credential is required')
function equal(a: string, b: string): boolean {
  const encoder = new TextEncoder(), left = encoder.encode(a), right = encoder.encode(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Scheduled requests expose only a one-use, short-lived signature to pg_net's public queue. */
export async function authorizeReconciliation(service: AccountRuntime, request: Request, now = Date.now()): Promise<void> {
  const key = service.env.get('RECONCILE_SECRET')
  if (!key) throw new ServiceError('unavailable', 'Reconciliation is not configured')
  const manual = request.headers.get('x-faangin-reconcile-secret')
  // Kept for deliberate server-side/manual operations; cron never queues this shared credential.
  if (manual !== null) { if (!equal(key, manual)) throw denied(); return }
  const timestamp = request.headers.get('x-faangin-reconcile-time') ?? ''
  const nonce = request.headers.get('x-faangin-reconcile-nonce') ?? ''
  const received = request.headers.get('x-faangin-reconcile-signature') ?? ''
  if (!/^[1-9][0-9]{9}$/.test(timestamp) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(received)) throw denied()
  const seconds = Number(timestamp)
  if (Math.abs(Math.floor(now / 1000) - seconds) > 60) throw denied()
  const expected = createHmac('sha256', key).update(`faangin-reconcile\n${timestamp}\n${nonce}`, 'utf8').digest('hex')
  if (!equal(expected, received)) throw denied()
  // The private DB row must match this exact timestamp and nonce, and can be consumed once only.
  if (!(await service.claimReconcileDispatch(nonce, seconds))) throw denied()
}
