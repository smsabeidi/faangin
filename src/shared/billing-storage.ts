/**
 * File-system layout for billing persistence in app.getPath('userData').
 * Shared so that both the main process and tests can agree on paths.
 */

export const BILLING_FILE_NAMES = {
  entitlement: 'entitlement.json',
  licenseKeys: 'license-keys.json',
  deviceSalt: '.device-salt',
} as const

export type BillingFileName = (typeof BILLING_FILE_NAMES)[keyof typeof BILLING_FILE_NAMES]

export const DEFAULT_BACKEND_ORIGIN = 'http://localhost:5001'

export function backendOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.FAANGIN_BACKEND_ORIGIN?.trim()
  if (!raw) return DEFAULT_BACKEND_ORIGIN
  try {
    const parsed = new URL(raw)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')}`
  } catch {
    return DEFAULT_BACKEND_ORIGIN
  }
}

export function joinBackend(origin: string, path: string): string {
  const normalizedBase = origin.replace(/\/$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}
