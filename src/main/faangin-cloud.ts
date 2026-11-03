// Faangin cloud client for the Electron main process. Self-contained: node:crypto, the global fetch and `ws`.
// Copy this file into the app as src/main/faangin-cloud.ts (see client/README.md). No other dependency.
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import WebSocket, { type ClientOptions } from 'ws'

/**
 * Public keys (base64 SPKI DER) allowed to sign licenses: the current one first, the next one during a rotation.
 * TODO: paste the key that `node scripts/gen-license-key.mjs` prints on stderr ("PUBLIC KEY ...") for the
 * environment this build talks to. The private half goes to Supabase Edge secrets only (LICENSE_SIGNING_KEY).
 */
export const LICENSE_PUBLIC_KEYS: readonly string[] = [
  'REPLACE_WITH_CURRENT_LICENSE_PUBLIC_KEY'
]

/** Any non-2xx answer. `code` is the HttpsError status (e.g. FAILED_PRECONDITION) or the account API's error code. */
export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message)
    this.name = 'CloudError'
  }
}

type ErrorBody = { error?: string | { status?: string; code?: string | number; message?: string }; code?: string; error_code?: string; error_description?: string; msg?: string; message?: string }

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(20_000)
  const response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  const text = await response.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON; handled below */ }
  if (response.ok) return body as T
  const error = (body as ErrorBody | null)?.error
  if (typeof error === 'string') throw new CloudError((body as ErrorBody).error_code ?? (body as ErrorBody).code ?? error, (body as ErrorBody).error_description ?? (body as ErrorBody).msg ?? error, response.status)
  throw new CloudError(error?.status ?? String(error?.code ?? (body as ErrorBody | null)?.error_code ?? (body as ErrorBody | null)?.code ?? `http_${response.status}`), error?.message ?? (body as ErrorBody | null)?.msg ?? (body as ErrorBody | null)?.message ?? `HTTP ${response.status}`, response.status)
}

function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  return request<T>(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
}

// ---------------------------------------------------------------------------------------------------------------
// Device sign-in (deviceCodeStart / deviceCodePoll are plain HTTP functions)

export interface DeviceInfo { deviceId: string; deviceName: string }
export interface DeviceSignInStart { deviceCode: string; userCode: string; expiresIn: number; interval: number }
export type DeviceSignInPoll =
  | { status: 'pending' }
  | { status: 'approved'; tokenHash: string; uid: string }
  | { status: 'expired' }
export type DeviceSignInResult = Exclude<DeviceSignInPoll, { status: 'pending' }> | { status: 'aborted' }

/** Step 1: ask for a code. Show `userCode` (as ABCD-EFGH) in the main-owned local activation page. */
export function startDeviceSignIn(functionsBase: string, device: DeviceInfo, publishableKey: string): Promise<DeviceSignInStart> {
  return postJson(`${functionsBase}/deviceCodeStart`, device, { apikey: publishableKey })
}

/** One poll. */
export function pollDeviceSignIn(functionsBase: string, deviceCode: string, options: { signal?: AbortSignal; publishableKey?: string } = {}): Promise<DeviceSignInPoll> {
  return postJson(`${functionsBase}/deviceCodePoll`, { deviceCode }, { ...(options.publishableKey ? { apikey: options.publishableKey } : {}) }, options.signal)
}

/** Polls every `interval` seconds until approved, expired (server says so or `expiresIn` passed) or `signal` aborts. */
export async function waitForDeviceSignIn(
  functionsBase: string,
  start: Pick<DeviceSignInStart, 'deviceCode' | 'interval' | 'expiresIn'>,
  options: { signal?: AbortSignal; publishableKey?: string } = {}
): Promise<DeviceSignInResult> {
  const deadline = Date.now() + start.expiresIn * 1000
  for (;;) {
    if (options.signal?.aborted) return { status: 'aborted' }
    if (Date.now() >= deadline) return { status: 'expired' }
    let poll: DeviceSignInPoll
    try { poll = await pollDeviceSignIn(functionsBase, start.deviceCode, options) } catch (error) {
      if (options.signal?.aborted) return { status: 'aborted' }
      throw error
    }
    if (poll.status !== 'pending') return poll
    if (!(await sleep(start.interval * 1000, options.signal))) return { status: 'aborted' }
  }
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false)
    const onAbort = () => { clearTimeout(timer); resolve(false) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true) }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Supabase Auth REST (no Auth SDK or credentials in the renderer)

