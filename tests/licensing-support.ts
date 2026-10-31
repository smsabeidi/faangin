import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import * as realCloud from '../src/main/faangin-cloud'
import type { DeviceInfo, DeviceSignInStart, LicensePayload } from '../src/main/faangin-cloud'
import { AccountStore, type SecretBox } from '../src/main/licensing/account-store'
import type { CloudConfig } from '../src/main/licensing/config'
import { LicenseService, type CloudApi } from '../src/main/licensing/service'
import type { BillingSummary } from '../src/shared/billing-types'

export const DAY = 24 * 3600 * 1000
export const NOW = 1_800_000_000_000
export const DEVICE: DeviceInfo = { deviceId: 'a'.repeat(64), deviceName: 'Test Mac' }
export const CONFIG: CloudConfig = {
  functionsBase: 'https://us-central1-faangin-staging.cloudfunctions.net',
  webApiKey: 'web-key',
  hostingOrigin: 'https://faangin-staging.web.app'
}

export function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}

/** Builds a token exactly like backend/functions/src/license/sign.ts: v1.<b64url payload JSON>.<b64url Ed25519 signature>. */
export function makeToken(payload: object, privateKey: KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload))
  return `v1.${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}`
}

export function licensePayload(now: number, overrides: Partial<LicensePayload> = {}): LicensePayload {
  const exp = now + 30 * DAY
  return { v: 1, uid: 'user-1', plan: 'byok', status: 'active', iat: now, exp, grace: exp + 14 * DAY, deviceId: DEVICE.deviceId, ...overrides }
}

/** A reversible stand-in for safeStorage: the bytes on disk are not the plaintext. */
export function fakeSecrets(state: { available: boolean } = { available: true }): SecretBox & { state: { available: boolean } } {
  return {
    state,
    available: () => state.available,
    encrypt: plain => Buffer.from(`enc:${Buffer.from(plain).reverse().toString('base64')}`),
    decrypt: data => {
      const text = data.toString()
      if (!text.startsWith('enc:')) throw new Error('not encrypted')
      return Buffer.from(Buffer.from(text.slice(4), 'base64').reverse()).toString()
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

export async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

type Overrides = { [K in keyof CloudApi]?: (...args: any[]) => unknown }

export interface HarnessOptions {
  config?: CloudConfig | null
  cloud?: Overrides
  secrets?: { available: boolean }
  /** Keys the service trusts; defaults to the harness signing key. */
  trust?: string[]
}

/** A LicenseService on a temp directory with real persistence, real verification and a scripted backend. */
export function harness(t: TestContext, options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-licensing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const signer = keyPair()
  const clock = { now: NOW }
  const secrets = fakeSecrets(options.secrets)
  const store = new AccountStore({ userDataPath: dir, secrets })
  const opened: string[] = []
  const changes: BillingSummary[] = []
  const calls: { name: string; args: unknown[] }[] = []
  const token = (overrides: Partial<LicensePayload> = {}) => makeToken(licensePayload(clock.now, overrides), signer.privateKey)

  const defaults: Record<keyof CloudApi, (...args: any[]) => unknown> = {
    startDeviceSignIn: async (): Promise<DeviceSignInStart> => ({ deviceCode: 'device-code', userCode: 'ABCD-EFGH', verificationUrl: `${CONFIG.hostingOrigin}/activate?code=ABCD-EFGH`, expiresIn: 600, interval: 5 }),
    waitForDeviceSignIn: async () => ({ status: 'approved', customToken: 'custom-token', uid: 'user-1' }),
    exchangeCustomToken: async () => ({ uid: 'user-1', idToken: 'id-token-1', refreshToken: 'refresh-1', expiresAt: clock.now + 3600_000 }),
    refreshIdToken: async () => ({ uid: 'user-1', idToken: 'id-token-2', refreshToken: 'refresh-1', expiresAt: clock.now + 3600_000 }),
    callFunction: async () => { throw new Error('unexpected callFunction') },
    fetchLicense: async () => ({ token: token(), plan: 'byok', status: 'active', expiresAt: clock.now + 30 * DAY, graceUntil: clock.now + 44 * DAY }),
    verifyLicenseWithKeys: realCloud.verifyLicenseWithKeys
  }
  const cloud = Object.fromEntries((Object.keys(defaults) as (keyof CloudApi)[]).map(name => {
    const implementation = options.cloud?.[name] ?? defaults[name]
    return [name, name === 'verifyLicenseWithKeys' ? implementation : (...args: unknown[]) => { calls.push({ name, args }); return implementation(...args) }]
  })) as unknown as CloudApi

  const service = new LicenseService({
    config: options.config === undefined ? CONFIG : options.config,
    store,
    identity: { get: async () => DEVICE },
    openExternal: async url => { opened.push(url) },
    encryptionAvailable: secrets.available,
    onChange: summary => { changes.push(summary) },
    cloud,
    publicKeys: options.trust ?? [signer.publicKeyBase64],
    now: () => clock.now,
    dailyRefresh: false
  })
  t.after(() => service.dispose())
  const count = (name: keyof CloudApi) => calls.filter(call => call.name === name).length
  return { service, store, dir, signer, clock, opened, changes, calls, count, token, secrets }
}
