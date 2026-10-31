import * as realCloud from '../faangin-cloud'
import { CloudError, LICENSE_PUBLIC_KEYS, type DeviceInfo, type DeviceSignInStart } from '../faangin-cloud'
import type { BillingPlan, BillingSummary, SignInPrompt } from '../../shared/billing-types'
import type { AccountStore, StoredSession } from './account-store'
import { allowedExternalUrl, type CloudConfig, type ExternalPurpose } from './config'
import type { DeviceIdentity } from './device-identity'
import { deriveLicenseState } from './state'

/** The slice of faangin-cloud.ts the service uses; tests pass a fake. */
export type CloudApi = Pick<typeof realCloud, 'startDeviceSignIn' | 'waitForDeviceSignIn' | 'exchangeCustomToken' | 'refreshIdToken' | 'callFunction' | 'fetchLicense' | 'verifyLicenseWithKeys'>

export interface LicenseServiceOptions {
  /** Null when the build has no accounts backend. */
  config: CloudConfig | null
  store: AccountStore
  identity: Pick<DeviceIdentity, 'get'>
  openExternal: (url: string) => Promise<void>
  /** Whether the OS can encrypt the refresh token; checked before a browser trip is wasted. */
  encryptionAvailable: () => boolean
  onChange: (summary: BillingSummary) => void
  cloud?: CloudApi
  publicKeys?: readonly string[]
  now?: () => number
  /** Re-check the license once a day while the app runs (default true). */
  dailyRefresh?: boolean
}

/** An error whose message is safe to show the user as is. */
export class BillingError extends Error {
  constructor(message: string) { super(message); this.name = 'BillingError' }
}

/** The server no longer accepts this sign-in: the account was disabled, deleted or its token revoked. */
class SessionRevoked extends Error {}