export interface AuthSession { uid: string; accessToken: string; refreshToken: string; expiresAt: number }
interface SupabaseSession { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; expires_at?: unknown; user?: { id?: unknown } }

function authSession(body: SupabaseSession): AuthSession {
  if (!body || typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token || typeof body.user?.id !== 'string' || !body.user.id) throw new CloudError('INVALID_RESPONSE', 'The account service returned an invalid session.')
  const expiresAt = typeof body.expires_at === 'number' ? body.expires_at * 1000 : Date.now() + Number(body.expires_in) * 1000
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new CloudError('INVALID_RESPONSE', 'The account service returned an expired session.')
  return { uid: body.user.id, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt }
}

/** Exchanges the one-use device approval for a separate desktop session, then verifies its user online. */
export async function exchangeDeviceToken(supabaseUrl: string, publishableKey: string, tokenHash: string, expectedUid: string): Promise<AuthSession> {
  const session = authSession(await postJson<SupabaseSession>(`${supabaseUrl}/auth/v1/verify`, { token_hash: tokenHash, type: 'email' }, { apikey: publishableKey }))
  const user = await request<{ id?: unknown }>(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: publishableKey, authorization: `Bearer ${session.accessToken}` } })
  if (session.uid !== expectedUid || user?.id !== expectedUid) throw new CloudError('UNAUTHENTICATED', 'The approved account did not match the desktop session.', 401)
  return session
}

/** Refresh tokens rotate. Persist the returned token atomically before dispatching another refresh. */
export async function refreshAuthSession(supabaseUrl: string, publishableKey: string, refreshToken: string): Promise<AuthSession> {
  return authSession(await postJson<SupabaseSession>(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { refresh_token: refreshToken }, { apikey: publishableKey }))
}

/** Revokes this desktop session only; other browsers and Macs stay signed in. */
export async function revokeAuthSession(supabaseUrl: string, publishableKey: string, accessToken: string): Promise<void> {
  await postJson(`${supabaseUrl}/auth/v1/logout?scope=local`, {}, { apikey: publishableKey, authorization: `Bearer ${accessToken}` })
}

/** Keeps one main-process session fresh; the getter is synchronous for WebSocket admission. */
export function accessTokenSource(supabaseUrl: string, publishableKey: string, session: AuthSession, options: { onRefresh?: (session: AuthSession) => void | Promise<void> } = {}) {
  let current = session
  let pending: Promise<AuthSession> | null = null
  const refresh = (): Promise<AuthSession> => {
    pending ??= refreshAuthSession(supabaseUrl, publishableKey, current.refreshToken)
      .then(async next => {
        if (next.uid !== current.uid) throw new CloudError('UNAUTHENTICATED', 'The refreshed account did not match this session.', 401)
        await options.onRefresh?.(next); current = next; return next
      })
      .finally(() => { pending = null })
    return pending
  }
  return {
    get: () => current.accessToken,
    session: () => current,
    refresh,
    ensureFresh: async (): Promise<string> => {
      if (current.expiresAt - Date.now() < 5 * 60_000) await refresh()
      return current.accessToken
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Callables

/** Account Edge API: POST { data } with the access token and public apikey; unwraps result or throws a stable CloudError. */
export async function callFunction<T>(functionsBase: string, name: string, data: unknown, accessToken: string, publishableKey: string): Promise<T> {
  const body = await postJson<{ result?: T }>(`${functionsBase}/${name}`, { data }, { authorization: `Bearer ${accessToken}`, apikey: publishableKey })
  return body.result as T
}

export interface LicenseResponse { token: string; plan: 'byok' | 'pro'; status: string; expiresAt: number; graceUntil: number }

/** issueLicense: FAILED_PRECONDITION when nothing is bought, RESOURCE_EXHAUSTED when a new device is over the cap. */
export function fetchLicense(functionsBase: string, accessToken: string, device: DeviceInfo, publishableKey: string): Promise<LicenseResponse> {
  return callFunction<LicenseResponse>(functionsBase, 'issueLicense', device, accessToken, publishableKey)
}

// ---------------------------------------------------------------------------------------------------------------
// License verification (offline)

export interface LicensePayload {
  v: 1
  uid: string
  plan: 'byok' | 'pro'
  status: string
  iat: number
  exp: number
  grace: number
  deviceId: string
  periodEnd?: number
  rampUntil?: number
  cancelAtPeriodEnd?: boolean
}
/** `inGrace`: past `exp` but before `grace`; the app should refresh the license and may warn, but keeps working. */
export type VerifiedLicense = LicensePayload & { inGrace: boolean }

/** Checks the Ed25519 signature and the time window. Returns the payload while `nowMs < grace`, else null. */
export function verifyLicense(token: string, publicKeyBase64: string, nowMs = Date.now()): VerifiedLicense | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null
    const payloadBytes = Buffer.from(parts[1], 'base64url')
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    if (!verifySignature(null, payloadBytes, key, Buffer.from(parts[2], 'base64url'))) return null
    const payload = JSON.parse(payloadBytes.toString('utf8')) as LicensePayload
    if (payload.v !== 1 || typeof payload.uid !== 'string' || !payload.uid || (payload.plan !== 'byok' && payload.plan !== 'pro')) return null
    if (payload.status !== 'active' && payload.status !== 'past_due') return null
    if (typeof payload.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.deviceId)) return null
    if (![nowMs, payload.iat, payload.exp, payload.grace].every(value => typeof value === 'number' && Number.isFinite(value))) return null
    if (payload.iat > nowMs + 5 * 60_000 || payload.exp <= payload.iat || payload.grace < payload.exp) return null
    if ([payload.periodEnd, payload.rampUntil].some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) return null
    if (payload.cancelAtPeriodEnd !== undefined && typeof payload.cancelAtPeriodEnd !== 'boolean') return null
    if (nowMs >= payload.grace) return null
    return { ...payload, inGrace: nowMs >= payload.exp }
  } catch {
    return null
  }
}

