/**
 * IPC wiring for the renderer's billing surface. The channel names mirror
 * the window.billing method names so grepping is trivial.
 *
 * TODO(billing-integration): once the host (src/main/index.ts) is ready to
 * wire this in, call registerBillingIpc from that bootstrap after initialising
 * the key cache, entitlement cache, and device identity.
 */

import { app, ipcMain, safeStorage, shell, type IpcMain } from 'electron'
import type {
  DeviceCodeStart,
  Entitlement,
  LicenseTokenPayload,
  ProUsageSnapshot,
} from '../../shared/billing-types'
import { backendOrigin, joinBackend } from '../../shared/billing-storage'
import { initializeDeviceIdentity, type DeviceIdentity } from './device-identity'
import {
  EntitlementCache,
  initializeEntitlementCache,
  type CachedEntitlement,
  type SafeStorageLike,
} from './entitlement-cache'
import { initializeLicenseKeyCache, LicenseKeyCache } from './key-cache'
import { deriveLicenseState, type LicenseState } from './state'
import { DeviceCodeClient, type DeviceCodePollResult } from './device-code'
import { parseJwtHeader, verifyLicenseToken } from './verify'

export const BILLING_CHANNEL = {
  getState: 'billing:get-state',
  startSignIn: 'billing:start-sign-in',
  cancelSignIn: 'billing:cancel-sign-in',
  signOut: 'billing:sign-out',
  refresh: 'billing:refresh',
  openManage: 'billing:open-manage',
  stateChanged: 'billing:state-changed',
} as const

export interface BillingSummary {
  state: LicenseState
  entitlement: Entitlement | null
  usage: ProUsageSnapshot | null
  deviceId: string | null
}

export interface RegisterBillingIpcOptions {
  ipc?: IpcMain
  origin?: string
  userDataPath?: string
  safeStorage?: SafeStorageLike | null
  fetchImpl?: typeof fetch
  shellImpl?: Pick<typeof shell, 'openExternal'>
  logger?: (message: string, meta?: Record<string, unknown>) => void
}

interface RuntimeHandles {
  keyCache: LicenseKeyCache
  entitlementCache: EntitlementCache
  identity: DeviceIdentity
  deviceCode: DeviceCodeClient
  activeSignIn: AbortController | null
  broadcastState: () => Promise<void>
}

let runtime: RuntimeHandles | null = null