const PLANS: readonly BillingPlan[] = ['byok', 'pro_monthly', 'pro_annual']
const DAY_MS = 24 * 60 * 60 * 1000
const ID_TOKEN_MARGIN_MS = 5 * 60_000
const FOCUS_REFRESH_GAP_MS = 10_000
/** Server messages for these codes are written for people (already bought, seats full, device cap). */
const SPEAKABLE_CODES = new Set(['FAILED_PRECONDITION', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE'])

const MESSAGES = {
  unconfigured: 'This build of Faangin is not connected to an accounts service.',
  signedOutAlready: 'Sign in first.',
  encryption: 'OS credential encryption is unavailable. Unlock your keychain and try again.',
  codeExpired: 'The sign-in code expired. Start again to get a new one.',
  signInFailed: 'Sign-in could not finish. Check your connection and start again.',
  startFailed: 'Faangin could not reach the accounts service. Check your connection and try again.',
  revoked: 'You were signed out. Sign in again to keep using your plan.',
  deviceLimit: 'This account is already active on 3 devices. A device unused for 30 days frees its slot.',
  unverified: 'This build could not verify the license it received. Update Faangin and try again.',
  offline: 'Could not reach Faangin to check your license. A license you already have keeps working offline.',
  checkout: 'Checkout could not be started. Try again in a moment.',
  portal: 'Billing management could not be opened. Try again in a moment.',
  badLink: 'Faangin received an unexpected link and did not open it.',
  browser: 'The link could not be opened in your browser.'
} as const

export class LicenseService {
  private readonly cloud: CloudApi
  private readonly publicKeys: readonly string[]
  private readonly now: () => number
  private session: StoredSession | null = null
  private token: string | null = null
  private device: DeviceInfo | null = null
  private idMemo: { idToken: string; expiresAt: number } | null = null
  private signIn: SignInPrompt | null = null
  private signInAbort: AbortController | null = null
  private busy = false
  private error: string | null = null
  private awaitingPurchase = false
  private lastFocusRefresh = 0
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: LicenseServiceOptions) {
    this.cloud = options.cloud ?? realCloud
    this.publicKeys = options.publicKeys ?? LICENSE_PUBLIC_KEYS
    this.now = options.now ?? Date.now
  }

  /** Loads what is stored and re-checks the license in the background. Never blocks launch and needs no network. */
  async start(): Promise<void> {
    if (!this.options.config) return
    this.session = await this.options.store.readSession()
    this.token = await this.options.store.readLicense()
    this.device = await this.options.identity.get()
    this.emit()
    if (this.options.dailyRefresh !== false) {
      this.timer = setInterval(() => { void this.refresh({ background: true }) }, DAY_MS)
      this.timer.unref?.()
    }
    if (this.session) void this.refresh({ background: true })
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.signInAbort?.abort()
  }

  summary(): BillingSummary {
    const raw = this.token ? this.cloud.verifyLicenseWithKeys(this.token, this.now(), this.publicKeys) : null
    const verified = raw && (!this.session || raw.uid === this.session.uid) && (!this.device || raw.deviceId === this.device.deviceId) ? raw : null
    return {
      state: deriveLicenseState({ configured: this.options.config !== null, signedIn: this.session !== null, hasToken: this.token !== null, verified }),
      signIn: this.signIn,
      awaitingPurchase: this.awaitingPurchase,
      busy: this.busy,
      error: this.error,
      deviceName: this.device?.deviceName ?? null
    }
  }

  /** Opens the activation page and returns once the code is on screen; approval finishes in the background. */
  async startSignIn(): Promise<BillingSummary> {
    const config = this.requireConfig()
    if (!this.options.encryptionAvailable()) throw new BillingError(MESSAGES.encryption)
    this.signInAbort?.abort()
    this.error = null
    const device = await this.deviceInfo()
    let start: DeviceSignInStart
    try { start = await this.cloud.startDeviceSignIn(config.functionsBase, device) } catch { throw new BillingError(MESSAGES.startFailed) }
    const url = allowedExternalUrl(start.verificationUrl, config, 'activate')
    if (!url) throw new BillingError(MESSAGES.badLink)

    const controller = new AbortController()
    this.signInAbort = controller
    this.signIn = { userCode: start.userCode, verificationUrl: url, expiresAt: this.now() + start.expiresIn * 1000 }
    this.emit()
    void this.options.openExternal(url).catch(() => { /* the code and link stay on screen */ })
    void this.finishSignIn(config, start, controller)
    return this.summary()
  }

  cancelSignIn(): BillingSummary {
    this.signInAbort?.abort()
    this.signInAbort = null
    this.signIn = null
    this.emit()
    return this.summary()
  }

  signOut(): Promise<BillingSummary> {
    return this.exclusive(async () => {
      await this.dropAccount()
      this.error = null
      this.emit()
      return this.summary()
    })
  }

  /** Asks the server for a fresh license. `background` keeps a transient failure quiet while a license still works. */
  refresh(options: { background?: boolean } = {}): Promise<BillingSummary> {
    return this.exclusive(async () => {
      if (!this.options.config || !this.session) return this.summary()
      this.busy = true
      if (!options.background) this.error = null
      this.emit()
      try {
        await this.fetchAndStoreLicense()
      } catch (error) {
        await this.afterRefreshFailure(error, options.background === true)
      } finally {
        this.busy = false
        this.emit()
      }
      return this.summary()
    })
  }

  /** Opens Stripe Checkout for `plan` in the browser; the license arrives when the app regains focus after paying. */
  async openCheckout(plan: BillingPlan): Promise<BillingSummary> {
    if (!PLANS.includes(plan)) throw new BillingError('Unknown plan.')
    const url = await this.stripeLink('createCheckoutSession', { plan }, 'checkout', MESSAGES.checkout)
    await this.open(url)
    this.awaitingPurchase = true
    this.error = null
    this.emit()
    return this.summary()
  }

  async openPortal(): Promise<BillingSummary> {
    await this.open(await this.stripeLink('createPortalSession', {}, 'portal', MESSAGES.portal))
    return this.summary()
  }

  /** Call when a window gains focus: after Checkout the license is picked up without a manual refresh. */
  onWindowFocus(): void {
    if (!this.awaitingPurchase || !this.session || this.now() - this.lastFocusRefresh < FOCUS_REFRESH_GAP_MS) return
    this.lastFocusRefresh = this.now()
    void this.refresh({ background: true })
  }

  // -------------------------------------------------------------------------------------------------------------

  private requireConfig(): CloudConfig {
    if (!this.options.config) throw new BillingError(MESSAGES.unconfigured)
    return this.options.config
  }

  private emit(): void { this.options.onChange(this.summary()) }

  private async deviceInfo(): Promise<DeviceInfo> {
    this.device ??= await this.options.identity.get()
    return this.device
  }

  /** Runs one task at a time so a refresh, a sign-out and a sign-in finishing cannot interleave their writes. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async finishSignIn(config: CloudConfig, start: DeviceSignInStart, controller: AbortController): Promise<void> {
    try {
      const result = await this.cloud.waitForDeviceSignIn(config.functionsBase, start, { signal: controller.signal })
      if (result.status === 'aborted') return
      if (result.status === 'expired') { this.error = MESSAGES.codeExpired; return }
      const session = await this.cloud.exchangeCustomToken(config.webApiKey, result.customToken, config.identityToolkitBase)
      const stored: StoredSession = { uid: session.uid, refreshToken: session.refreshToken }
      await this.options.store.writeSession(stored)
      this.session = stored
      this.idMemo = { idToken: session.idToken, expiresAt: session.expiresAt }
    } catch (error) {
      if (!controller.signal.aborted) this.error = MESSAGES.signInFailed
      return
    } finally {
      if (this.signInAbort === controller) { this.signInAbort = null; this.signIn = null }
      this.emit()
    }
    await this.refresh()
  }

  private async idToken(): Promise<string> {
    const config = this.requireConfig()
    const session = this.session
    if (!session) throw new BillingError(MESSAGES.signedOutAlready)
    if (this.idMemo && this.idMemo.expiresAt - this.now() > ID_TOKEN_MARGIN_MS) return this.idMemo.idToken
    try {
      const next = await this.cloud.refreshIdToken(config.webApiKey, session.refreshToken, config.secureTokenBase)
      this.idMemo = { idToken: next.idToken, expiresAt: next.expiresAt }
      if (next.refreshToken !== session.refreshToken || (next.uid && next.uid !== session.uid)) {
        const updated: StoredSession = { uid: next.uid || session.uid, refreshToken: next.refreshToken }
        await this.options.store.writeSession(updated)
        this.session = updated
      }
      return next.idToken
    } catch (error) {
      if (error instanceof CloudError && error.status >= 400 && error.status < 500 && error.status !== 429) throw new SessionRevoked()
      throw error
    }
  }

  private async fetchAndStoreLicense(): Promise<void> {
    const config = this.requireConfig()
    const session = this.session
    if (!session) throw new BillingError(MESSAGES.signedOutAlready)
    const device = await this.deviceInfo()
    const response = await this.cloud.fetchLicense(config.functionsBase, await this.idToken(), device)
    const verified = this.cloud.verifyLicenseWithKeys(response.token, this.now(), this.publicKeys)
    if (!verified || verified.uid !== session.uid || verified.deviceId !== device.deviceId) throw new BillingError(MESSAGES.unverified)
    await this.options.store.writeLicense(response.token)
    this.token = response.token
    this.awaitingPurchase = false
    this.error = null
  }

  private async afterRefreshFailure(error: unknown, background: boolean): Promise<void> {
    if (error instanceof SessionRevoked || (error instanceof CloudError && error.code === 'UNAUTHENTICATED')) {
      await this.dropAccount()
      this.error = MESSAGES.revoked
    } else if (error instanceof CloudError && error.code === 'FAILED_PRECONDITION') {
      // Nothing is bought, or the purchase ended (refund, cancellation): the old license must not linger.
      await this.options.store.clearLicense()
      this.token = null
      this.error = null
    } else if (error instanceof CloudError && error.code === 'RESOURCE_EXHAUSTED') {
      this.error = MESSAGES.deviceLimit
    } else if (error instanceof BillingError) {
      this.error = error.message
    } else if (!background || this.summary().state.kind !== 'active') {
      this.error = MESSAGES.offline
    }
  }

  private async dropAccount(): Promise<void> {
    this.signInAbort?.abort()
    this.signInAbort = null
    this.signIn = null
    this.session = null
    this.token = null
    this.idMemo = null
    this.awaitingPurchase = false
    await this.options.store.clearSession()
    await this.options.store.clearLicense()
  }

  private async stripeLink(name: 'createCheckoutSession' | 'createPortalSession', data: unknown, purpose: ExternalPurpose, failure: string): Promise<string> {
    const config = this.requireConfig()
    if (!this.session) throw new BillingError(MESSAGES.signedOutAlready)
    let result: { url?: unknown } | undefined
    try {
      result = await this.cloud.callFunction<{ url?: unknown }>(config.functionsBase, name, data, await this.idToken())
    } catch (error) {
      if (error instanceof SessionRevoked || (error instanceof CloudError && error.code === 'UNAUTHENTICATED')) {
        await this.exclusive(() => this.dropAccount())
        this.error = MESSAGES.revoked
        this.emit()
        throw new BillingError(MESSAGES.revoked)
      }
      throw new BillingError(error instanceof CloudError && SPEAKABLE_CODES.has(error.code) && error.message ? error.message : failure)
    }
    const url = typeof result?.url === 'string' ? allowedExternalUrl(result.url, config, purpose) : null
    if (!url) throw new BillingError(MESSAGES.badLink)
    return url
  }

  private async open(url: string): Promise<void> {
    try { await this.options.openExternal(url) } catch { throw new BillingError(MESSAGES.browser) }
  }
}
