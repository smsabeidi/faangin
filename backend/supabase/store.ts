import type { Entitlement } from './entitlements.ts'
import { ServiceError, type ErrorCode } from './errors.ts'

export interface RpcClient { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> }
export interface EntitlementState { document: Entitlement; version: number }
export interface BillingState { entitlement: EntitlementState; flags: Record<string, unknown>; activeSeats: number }
export type DeviceClaim = { status: 'pending' | 'expired' } | { status: 'claimed'; uid: string; deviceId: string; deviceName: string }
export type CommitResult = { kind: 'committed'; document: Entitlement; version: number } | { kind: 'conflict'; document: Entitlement; version: number } | { kind: 'processed' } | { kind: 'lost_claim' }
export interface AccountStore {
  startDevice(userCode: string, hash: string, deviceId: string, name: string): Promise<{ expiresAt: number }>
  approveDevice(userCode: string, uid: string): Promise<string>
  claimDevice(hash: string, owner: string): Promise<DeviceClaim>
  completeDevice(hash: string, owner: string): Promise<boolean>
  releaseDevice(hash: string, owner: string): Promise<void>
  touchDevice(uid: string, deviceId: string, name: string): Promise<EntitlementState & { now: number }>
}
export interface BillingStore {
  readEntitlement(uid: string): Promise<EntitlementState>
  billingState(uid: string): Promise<BillingState>
  customer(uid: string): Promise<string | null>
  customerUid(customer: string): Promise<string | null>
  bindCustomer(uid: string, customer: string, email?: string): Promise<string>
  claimCheckout(uid: string, owner: string): Promise<boolean>
  releaseCheckout(uid: string, owner: string): Promise<void>
  claimEvent(eventId: string, type: string, owner: string): Promise<'claimed' | 'processed' | 'inflight'>
  releaseEvent(eventId: string, owner: string): Promise<void>
  ignoreEvent(eventId: string, owner: string, outcome: string): Promise<boolean>
  commit(uid: string, version: number, document: Entitlement, event?: { id: string; owner: string }): Promise<CommitResult>
  reconcilePage(after?: string): Promise<Array<{ uid: string; document: Entitlement }>>
}
const CODES: Record<string, ErrorCode> = { FA400: 'invalid-argument', FA401: 'unauthenticated', FA404: 'not-found', FA409: 'failed-precondition', FA429: 'resource-exhausted', FA503: 'unavailable' }

/** Service-only PostgREST RPC adapter. The caller supplies a server client; no key or token is persisted here. */
export class SupabaseStore implements AccountStore, BillingStore {
  constructor(private readonly client: RpcClient) {}
  private async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(name, args)
    if (error) {
      const code = error.code && CODES[error.code]
      if (code) throw new ServiceError(code, error.message || 'Request could not be completed')
      if (error.code === '23505') throw new ServiceError('unavailable', 'A concurrent request changed this account. Please try again.')
      // Provider error details may contain database internals. Keep the client-facing error bounded and generic.
      throw new ServiceError('unavailable', 'The account database could not complete this request')
    }
    return data as T
  }
  startDevice(userCode: string, hash: string, deviceId: string, name: string) { return this.rpc<{ expiresAt: number }>('faangin_device_start', { p_user_code: userCode, p_hash: hash, p_device_id: deviceId, p_name: name }) }
  approveDevice(userCode: string, uid: string) { return this.rpc<string>('faangin_device_approve', { p_user_code: userCode, p_uid: uid }) }
  claimDevice(hash: string, owner: string) { return this.rpc<DeviceClaim>('faangin_device_claim', { p_hash: hash, p_owner: owner }) }
  completeDevice(hash: string, owner: string) { return this.rpc<boolean>('faangin_device_complete', { p_hash: hash, p_owner: owner }) }
  releaseDevice(hash: string, owner: string) { return this.rpc<void>('faangin_device_release', { p_hash: hash, p_owner: owner }) }
  touchDevice(uid: string, deviceId: string, name: string) { return this.rpc<EntitlementState & { now: number }>('faangin_device_touch', { p_uid: uid, p_device_id: deviceId, p_name: name }) }
  readEntitlement(uid: string) { return this.rpc<EntitlementState>('faangin_entitlement_read', { p_uid: uid }) }
  billingState(uid: string) { return this.rpc<BillingState>('faangin_billing_state', { p_uid: uid }) }
  customer(uid: string) { return this.rpc<string | null>('faangin_customer_get', { p_uid: uid }) }
  customerUid(customer: string) { return this.rpc<string | null>('faangin_customer_uid', { p_customer: customer }) }
  bindCustomer(uid: string, customer: string, email?: string) { return this.rpc<string>('faangin_customer_bind', { p_uid: uid, p_customer: customer, p_email: email ?? null }) }
  claimCheckout(uid: string, owner: string) { return this.rpc<boolean>('faangin_checkout_claim', { p_uid: uid, p_owner: owner }) }
  releaseCheckout(uid: string, owner: string) { return this.rpc<void>('faangin_checkout_release', { p_uid: uid, p_owner: owner }) }
  claimEvent(eventId: string, type: string, owner: string) { return this.rpc<'claimed' | 'processed' | 'inflight'>('faangin_stripe_claim', { p_event_id: eventId, p_type: type, p_owner: owner }) }
  releaseEvent(eventId: string, owner: string) { return this.rpc<void>('faangin_stripe_release', { p_event_id: eventId, p_owner: owner }) }
  ignoreEvent(eventId: string, owner: string, outcome: string) { return this.rpc<boolean>('faangin_stripe_ignore', { p_event_id: eventId, p_owner: owner, p_outcome: outcome }) }
  commit(uid: string, version: number, document: Entitlement, event?: { id: string; owner: string }) { return this.rpc<CommitResult>('faangin_stripe_commit', { p_uid: uid, p_version: version, p_document: document, p_event_id: event?.id ?? null, p_owner: event?.owner ?? null }) }
  reconcilePage(after?: string) { return this.rpc<Array<{ uid: string; document: Entitlement }>>('faangin_reconcile_list', { p_after: after ?? null }) }
}
