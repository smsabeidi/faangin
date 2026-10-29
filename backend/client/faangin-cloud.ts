// Faangin cloud client for the Electron main process. Self-contained: node:crypto, the global fetch and `ws`.
// Copy this file into the app as src/main/faangin-cloud.ts (see client/README.md). No other dependency.
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import WebSocket, { type ClientOptions } from 'ws'

/**
 * Public keys (base64 SPKI DER) allowed to sign licenses: the current one first, the next one during a rotation.
 * TODO: paste the key that `node scripts/gen-license-key.mjs` prints on stderr ("PUBLIC KEY ...") for the
 * environment this build talks to. The private half goes to Secret Manager only (LICENSE_SIGNING_KEY).
 */
export const LICENSE_PUBLIC_KEYS: readonly string[] = [
  'REPLACE_WITH_CURRENT_LICENSE_PUBLIC_KEY'
]

export const IDENTITY_TOOLKIT_BASE = 'https://identitytoolkit.googleapis.com'
export const SECURE_TOKEN_BASE = 'https://securetoken.googleapis.com'
/** Auth emulator equivalents (pass as the `base` argument). */
export const EMULATOR_IDENTITY_TOOLKIT_BASE = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com'
export const EMULATOR_SECURE_TOKEN_BASE = 'http://127.0.0.1:9099/securetoken.googleapis.com'

/** Any non-2xx answer. `code` is the HttpsError status (e.g. FAILED_PRECONDITION) or the API's error code. */
export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message)
    this.name = 'CloudError'
  }
}

type ErrorBody = { error?: string | { status?: string; code?: string | number; message?: string } }

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON; handled below */ }
  if (response.ok) return body as T
  const error = (body as ErrorBody | null)?.error
  if (typeof error === 'string') throw new CloudError(error, error, response.status)
  throw new CloudError(error?.status ?? String(error?.code ?? `http_${response.status}`), error?.message ?? `HTTP ${response.status}`, response.status)
}

