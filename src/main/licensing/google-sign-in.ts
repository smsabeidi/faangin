import { createHash, randomBytes } from 'node:crypto'
import { GOOGLE_AUTH_REDIRECT, isGoogleAuthCallback } from './auth-redirect'

export const GOOGLE_SIGN_IN_TTL_MS = 10 * 60_000

export function createGoogleSignIn(supabaseUrl: string) {
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(`${supabaseUrl}/auth/v1/authorize`)
  url.search = new URLSearchParams({
    provider: 'google',
    redirect_to: GOOGLE_AUTH_REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 's256',
    prompt: 'select_account'
  }).toString()
  return { url: url.href, verifier }
}

type GoogleCallback = { kind: 'code'; code: string } | { kind: 'cancelled' | 'error' }

export function parseGoogleCallback(raw: string): GoogleCallback | null {
  if (!isGoogleAuthCallback(raw)) return null
  const url = new URL(raw)
  const query = url.searchParams
  const fragment = new URLSearchParams(url.hash.slice(1))
  const codes = query.getAll('code')
  const errors = query.has('error') ? query : fragment
  const error = errors.get('error')
  if ([query, fragment].some(params => ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token'].some(key => params.has(key)))) return null
  if (codes.length === 1 && !url.hash && !query.has('error') && !query.has('error_code') && /^[A-Za-z0-9_-]{1,512}$/.test(codes[0])) return { kind: 'code', code: codes[0] }
  if (codes.length || fragment.has('code') || !error || errors.getAll('error').length !== 1) return null
  // Supabase puts OAuth errors in both the query and fragment. A Google denial has no Supabase error code.
  return { kind: error === 'access_denied' && !errors.has('error_code') ? 'cancelled' : 'error' }
}
