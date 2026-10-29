// A tiny fake of the Stripe REST endpoints our functions call. Records every request so tests can assert what was sent.
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Stripe from 'stripe'

export interface RecordedRequest { method: string; path: string; query: URLSearchParams; body: Record<string, string>; headers: Record<string, string | string[] | undefined> }
/** Every request the fake received, oldest first. `body` is the decoded form, flat: e.g. body['metadata[uid]']. */
export const requests: RecordedRequest[] = []
/** Objects served by id; tests seed these. */
export const subscriptions = new Map<string, Record<string, unknown>>()
export const charges = new Map<string, Record<string, unknown>>()
/** Customer Portal configurations served by GET /v1/billing_portal/configurations; tests seed these. */
export const portalConfigurations: Array<Record<string, unknown>> = []
/** Checkout Sessions created through POST /v1/checkout/sessions, so list(status=open) and expire work. */
export const sessions = new Map<string, { id: string; customer: string; status: 'open' | 'expired' | 'complete' }>()
/** Ids of the customers actually created (an idempotent replay creates none), and the responses saved per Idempotency-Key. */
export const createdCustomers: string[] = []
/** Session ids whose expire call Stripe refuses (for example a session that was paid a moment ago). */
export const refuseExpire = new Set<string>()
const savedByIdempotencyKey = new Map<string, [number, unknown]>()

let counter = 0
const nextId = (prefix: string): string => `${prefix}_${++counter}`

function readWebhookSecret(): string {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.secret.local'), 'utf8')
    return text.match(/^STRIPE_WEBHOOK_SECRET=(.+)$/m)?.[1]?.trim() ?? 'whsec_test_fake_secret'
  } catch {
    return 'whsec_test_fake_secret'
  }
}
/** The emulator's webhook secret (functions/.secret.local, written by scripts/dev-secrets.mjs). */
export const WEBHOOK_SECRET = readWebhookSecret()

const signer = new Stripe('rk_test_fake_signer', { maxNetworkRetries: 0 })
export function signWebhook(payload: string, secret = WEBHOOK_SECRET): string {
  return signer.webhooks.generateTestHeaderString({ payload, secret })
}

export function fakeEvent(type: string, object: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return {
    id: nextId('evt_test'), object: 'event', api_version: '2026-09-30.endive', created: Math.floor(Date.now() / 1000),
    livemode: false, pending_webhooks: 1, request: null, type, data: { object }, ...overrides
  }
}

export interface FakeSubscriptionOptions {
  id?: string; status?: string; customer?: string; uid?: string; cancelAtPeriodEnd?: boolean
  periodStart?: number; periodEnd?: number; lookupKey?: string
  /** Old API shape: period on the subscription itself instead of its first item. */
  topLevelPeriod?: boolean
}

/** A subscription in the API 2025-03-31+ shape (period on items.data[0]), or the older top-level shape. */
export function fakeSubscription(options: FakeSubscriptionOptions = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  const start = options.periodStart ?? now
  const end = options.periodEnd ?? now + 30 * 86400
  const period = { current_period_start: start, current_period_end: end }
  const lookupKey = options.lookupKey ?? 'faangin_pro_monthly'
  return {
    id: options.id ?? 'sub_fake', object: 'subscription', status: options.status ?? 'active',
    customer: options.customer ?? 'cus_fake', cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    metadata: options.uid ? { uid: options.uid, plan: 'pro_monthly' } : {},
    start_date: start,
    ...(options.topLevelPeriod ? period : {}),
    items: {
      object: 'list',
      data: [{
        id: 'si_fake', object: 'subscription_item',
        ...(options.topLevelPeriod ? {} : period),
        price: { id: `price_${lookupKey}`, object: 'price', lookup_key: lookupKey }
      }]
    }
  }
}