function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return request<T>(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

// ---------------------------------------------------------------------------------------------------------------
// Device sign-in (deviceCodeStart / deviceCodePoll are plain HTTP functions)

export interface DeviceInfo { deviceId: string; deviceName: string }
export interface DeviceSignInStart { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }
export type DeviceSignInPoll =
  | { status: 'pending' }
  | { status: 'approved'; customToken: string; uid: string }
  | { status: 'expired' }
export type DeviceSignInResult = Exclude<DeviceSignInPoll, { status: 'pending' }> | { status: 'aborted' }

/** Step 1: ask for a code. Show `userCode` (as ABCD-EFGH) and open `verificationUrl` in the browser. */
export function startDeviceSignIn(functionsBase: string, device: DeviceInfo): Promise<DeviceSignInStart> {
  return postJson(`${functionsBase}/deviceCodeStart`, device)
}

/** One poll. */
export function pollDeviceSignIn(functionsBase: string, deviceCode: string): Promise<DeviceSignInPoll> {
  return postJson(`${functionsBase}/deviceCodePoll`, { deviceCode })
}

/** Polls every `interval` seconds until approved, expired (server says so or `expiresIn` passed) or `signal` aborts. */
export async function waitForDeviceSignIn(
  functionsBase: string,
  start: Pick<DeviceSignInStart, 'deviceCode' | 'interval' | 'expiresIn'>,
  options: { signal?: AbortSignal } = {}
): Promise<DeviceSignInResult> {
  const deadline = Date.now() + start.expiresIn * 1000
  for (;;) {
    if (options.signal?.aborted) return { status: 'aborted' }
    if (Date.now() >= deadline) return { status: 'expired' }
    const poll = await pollDeviceSignIn(functionsBase, start.deviceCode)
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
// Firebase Auth REST (no SDK in the main process)

export interface AuthSession { uid: string; idToken: string; refreshToken: string; expiresAt: number }

function uidFromIdToken(idToken: string): string {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { user_id?: string; sub?: string }
  return payload.user_id ?? payload.sub ?? ''
}

/** Trades the custom token from device sign-in for an ID token + refresh token. Store the refresh token with safeStorage. */
export async function exchangeCustomToken(apiKey: string, customToken: string, base = IDENTITY_TOOLKIT_BASE): Promise<AuthSession> {
  const body = await postJson<{ idToken: string; refreshToken: string; expiresIn: string }>(
    `${base}/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    { token: customToken, returnSecureToken: true }
  )
  return { uid: uidFromIdToken(body.idToken), idToken: body.idToken, refreshToken: body.refreshToken, expiresAt: Date.now() + Number(body.expiresIn) * 1000 }
}

/** ID tokens last an hour; this gets a new one (and possibly a new refresh token, keep the returned one). */
export async function refreshIdToken(apiKey: string, refreshToken: string, base = SECURE_TOKEN_BASE): Promise<AuthSession> {
  const body = await request<{ id_token: string; refresh_token: string; expires_in: string; user_id: string }>(
    `${base}/v1/token?key=${encodeURIComponent(apiKey)}`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString() }
  )
  return { uid: body.user_id || uidFromIdToken(body.id_token), idToken: body.id_token, refreshToken: body.refresh_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 }
}

/** Keeps a session fresh: `get()` is synchronous for proTransport; call `ensureFresh()` before a request or session. */
export function idTokenSource(apiKey: string, session: AuthSession, options: { base?: string; onRefresh?: (session: AuthSession) => void } = {}) {
  let current = session
  let pending: Promise<AuthSession> | null = null
  const refresh = (): Promise<AuthSession> => {
    pending ??= refreshIdToken(apiKey, current.refreshToken, options.base)
      .then(next => { current = next; options.onRefresh?.(next); return next })
      .finally(() => { pending = null })
    return pending
  }
  return {
    get: () => current.idToken,
    session: () => current,
    refresh,
    ensureFresh: async (): Promise<string> => {
      if (current.expiresAt - Date.now() < 5 * 60_000) await refresh()
      return current.idToken
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Callables

/** onCall protocol: POST { data } with the ID token; returns `result` or throws CloudError with the HttpsError status. */
export async function callFunction<T>(functionsBase: string, name: string, data: unknown, idToken: string): Promise<T> {
  const body = await postJson<{ result?: T }>(`${functionsBase}/${name}`, { data }, { authorization: `Bearer ${idToken}` })
  return body.result as T
}

export interface LicenseResponse { token: string; plan: 'byok' | 'pro'; status: string; expiresAt: number; graceUntil: number }

/** issueLicense: FAILED_PRECONDITION when nothing is bought, RESOURCE_EXHAUSTED when a new device is over the cap. */
export function fetchLicense(functionsBase: string, idToken: string, device: DeviceInfo): Promise<LicenseResponse> {
  return callFunction<LicenseResponse>(functionsBase, 'issueLicense', device, idToken)
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
    if (payload.v !== 1 || typeof payload.uid !== 'string' || typeof payload.exp !== 'number' || typeof payload.grace !== 'number') return null
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
// Pro transport: the app keeps calling api.openai.com; this sends those calls to the gateway with the Firebase ID token.

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
 * `getIdToken` must be synchronous (WebSockets open synchronously): use `idTokenSource(...).get` and call
 * `ensureFresh()` before starting an answer or a live session. Non-OpenAI URLs pass through untouched.
 */
export function proTransport(getIdToken: () => string, gatewayBase: string): InferenceTransport {
  return {
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const target = rewriteOpenAiUrl(url, gatewayBase)
      if (target === url) return globalThis.fetch(input, init)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('authorization', `Bearer ${getIdToken()}`)
      return globalThis.fetch(target, { ...init, headers })
    },
    createWebSocket: (url, options) => {
      const target = rewriteOpenAiUrl(url, gatewayBase)
      if (target === url) return new WebSocket(url, options)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(options.headers ?? {})) if (name.toLowerCase() !== 'authorization') headers[name] = value
      headers.Authorization = `Bearer ${getIdToken()}`
      return new WebSocket(target, { ...options, headers })
    }
  }
}
