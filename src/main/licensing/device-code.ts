/**
 * Client half of the device-code sign-in flow.
 *
 * The app calls startDeviceCode on the backend, which returns a short
 * verification code the user types on https://faangin.app/sign-in. We
 * then poll pollDeviceCode until the backend returns success, denied,
 * or expired. On success we verify the returned Ed25519 license token
 * locally before persisting anything, so a hostile network cannot
 * elevate a device without the signing key.
 */

import type {
  DeviceCodePollStatus,
  DeviceCodeStart,
  DeviceDescriptor,
  Entitlement,
} from '../../shared/billing-types'
import { backendOrigin, joinBackend } from '../../shared/billing-storage'
import type { CachedEntitlement } from './entitlement-cache'
import type { LicenseKeyCache } from './key-cache'
import { parseJwtHeader, verifyLicenseToken } from './verify'
import { deriveLicenseState, type LicenseState } from './state'

export interface DeviceCodeDeps {
  origin?: string
  fetchImpl?: typeof fetch
  keyCache: LicenseKeyCache
  entitlementCache: {
    save: (cached: CachedEntitlement) => Promise<void>
  }
  getDevice: () => Promise<DeviceDescriptor>
  nowSeconds?: () => number
}

export interface PollOptions {
  intervalMs: number
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export class DeviceCodeClient {
  private readonly deps: DeviceCodeDeps
  constructor(deps: DeviceCodeDeps) {
    this.deps = deps
  }

  async start(): Promise<DeviceCodeStart> {
    const device = await this.deps.getDevice()
    const url = joinBackend(this.deps.origin ?? backendOrigin(), '/billing/startDeviceCode')
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device }),
    })
    if (!response.ok) throw new Error(`startDeviceCode failed: ${response.status}`)
    const body = await response.json()
    if (!isDeviceCodeStart(body)) throw new Error('startDeviceCode returned malformed response')
    return body
  }

  async poll(deviceCode: string, options: PollOptions): Promise<DeviceCodePollResult> {
    let interval = Math.max(1000, options.intervalMs)
    const sleep = options.sleep ?? defaultSleep
    const url = joinBackend(this.deps.origin ?? backendOrigin(), '/billing/pollDeviceCode')
    for (;;) {
      if (options.signal?.aborted) return { outcome: 'aborted' }
      await sleep(interval, options.signal)
      if (options.signal?.aborted) return { outcome: 'aborted' }
      let response: Response
      try {
        response = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceCode }),
          signal: options.signal,
        })
      } catch (error) {
        if ((error as Error & { name?: string }).name === 'AbortError') return { outcome: 'aborted' }
        // Transient failure: back off slightly and retry.
        interval = Math.min(interval * 2, 30_000)
        continue
      }
      if (!response.ok) {
        interval = Math.min(interval * 2, 30_000)
        continue
      }
      const payload = await response.json() as DeviceCodePollStatus
      if (!payload || typeof payload !== 'object') continue
      switch (payload.status) {
        case 'pending':
          continue
        case 'slow_down':
          interval = Math.max(interval, (payload.interval ?? 0) * 1000, interval + 5000)
          continue
        case 'expired':
          return { outcome: 'expired' }
        case 'denied':
          return { outcome: 'denied' }
        case 'success': {
          const result = await this.completeSignIn(payload.licenseToken, payload.entitlement)
          if (!result) return { outcome: 'denied' }
          return { outcome: 'success', state: result }
        }
      }
    }
  }

  private async completeSignIn(licenseToken: string, entitlement: Entitlement): Promise<LicenseState | null> {
    const header = parseJwtHeader(licenseToken)
    if (!header || !header.kid) return null
    const publicKey = await this.deps.keyCache.getPublicKey(header.kid)
    if (!publicKey) return null
    const payload = await verifyLicenseToken(licenseToken, publicKey)
    if (!payload) return null
    const cached: CachedEntitlement = {
      entitlement,
      licenseToken,
      licenseExpiresAt: payload.exp,
      graceUntil: payload.graceUntil,
    }
    await this.deps.entitlementCache.save(cached)
    const now = (this.deps.nowSeconds ?? defaultNow)()
    return deriveLicenseState({ now, cached, verifiedPayload: payload })
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    const impl = this.deps.fetchImpl ?? ((...args) => fetch(...args))
    return impl(url, init)
  }
}

export type DeviceCodePollResult =
  | { outcome: 'success'; state: LicenseState }
  | { outcome: 'denied' }
  | { outcome: 'expired' }
  | { outcome: 'aborted' }

function isDeviceCodeStart(value: unknown): value is DeviceCodeStart {
  if (!value || typeof value !== 'object') return false
  const object = value as Record<string, unknown>
  return (
    typeof object.deviceCode === 'string' &&
    typeof object.userCode === 'string' &&
    typeof object.verificationUri === 'string' &&
    typeof object.verificationUriComplete === 'string' &&
    typeof object.expiresIn === 'number' &&
    typeof object.interval === 'number'
  )
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}
