import { useCallback, useEffect, useState } from 'react'
import type { BillingPlan, BillingSummary } from '../../../shared/billing-types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : String(error)
}

/** The account state lives in the main process; this mirrors it and turns each button into one call. */
export function useBilling() {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.faangin.getBilling().then(next => { if (live) setSummary(next) }).catch(error => { if (live) setActionError(errorMessage(error)) })
    const stop = window.faangin.onBillingChange(next => { if (live) setSummary(next) })
    return () => { live = false; stop() }
  }, [])

  const act = useCallback(async (call: () => Promise<BillingSummary>) => {
    setActionError(null)
    try { setSummary(await call()) } catch (error) { setActionError(errorMessage(error)) }
  }, [])

  return {
    summary,
    actionError,
    signIn: () => act(() => window.faangin.billingSignIn()),
    cancelSignIn: () => act(() => window.faangin.billingCancelSignIn()),
    signOut: () => act(() => window.faangin.billingSignOut()),
    refresh: () => act(() => window.faangin.billingRefresh()),
    checkout: (plan: BillingPlan) => act(() => window.faangin.billingCheckout(plan)),
    manage: () => act(() => window.faangin.billingManage())
  }
}
