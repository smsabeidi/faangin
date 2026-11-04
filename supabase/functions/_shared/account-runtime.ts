import Stripe from 'npm:stripe@23.0.1'
import { createAccountService, type AccountAuth, type AccountUser } from '../../../backend/supabase/account-service.ts'
import { createBillingService } from '../../../backend/supabase/billing-service.ts'
import { ServiceError } from '../../../backend/supabase/errors.ts'
import { SupabaseStore, type RpcClient } from '../../../backend/supabase/store.ts'
import { resolveSupabaseServerKey } from '../../../backend/gateway/src/supabase-server-key.ts'

export type Environment = { get(name: string): string | undefined }
export interface RuntimeOptions { env?: Environment; fetcher?: typeof fetch }
const fetchTimeoutMs = 20_000
function namedKey(env: Environment, plural: string, singular: string, legacy: string): string {
  const raw = env.get(plural)
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>
      const value = typeof keys.default === 'string' ? keys.default : Object.values(keys).find(item => typeof item === 'string')
      if (typeof value === 'string' && value) return value
    } catch { /* fall through to the single-key forms */ }
  }
  return env.get(singular) || env.get(legacy) || ''
}
export function serverKey(env: Environment): string { return resolveSupabaseServerKey(env, 'account') ?? '' }
export function publishableKey(env: Environment): string { return namedKey(env, 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY') }
export function serviceHeaders(key: string): Record<string, string> {
  // Opaque keys are API keys, never user bearer JWTs. Legacy JWT keys retain their old header compatibility.
  return { apikey: key, 'content-type': 'application/json', ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) }
}
export class SupabaseRpcClient implements RpcClient {
  constructor(private readonly url: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  async rpc(name: string, args: Record<string, unknown> = {}) {
    try {
      const response = await this.fetcher(`${this.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: serviceHeaders(this.key), body: JSON.stringify(args), signal: AbortSignal.timeout(fetchTimeoutMs) })
      const body = await response.json()
      return response.ok ? { data: body, error: null } : { data: null, error: { code: typeof body.code === 'string' ? body.code : undefined, message: typeof body.message === 'string' ? body.message : undefined } }
    } catch { return { data: null, error: { code: 'TRANSPORT', message: 'Account database unavailable' } } }
  }
}
export function createRuntime(options: RuntimeOptions = {}) {
  const env = options.env ?? Deno.env, fetcher = options.fetcher ?? fetch
  const url = (env.get('SUPABASE_URL') || '').replace(/\/$/, ''), secret = serverKey(env), publicKey = publishableKey(env)
  if (!url || !secret) throw new ServiceError('unavailable', 'The account service is not configured yet')
  const stripeMode = env.get('STRIPE_EXPECT_LIVEMODE')
  const expectLivemode = stripeMode === 'true'
  const stripeKey = (name: 'STRIPE_CHECKOUT_KEY' | 'STRIPE_WEBHOOK_KEY') => {
    const key = env.get(name)
    const match = /^rk_(test|live)_[A-Za-z0-9_-]+$/.exec(key ?? '')
    if (stripeMode !== undefined && stripeMode !== 'true' && stripeMode !== 'false') return undefined
    return match?.[1] === (expectLivemode ? 'live' : 'test') ? key : undefined
  }
  const checkoutKey = stripeKey('STRIPE_CHECKOUT_KEY'), webhookKey = stripeKey('STRIPE_WEBHOOK_KEY')
  const billingConfigured = !!checkoutKey && !!webhookKey && checkoutKey !== webhookKey && !!env.get('STRIPE_WEBHOOK_SECRET')
  const rpc = new SupabaseRpcClient(url, secret, fetcher)
  const store = new SupabaseStore(rpc)
  const asUser = (body: Record<string, unknown>): AccountUser => {
    const raw = body.user && typeof body.user === 'object' ? body.user as Record<string, unknown> : body
    if (typeof raw.id !== 'string' || !raw.id || raw.is_anonymous === true) throw new ServiceError('unauthenticated', 'Sign in with a permanent account')
    return { id: raw.id, ...(typeof raw.email === 'string' ? { email: raw.email } : {}), emailVerified: typeof raw.email_confirmed_at === 'string' && !!raw.email_confirmed_at }
  }
  const auth: AccountAuth = {
    async getUserById(uid) {
      const response = await fetcher(`${url}/auth/v1/admin/users/${encodeURIComponent(uid)}`, { headers: serviceHeaders(secret), signal: AbortSignal.timeout(fetchTimeoutMs) })
      if (!response.ok) throw new ServiceError('unavailable', 'The approved account could not be loaded')
      return asUser(await response.json())
    },
    async generateMagicLink(email) {
      const response = await fetcher(`${url}/auth/v1/admin/generate_link`, { method: 'POST', headers: serviceHeaders(secret), body: JSON.stringify({ type: 'magiclink', email }), signal: AbortSignal.timeout(fetchTimeoutMs) })
      if (!response.ok) throw new ServiceError('unavailable', 'Device sign-in could not be prepared. Please retry.')
      const body = await response.json(), properties = body.properties ?? body
      const user = asUser(body)
      if (typeof properties.hashed_token !== 'string' || !properties.hashed_token) throw new ServiceError('unavailable', 'Device sign-in returned no confirmation token')
      return { tokenHash: properties.hashed_token, uid: user.id }
    }
  }
  return {
    env, url, store, authConfigured: !!publicKey, billingConfigured,
    async claimReconcileDispatch(nonce: string, timestamp: number): Promise<boolean> {
      const result = await rpc.rpc('faangin_reconcile_dispatch_claim', { p_nonce: nonce, p_timestamp: timestamp })
      if (result.error || typeof result.data !== 'boolean') throw new ServiceError('unavailable', 'The reconciliation dispatch could not be verified')
      return result.data
    },
    account: createAccountService({ store, auth, signingKey: env.get('LICENSE_SIGNING_KEY') || '', activationUrl: env.get('FAANGIN_ACTIVATION_URL') || `${url}/functions/v1/billing-return/activate` }),
    billing(operation: 'checkout' | 'portal' | 'webhook') {
      const key = operation === 'webhook' ? webhookKey : checkoutKey
      if (!key || (operation === 'webhook' && checkoutKey === webhookKey) || (operation === 'checkout' && !billingConfigured)) {
        throw new ServiceError('unavailable', 'Billing is not configured yet')
      }
      const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2, timeout: 10_000 })
      const service = createBillingService({ store, stripe, hostingOrigin: env.get('FAANGIN_HOSTING_ORIGIN') || `${url}/functions/v1/billing-return`, expectLivemode, log: event => console.log(JSON.stringify({ event })) })
      return { stripe, service }
    },
    async user(request: Request): Promise<AccountUser> {
      const header = request.headers.get('authorization') ?? ''
      if (!/^Bearer\s+\S+$/i.test(header) || !publicKey) throw new ServiceError('unauthenticated', 'Sign in first')
      const response = await fetcher(`${url}/auth/v1/user`, { headers: { apikey: publicKey, authorization: header }, signal: AbortSignal.timeout(fetchTimeoutMs) })
      if (!response.ok) throw new ServiceError('unauthenticated', 'Your sign-in session has expired. Sign in again.')
      return asUser(await response.json())
    }
  }
}
export type AccountRuntime = ReturnType<typeof createRuntime>