export function registerBillingIpc(options: RegisterBillingIpcOptions = {}): () => void {
  const ipc = options.ipc ?? ipcMain
  const origin = options.origin ?? backendOrigin()
  const userDataPath = options.userDataPath ?? app.getPath('userData')
  const safe = options.safeStorage ?? (safeStorage as unknown as SafeStorageLike)

  const keyCache = initializeLicenseKeyCache({ userDataPath, origin, fetchImpl: options.fetchImpl })
  const entitlementCache = initializeEntitlementCache({ userDataPath, safeStorage: safe, logger: options.logger })
  const identity = initializeDeviceIdentity({ userDataPath })
  const deviceCode = new DeviceCodeClient({
    origin,
    fetchImpl: options.fetchImpl,
    keyCache,
    entitlementCache,
    getDevice: () => identity.getDescriptor(),
  })

  const broadcastState = async () => {
    try {
      const summary = await loadSummary(keyCache, entitlementCache)
      for (const window of listRendererWindows()) {
        window.webContents.send(BILLING_CHANNEL.stateChanged, summary)
      }
    } catch (error) {
      options.logger?.('billing-ipc.broadcast-failed', { error: (error as Error).message })
    }
  }

  runtime = { keyCache, entitlementCache, identity, deviceCode, activeSignIn: null, broadcastState }

  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

  const register = (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    ipc.handle(channel, (_event, ...args) => handler(...args))
    handlers.set(channel, handler)
  }

  register(BILLING_CHANNEL.getState, async (): Promise<BillingSummary> => {
    return loadSummary(keyCache, entitlementCache)
  })

  register(BILLING_CHANNEL.startSignIn, async (): Promise<DeviceCodeStart> => {
    runtime?.activeSignIn?.abort()
    const controller = new AbortController()
    runtime!.activeSignIn = controller
    const start = await deviceCode.start()
    void driveSignInPolling(deviceCode, start, controller)
      .then(result => handleSignInResult(result))
      .catch(error => options.logger?.('billing-ipc.sign-in-failed', { error: (error as Error).message }))
    return start
  })

  register(BILLING_CHANNEL.cancelSignIn, async (): Promise<void> => {
    runtime?.activeSignIn?.abort()
    runtime!.activeSignIn = null
  })

  register(BILLING_CHANNEL.signOut, async (): Promise<void> => {
    runtime?.activeSignIn?.abort()
    runtime!.activeSignIn = null
    await entitlementCache.clear()
    await broadcastState()
  })

  register(BILLING_CHANNEL.refresh, async (): Promise<BillingSummary> => {
    await keyCache.refreshPublicKeys()
    const summary = await loadSummary(keyCache, entitlementCache)
    await broadcastState()
    return summary
  })

  register(BILLING_CHANNEL.openManage, async (): Promise<void> => {
    // TODO(billing-integration): swap for a real callable that returns a
    // short-lived Stripe Customer Portal URL. We stub to the pricing page
    // so the button is wired end-to-end locally.
    const url = joinBackend(origin, '/billing/portal')
    try {
      const response = await (options.fetchImpl ?? ((...args) => fetch(...args)))(url)
      if (response.ok) {
        const body = await response.json() as { url?: unknown }
        if (typeof body.url === 'string') {
          await (options.shellImpl ?? shell).openExternal(body.url)
          return
        }
      }
    } catch { /* fallthrough to pricing page */ }
    await (options.shellImpl ?? shell).openExternal('https://faangin.app/pricing')
  })

  async function handleSignInResult(result: DeviceCodePollResult): Promise<void> {
    runtime!.activeSignIn = null
    await broadcastState()
    if (result.outcome === 'success') {
      options.logger?.('billing-ipc.sign-in-complete', { plan: (result.state as { plan?: string }).plan })
    }
  }

  return () => {
    for (const channel of handlers.keys()) ipc.removeHandler(channel)
    runtime?.activeSignIn?.abort()
    runtime = null
  }
}

export async function loadSummary(
  keyCache: LicenseKeyCache,
  entitlementCache: EntitlementCache,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<BillingSummary> {
  const cached = await entitlementCache.load()
  if (!cached) return { state: { kind: 'none' }, entitlement: null, usage: null, deviceId: null }

  const header = parseJwtHeader(cached.licenseToken)
  let verified: LicenseTokenPayload | null = null
  if (header?.kid) {
    const publicKey = await keyCache.getPublicKey(header.kid)
    if (publicKey) verified = await verifyLicenseToken(cached.licenseToken, publicKey, nowSeconds)
  }
  const state = deriveLicenseState({ now: nowSeconds, cached, verifiedPayload: verified })
  return {
    state,
    entitlement: cached.entitlement,
    usage: null, // TODO(billing-integration): wire a Pro usage callable.
    deviceId: verified?.deviceId ?? null,
  }
}

async function driveSignInPolling(
  client: DeviceCodeClient,
  start: DeviceCodeStart,
  controller: AbortController,
): Promise<DeviceCodePollResult> {
  return client.poll(start.deviceCode, {
    intervalMs: Math.max(1000, start.interval * 1000),
    signal: controller.signal,
  })
}

function listRendererWindows() {
  // TODO(billing-integration): the main process keeps a window registry
  // elsewhere; expose a getter from src/main/index.ts and import it here.
  // For now we use Electron's BrowserWindow catalog, lazy-required so this
  // module is still importable in test context.
  try {
    const electron = require('electron') as typeof import('electron')
    return electron.BrowserWindow.getAllWindows()
  } catch {
    return [] as Array<{ webContents: { send: (channel: string, payload: unknown) => void } }>
  }
}
