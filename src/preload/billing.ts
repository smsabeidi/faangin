/**
 * Exposes a narrow `window.billing` surface to the renderer. The main
 * process owns everything behind the IPC channels in src/main/licensing/ipc.ts;
 * the renderer only ever sees typed function calls and a `onStateChanged`
 * subscription.
 */

import type { ContextBridge, IpcRenderer, IpcRendererEvent } from 'electron'
import type { DeviceCodeStart, Entitlement, ProUsageSnapshot } from '../shared/billing-types'

export const BILLING_CHANNEL = {
  getState: 'billing:get-state',
  startSignIn: 'billing:start-sign-in',
  cancelSignIn: 'billing:cancel-sign-in',
  signOut: 'billing:sign-out',
  refresh: 'billing:refresh',
  openManage: 'billing:open-manage',
  stateChanged: 'billing:state-changed',
} as const

export type LicenseState =
  | { kind: 'none' }
  | { kind: 'active'; plan: Entitlement['plan']; renewsAt: number }
  | { kind: 'grace'; plan: Entitlement['plan']; graceUntil: number }
  | { kind: 'expired'; plan: Entitlement['plan'] }
  | { kind: 'revoked' }

export interface BillingSummary {
  state: LicenseState
  entitlement: Entitlement | null
  usage: ProUsageSnapshot | null
  deviceId: string | null
}

export interface BillingBridge {
  getState: () => Promise<BillingSummary>
  startSignIn: () => Promise<DeviceCodeStart>
  cancelSignIn: () => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<BillingSummary>
  openManage: () => Promise<void>
  onStateChanged: (listener: (summary: BillingSummary) => void) => () => void
}

export function exposeBillingBridge(
  contextBridge: Pick<ContextBridge, 'exposeInMainWorld'>,
  ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>,
): void {
  const bridge: BillingBridge = {
    getState: () => ipcRenderer.invoke(BILLING_CHANNEL.getState),
    startSignIn: () => ipcRenderer.invoke(BILLING_CHANNEL.startSignIn),
    cancelSignIn: () => ipcRenderer.invoke(BILLING_CHANNEL.cancelSignIn),
    signOut: () => ipcRenderer.invoke(BILLING_CHANNEL.signOut),
    refresh: () => ipcRenderer.invoke(BILLING_CHANNEL.refresh),
    openManage: () => ipcRenderer.invoke(BILLING_CHANNEL.openManage),
    onStateChanged: listener => {
      const callback = (_event: IpcRendererEvent, summary: BillingSummary) => listener(summary)
      ipcRenderer.on(BILLING_CHANNEL.stateChanged, callback)
      return () => ipcRenderer.removeListener(BILLING_CHANNEL.stateChanged, callback)
    },
  }
  contextBridge.exposeInMainWorld('billing', Object.freeze(bridge))
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  interface Window {
    billing?: BillingBridge
  }
}
