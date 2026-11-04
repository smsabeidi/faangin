import type { LicenseState } from './billing-types'

/** Builds without cloud configuration keep the existing local-provider workflow. */
export function accountAllowsInference(state?: LicenseState): boolean {
  return !state || state.kind === 'unavailable' || state.kind === 'active' || state.kind === 'grace'
}

export function accountHasPro(state?: LicenseState): boolean {
  return !!state && (state.kind === 'active' || state.kind === 'grace') && state.plan === 'pro'
}

export function requireAccountInference(state?: LicenseState): void {
  if (accountAllowsInference(state)) return
  if (state?.kind === 'signed-out') throw new Error('Sign in in Settings → Plan & account before starting an interview.')
  if (state?.kind === 'no-plan') throw new Error('Choose a plan in Settings → Plan & account before starting an interview.')
  throw new Error('Refresh your license in Settings → Plan & account before starting an interview.')
}
