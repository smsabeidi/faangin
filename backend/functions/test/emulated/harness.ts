// Helpers for tests that run under `firebase emulators:exec --project demo-faangin`.
// The emulator sets FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST for this process.
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

export const PROJECT = 'demo-faangin'
export const REGION = 'us-central1'
export const FUNCTIONS_BASE = `http://127.0.0.1:5001/${PROJECT}/${REGION}`
export const AUTH_BASE = 'http://127.0.0.1:9099'

if (!getApps().length) initializeApp({ projectId: PROJECT })
export const db = getFirestore()

/** Callable protocol: POST {data}, optional Firebase ID token; returns {result} or throws {code, message}. */
export async function call<T = unknown>(name: string, data: unknown, idToken?: string): Promise<T> {
  const response = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data })
  })
  const body = await response.json() as { result?: T; error?: { status?: string; message?: string } }
  if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message ?? `HTTP ${response.status}`), { code: body.error?.status ?? response.status })
  return body.result as T
}

/** Plain HTTP function (onRequest). */
export async function http(name: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${FUNCTIONS_BASE}/${name}`, init)
}

/** Creates an Auth-emulator user and returns its uid and a usable ID token. */
export async function signInTestUser(email = `user-${Math.random().toString(36).slice(2)}@example.test`): Promise<{ uid: string; idToken: string; email: string }> {
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password-123', returnSecureToken: true })
  })
  const body = await response.json() as { localId: string; idToken: string }
  if (!response.ok) throw new Error(`signUp failed: ${JSON.stringify(body)}`)
  return { uid: body.localId, idToken: body.idToken, email }
}

/** Exchanges a custom token for an ID token through the Auth emulator (what the desktop app does after device sign-in). */
export async function signInWithCustomToken(token: string): Promise<{ uid: string; idToken: string; refreshToken: string }> {
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, returnSecureToken: true })
  })
  const body = await response.json() as { idToken: string; refreshToken: string }
  if (!response.ok) throw new Error(`signInWithCustomToken failed: ${JSON.stringify(body)}`)
  const payload = JSON.parse(Buffer.from(body.idToken.split('.')[1], 'base64url').toString()) as { user_id?: string; sub?: string }
  return { uid: payload.user_id ?? payload.sub ?? '', idToken: body.idToken, refreshToken: body.refreshToken }
}

/** Like signInTestUser, but the Auth account's email is verified (what a Google sign-in looks like) and the token carries email_verified. */
export async function signInVerifiedTestUser(): Promise<{ uid: string; idToken: string; email: string }> {
  const user = await signInTestUser()
  await getAuth().updateUser(user.uid, { emailVerified: true })
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'password-123', returnSecureToken: true })
  })
  const body = await response.json() as { idToken: string }
  if (!response.ok) throw new Error(`signInWithPassword failed: ${JSON.stringify(body)}`)
  return { ...user, idToken: body.idToken }
}
