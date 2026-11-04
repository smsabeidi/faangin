export const GOOGLE_AUTH_REDIRECT = 'faangin://auth/callback'

export function isGoogleAuthCallback(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return false
  const target = value.split(/[?#]/, 1)[0]
  return target === GOOGLE_AUTH_REDIRECT
}