function route(req: RecordedRequest): [number, unknown] {
  const { method, path, query, body } = req
  if (method === 'POST' && path === '/v1/customers') {
    const key = req.headers['idempotency-key']
    const saved = typeof key === 'string' ? savedByIdempotencyKey.get(key) : undefined
    if (saved) return saved // Stripe replays the saved response under the same key
    const created: [number, unknown] = [200, { id: nextId('cus_fake'), object: 'customer', email: body.email ?? null, metadata: { uid: body['metadata[uid]'] } }]
    createdCustomers.push((created[1] as { id: string }).id)
    if (typeof key === 'string') savedByIdempotencyKey.set(key, created)
    return created
  }
  if (method === 'GET' && path === '/v1/prices') {
    const keys = [...query].filter(([key]) => key.startsWith('lookup_keys')).map(([, value]) => value)
    return [200, { object: 'list', data: keys.map((key) => ({ id: `price_${key}`, object: 'price', lookup_key: key, active: true })) }]
  }
  if (method === 'POST' && path === '/v1/checkout/sessions') {
    const id = nextId('cs_test')
    sessions.set(id, { id, customer: body.customer, status: 'open' })
    return [200, {
      id, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/${id}`, mode: body.mode, customer: body.customer,
      client_reference_id: body.client_reference_id ?? null, metadata: { uid: body['metadata[uid]'], plan: body['metadata[plan]'] }
    }]
  }
  if (method === 'GET' && path === '/v1/billing_portal/configurations') {
    return [200, { object: 'list', data: portalConfigurations.filter((c) => query.get('active') !== 'true' || c.active !== false) }]
  }
  if (method === 'GET' && path === '/v1/checkout/sessions') {
    const customer = query.get('customer')
    const status = query.get('status')
    return [200, { object: 'list', data: [...sessions.values()].filter((s) => (!customer || s.customer === customer) && (!status || s.status === status)).map((s) => ({ ...s, object: 'checkout.session' })) }]
  }
  const expire = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)
  if (method === 'POST' && expire) {
    const session = sessions.get(expire[1])
    if (!session || session.status !== 'open' || refuseExpire.has(session.id)) return [400, { error: { type: 'invalid_request_error', message: 'Only Checkout Sessions with a status in [open] can be expired.' } }]
    session.status = 'expired'
    return [200, { id: expire[1], object: 'checkout.session', status: 'expired' }]
  }
  if (method === 'POST' && path === '/v1/billing_portal/sessions') {
    const id = nextId('bps_test')
    return [200, { id, object: 'billing_portal.session', url: `https://billing.stripe.test/p/session/${id}`, customer: body.customer, return_url: body.return_url }]
  }
  if (method === 'GET' && path === '/v1/subscriptions') {
    const customer = query.get('customer')
    return [200, { object: 'list', data: [...subscriptions.values()].filter((s) => !customer || s.customer === customer) }]
  }
  const subscription = path.match(/^\/v1\/subscriptions\/([^/]+)$/)
  if (method === 'GET' && subscription) return [200, subscriptions.get(subscription[1]) ?? fakeSubscription({ id: subscription[1] })]
  const charge = path.match(/^\/v1\/charges\/([^/]+)$/)
  if (method === 'GET' && charge) return [200, charges.get(charge[1]) ?? { id: charge[1], object: 'charge', customer: null }]
  return [404, { error: { type: 'invalid_request_error', message: `fake-stripe: no route for ${method} ${path}` } }]
}

let server: Server | undefined

export function start(port = 4242): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
      const recorded = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, headers: req.headers }
      requests.push(recorded)
      const [status, payload] = route(recorded)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve, reject) => server!.once('error', reject).listen(port, '127.0.0.1', () => resolve()))
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.closeAllConnections()
    server.close(() => resolve())
    server = undefined
  })
}

/** Forgets recorded requests and seeded objects. */
export function reset(): void {
  requests.length = 0
  subscriptions.clear()
  charges.clear()
  portalConfigurations.length = 0
  sessions.clear()
  createdCustomers.length = 0
  refuseExpire.clear()
  savedByIdempotencyKey.clear()
}
