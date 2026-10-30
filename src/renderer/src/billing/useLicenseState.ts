/**
 * React hook that owns a cached BillingSummary and keeps it in sync with
 * main-process state changes pushed through window.billing.onStateChanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BillingBridge, BillingSummary } from '../../../preload/billing'

export interface UseLicenseState {
  summary: BillingSummary | null
  state: BillingSummary['state']
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  signIn: () => Promise<void>
  cancelSignIn: () => Promise<void>
  signOut: () => Promise<void>
  openManage: () => Promise<void>
  signInStart: import('../../../shared/billing-types').DeviceCodeStart | null
}

function bridge(): BillingBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { billing?: BillingBridge }).billing ?? null
}

export function useLicenseState(): UseLicenseState {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signInStart, setSignInStart] = useState<UseLicenseState['signInStart']>(null)
  const alive = useRef(true)

  const applySummary = useCallback((next: BillingSummary | null) => {
    if (!alive.current) return
    setSummary(next)
    if (next && next.state.kind !== 'none') setSignInStart(null)
  }, [])

  const refresh = useCallback(async () => {
    const api = bridge()
    if (!api) {
      setError('Billing bridge unavailable in this window.')
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const next = await api.refresh()
      applySummary(next)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      if (alive.current) setIsLoading(false)
    }
  }, [applySummary])

  const signIn = useCallback(async () => {
    const api = bridge()
    if (!api) return
    setError(null)
    try {
      const start = await api.startSignIn()
      if (alive.current) setSignInStart(start)
    } catch (cause) {
      if (alive.current) setError((cause as Error).message)
    }
  }, [])

  const cancelSignIn = useCallback(async () => {
    const api = bridge()
    if (!api) return
    try { await api.cancelSignIn() } finally { if (alive.current) setSignInStart(null) }
  }, [])

  const signOut = useCallback(async () => {
    const api = bridge()
    if (!api) return
    await api.signOut()
    applySummary({ state: { kind: 'none' }, entitlement: null, usage: null, deviceId: null })
  }, [applySummary])

  const openManage = useCallback(async () => {
    const api = bridge()
    if (!api) return
    await api.openManage()
  }, [])

  useEffect(() => {
    alive.current = true
    const api = bridge()
    if (!api) {
      setError('Billing bridge unavailable in this window.')
      setIsLoading(false)
      return () => { alive.current = false }
    }
    let unsubscribed = false
    api.getState()
      .then(result => { if (!unsubscribed) applySummary(result) })
      .catch(cause => { if (!unsubscribed) setError((cause as Error).message) })
      .finally(() => { if (!unsubscribed && alive.current) setIsLoading(false) })
    const off = api.onStateChanged(applySummary)
    return () => {
      alive.current = false
      unsubscribed = true
      off()
    }
  }, [applySummary])

  return {
    summary,
    state: summary?.state ?? { kind: 'none' },
    isLoading,
    error,
    refresh,
    signIn,
    cancelSignIn,
    signOut,
    openManage,
    signInStart,
  }
}