/** Tries every shipped key (current, then next) so a key rotation never locks a customer out. */
export function verifyLicenseWithKeys(token: string, nowMs = Date.now(), keys: readonly string[] = LICENSE_PUBLIC_KEYS): VerifiedLicense | null {
  for (const key of keys) {
    const verified = verifyLicense(token, key, nowMs)
    if (verified) return verified
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Pro transport: the app keeps calling api.openai.com; this sends those calls to the gateway with the Supabase access token.

const OPENAI_HTTP = 'https://api.openai.com'
const OPENAI_WS = 'wss://api.openai.com'

/** Pure. An OpenAI URL keeps its path and query on the gateway (wss → ws(s)); any other URL comes back unchanged. */
export function rewriteOpenAiUrl(url: string, gatewayBase: string): string {
  const base = gatewayBase.replace(/\/+$/, '')
  if (url.startsWith(`${OPENAI_HTTP}/`)) return base + url.slice(OPENAI_HTTP.length)
  if (url.startsWith(`${OPENAI_WS}/`)) return base.replace(/^http/, 'ws') + url.slice(OPENAI_WS.length)
  return url
}

/** Same shape as the app's InferenceTransport (src/main/inference.ts). */
export interface InferenceTransport {
  fetch: typeof globalThis.fetch
  createWebSocket: (url: string, options: ClientOptions) => WebSocket
}

/**
 * `getAccessToken` must be synchronous (WebSockets open synchronously): use `accessTokenSource(...).get` and call
 * `ensureFresh()` before starting an answer or a live session. Non-OpenAI URLs pass through untouched.
 */
export function proTransport(getAccessToken: () => string, gatewayBase: string, publishableKey?: string): InferenceTransport {
  return {
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const target = rewriteOpenAiUrl(url, gatewayBase)
      if (target === url) return globalThis.fetch(input, init)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('authorization', `Bearer ${getAccessToken()}`)
      if (publishableKey) headers.set('apikey', publishableKey)
      // Request inputs carry their method, stream, signal and options on the object, not in `init`.
      // Rebuild it against the gateway before applying overrides so a POST never becomes an empty GET.
      return input instanceof Request
        ? globalThis.fetch(new Request(target, input), { ...init, headers, redirect: 'error' })
        : globalThis.fetch(target, { ...init, headers, redirect: 'error' })
    },
    createWebSocket: (url, options) => {
      const target = rewriteOpenAiUrl(url, gatewayBase)
      if (target === url) return new WebSocket(url, options)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(options.headers ?? {})) if (name.toLowerCase() !== 'authorization' && (!publishableKey || name.toLowerCase() !== 'apikey')) headers[name] = value
      headers.Authorization = `Bearer ${getAccessToken()}`
      if (publishableKey) headers.apikey = publishableKey
      return new WebSocket(target, { ...options, headers })
    }
  }
}
