/**
 * Background license-refresh scheduler.
 *
 * Rules (per spec):
 *   - active and >24h from exp: no network call, re-check in 1h.
 *   - active and <24h from exp: call refreshLicense now.
 *   - in grace: retry every 6h.
 *   - expired / none / revoked: nothing to do (the UI drives the next step).
 *
 * Uses setTimeout, not setInterval, so each scheduled tick re-reads the
 * current state and the scheduler cancels cleanly through its stop fn.
 */

import type { Entitlement } from '../../shared/billing-types'
import { backendOrigin, joinBackend } from '../../shared/billing-storage'
import type { CachedEntitlement } from './entitlement-cache'
import type { LicenseKeyCache } from './key-cache'
import type { LicenseState } from './state'
import { parseJwtHeader, verifyLicenseToken } from './verify'

export interface RefreshDeps {
  origin?: string
  fetchImpl?: typeof fetch
  keyCache: LicenseKeyCache
  entitlementCache: {
    load: () => Promise<CachedEntitlement | null>
    save: (cached: CachedEntitlement) => Promise<void>
  }
  getCurrentState: () => Promise<LicenseState>
  onStateUpdate?: (state: LicenseState) => void
  nowSeconds?: () => number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface RefreshHandle {
  stop: () => void
  /** For tests: force an immediate attempt. */
  tickNow: () => Promise<void>
}

const HOUR = 3600
const FAR_FUTURE_TICK_SECONDS = HOUR          // active + >24h -> re-check in 1h
const GRACE_TICK_SECONDS = 6 * HOUR           // in grace -> retry every 6h
const IDLE_TICK_SECONDS = 24 * HOUR           // expired / none -> poll once a day

export function startLicenseRefresh(deps: RefreshDeps): RefreshHandle {
  const setTimer = deps.setTimeoutImpl ?? setTimeout
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout
  const now = () => (deps.nowSeconds ?? defaultNow)()
  let handle: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const schedule = (delaySeconds: number) => {
    if (stopped) return
    const ms = Math.max(1000, Math.round(delaySeconds * 1000))
    handle = setTimer(() => { void tick() }, ms)
  }

  const tick = async () => {
    if (stopped) return
    let delay = IDLE_TICK_SECONDS
    try {
      const state = await deps.getCurrentState()
      if (state.kind === 'active') {
        const secondsToExp = Math.max(0, state.renewsAt - now())
        if (secondsToExp > 24 * HOUR) {
          delay = FAR_FUTURE_TICK_SECONDS
        } else {
          await refreshOnce(deps)
          delay = Math.min(FAR_FUTURE_TICK_SECONDS, Math.max(5 * 60, secondsToExp / 2))
        }
      } else if (state.kind === 'grace') {
        await refreshOnce(deps)
        delay = GRACE_TICK_SECONDS
      } else {
        delay = IDLE_TICK_SECONDS
      }
    } catch {
      delay = GRACE_TICK_SECONDS
    }
    schedule(delay)
  }

  schedule(FAR_FUTURE_TICK_SECONDS)
  return {
    stop: () => {
      stopped = true
      if (handle !== null) clearTimer(handle)
      handle = null
    },
    tickNow: () => tick(),
  }
}

export async function refreshOnce(deps: RefreshDeps): Promise<RefreshOutcome> {
  const cached = await deps.entitlementCache.load()
  if (!cached) return { kind: 'skipped', reason: 'no-cached-token' }

  const url = joinBackend(deps.origin ?? backendOrigin(), '/billing/refreshLicense')
  const impl = deps.fetchImpl ?? ((...args) => fetch(...args))
  let response: Response
  try {
    response = await impl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: cached.entitlement.uid, deviceId: findActiveDeviceId(cached.entitlement) }),
    })
  } catch (error) {
    return { kind: 'error', message: (error as Error).message }
  }
  if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` }
  const body = await response.json() as { licenseToken?: unknown; entitlement?: unknown }
  if (typeof body.licenseToken !== 'string' || !body.entitlement) {
    return { kind: 'error', message: 'malformed-response' }
  }
  const licenseToken = body.licenseToken
  const header = parseJwtHeader(licenseToken)
  if (!header || !header.kid) return { kind: 'error', message: 'missing-kid' }
  const publicKey = await deps.keyCache.getPublicKey(header.kid)
  if (!publicKey) return { kind: 'error', message: 'unknown-kid' }
  const payload = await verifyLicenseToken(licenseToken, publicKey)
  if (!payload) return { kind: 'error', message: 'bad-signature' }
  await deps.entitlementCache.save({
    entitlement: body.entitlement as Entitlement,
    licenseToken,
    licenseExpiresAt: payload.exp,
    graceUntil: payload.graceUntil,
  })
  return { kind: 'refreshed' }
}

export type RefreshOutcome =
  | { kind: 'refreshed' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string }

function findActiveDeviceId(entitlement: Entitlement): string | undefined {
  if (!entitlement.devices?.length) return undefined
  return entitlement.devices[entitlement.devices.length - 1]?.deviceId
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}
