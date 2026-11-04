/** Supabase-only gateway adapters. No Firebase SDK or provider credentials reach callers. */
import type { AuthDeps, Entitlement, Flags } from './auth.js'
import { DEFAULT_FLAGS, EMPTY_ENTITLEMENT } from './auth.js'
import { ALLOWANCES, BACKSTOP_USD, MAX_CONCURRENT_ANSWERS } from './config.js'
import { cap, type AnswerDecision } from './meter.js'
import type { AnswerAdmission, LeaseKind, Store, Usage, UsageDelta } from './store.js'

export type GatewayRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
const emptyUsage = (): Usage => ({ audioSeconds: 0, handsfree: 0, fast: 0, smart: 0, spendUsd: 0, days: {} })
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export class SupabaseGatewayError extends Error {
  constructor(readonly status: number, readonly operation: string) { super(`Supabase ${operation} failed`); this.name = 'SupabaseGatewayError' }
}

/** RPC boundaries carry JSON documents; SQL serializes all mutations with the same uid transaction lock. */
export class SupabaseStore implements Store {
  constructor(private readonly rpc: GatewayRpc) {}
  async read(uid: string, periodKey: string): Promise<Usage> {
    const value = await this.rpc('faangin_gateway_usage', { p_uid: uid, p_period: periodKey })
    if (!record(value)) throw new SupabaseGatewayError(502, 'usage')
    const usage = { ...emptyUsage(), ...value } as Usage
    for (const key of ['audioSeconds', 'handsfree', 'fast', 'smart', 'spendUsd'] as const) if (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0) throw new SupabaseGatewayError(502, 'usage')
    if (!record(usage.days)) throw new SupabaseGatewayError(502, 'usage')
    return usage
  }
  async increment(uid: string, periodKey: string, day: string, delta: UsageDelta): Promise<void> {
    await this.rpc('faangin_gateway_increment', { p_uid: uid, p_period: periodKey, p_day: day, p_delta: delta })
  }
  async admitAnswer(uid: string, periodKey: string, input: AnswerAdmission): Promise<AnswerDecision> {
    const value = await this.rpc('faangin_gateway_admit_answer', { p_uid: uid, p_period: periodKey, p_input: { ...input, limits: {
      fast: cap(ALLOWANCES.fast, input.ramped), smart: cap(ALLOWANCES.smart, input.ramped), handsfree: cap(ALLOWANCES.handsfree, input.ramped),
      monthUsd: BACKSTOP_USD.month, dayUsd: BACKSTOP_USD.day, maxAnswers: MAX_CONCURRENT_ANSWERS
    } } })
    if (!record(value)) throw new SupabaseGatewayError(502, 'admission')
    if (value.kind === 'run' && ['fast', 'smart', 'handsfree'].includes(String(value.mode)) && typeof value.downgraded === 'boolean') return value as AnswerDecision
    if (['concurrency', 'skip', 'backstop'].includes(String(value.kind)) || (value.kind === 'exhausted' && value.allowance === 'fast')) return value as AnswerDecision
    throw new SupabaseGatewayError(502, 'admission')
  }
  async claimLease(uid: string, kind: LeaseKind, id: string, now: number, expiresAt: number, limit: number, renewOnly = false): Promise<boolean> {
    const value = await this.rpc('faangin_gateway_claim_lease', { p_uid: uid, p_kind: kind, p_id: id, p_now: now, p_expires_at: expiresAt, p_limit: limit, p_renew_only: renewOnly })
    if (typeof value !== 'boolean') throw new SupabaseGatewayError(502, 'lease')
    return value
  }
  async releaseLease(uid: string, kind: LeaseKind, id: string): Promise<void> {
    await this.rpc('faangin_gateway_release_lease', { p_uid: uid, p_kind: kind, p_id: id })
  }
  async claimGrace(uid: string, periodKey: string, now: number): Promise<number> {
    const value = await this.rpc('faangin_gateway_claim_grace', { p_uid: uid, p_period: periodKey, p_now: now })
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SupabaseGatewayError(502, 'grace')
    return value
  }
}

export function createSupabaseBackend(options: { url: string; serviceKey: string; publishableKey: string; fetch?: typeof fetch; timeoutMs?: number }): AuthDeps & { store: SupabaseStore; rpc: GatewayRpc } {
  const base = new URL(options.url)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) throw new Error('Invalid Supabase project URL')
  if (!options.serviceKey || !options.publishableKey) throw new Error('Supabase server and publishable keys are required')
  const fetcher = options.fetch ?? globalThis.fetch
  async function request(path: string, init: RequestInit, operation: string): Promise<unknown> {
    let response: Response
    try { response = await fetcher(new URL(path, base), { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) }) }
    catch { throw new SupabaseGatewayError(503, operation) }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new SupabaseGatewayError(response.status, operation) }
    try { const text = await response.text(); return text ? JSON.parse(text) : null }
    catch { throw new SupabaseGatewayError(502, operation) }
  }
  const rpc: GatewayRpc = (name, args) => request(`/rest/v1/rpc/${name}`, { method: 'POST', headers: {
    apikey: options.serviceKey, 'content-type': 'application/json',
    ...(options.serviceKey.startsWith('eyJ') ? { authorization: `Bearer ${options.serviceKey}` } : {})
  }, body: JSON.stringify(args) }, name)
  return {
    rpc, store: new SupabaseStore(rpc),
    async verifyIdToken(token) {
      if (!token || /[\r\n]/.test(token)) throw new SupabaseGatewayError(401, 'auth')
      const value = await request('/auth/v1/user', { headers: { apikey: options.publishableKey, authorization: `Bearer ${token}` } }, 'auth')
      if (!record(value) || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)) throw new SupabaseGatewayError(401, 'auth')
      return { uid: value.id }
    },
    async loadEntitlement(uid) {
      const value = await rpc('faangin_gateway_entitlement', { p_uid: uid })
      if (value === null) return { ...EMPTY_ENTITLEMENT }
      if (!record(value) || !['none', 'byok', 'pro'].includes(String(value.plan)) || !['active', 'past_due', 'canceled', 'revoked'].includes(String(value.status))) throw new SupabaseGatewayError(502, 'entitlement')
      return value as unknown as Entitlement
    },
    async loadFlags() {
      const value = await rpc('faangin_gateway_flags', {})
      if (value !== null && !record(value)) throw new SupabaseGatewayError(502, 'flags')
      const flags = { ...DEFAULT_FLAGS, ...(value ?? {}) } as Flags
      return { ...flags, blockedUids: Array.isArray(flags.blockedUids) ? flags.blockedUids.filter((uid): uid is string => typeof uid === 'string') : [],
        proSessionsOpen: flags.proSessionsOpen === true, smartToFast: flags.smartToFast === true, handsfreeOff: flags.handsfreeOff === true, transcriptionOff: flags.transcriptionOff === true }
    }
  }
}
