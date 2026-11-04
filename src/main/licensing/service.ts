import * as realCloud from '../faangin-cloud'
import { CloudError, LICENSE_PUBLIC_KEYS, proTransport, type AuthSession, type DeviceInfo, type DeviceSignInStart, type InferenceTransport } from '../faangin-cloud'
import type { BillingPlan, BillingSummary, SignInPrompt } from '../../shared/billing-types'
import type { AccountStore, StoredGoogleSignIn, StoredSession } from './account-store'
import { allowedExternalUrl, type CloudConfig, type ExternalPurpose } from './config'
import type { DeviceIdentity } from './device-identity'
import { deriveLicenseState } from './state'
import { startActivationServer, type ActivationLease } from './activation-server'
import { createGoogleSignIn, GOOGLE_SIGN_IN_TTL_MS, parseGoogleCallback } from './google-sign-in'

/** The slice of faangin-cloud.ts the service uses; tests pass a fake. */
export type CloudApi = Pick<typeof realCloud, 'startDeviceSignIn' | 'waitForDeviceSignIn' | 'exchangeDeviceToken' | 'exchangeOAuthCode' | 'refreshAuthSession' | 'revokeAuthSession' | 'callFunction' | 'fetchLicense' | 'verifyLicenseWithKeys'>

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
  /** Bounded reconciliation for Checkout webhooks that arrive after the browser returns. */
  purchaseRefreshMs?: number
  activationServer?: typeof startActivationServer
}

export type InferenceAccess = { kind: 'unconfigured' | 'byok' } | { kind: 'pro'; transport: InferenceTransport }

/** An error whose message is safe to show the user as is. */
export class BillingError extends Error {
  constructor(message: string) { super(message); this.name = 'BillingError' }
}

/** The server no longer accepts this sign-in: the account was disabled, deleted or its token revoked. */
class SessionRevoked extends Error {}

const PLANS: readonly BillingPlan[] = ['pro_monthly', 'pro_annual']
const DAY_MS = 24 * 60 * 60 * 1000
const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000
const FOCUS_REFRESH_GAP_MS = 10_000
const PURCHASE_REFRESH_ATTEMPTS = 12
/** Server messages for these codes are written for people (already bought, seats full, device cap). */
const SPEAKABLE_CODES = new Set(['FAILED_PRECONDITION', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE'])

const MESSAGES = {
  unconfigured: 'This build of Faangin is not connected to an accounts service.',
  signedOutAlready: 'Sign in first.',
  encryption: 'OS credential encryption is unavailable. Unlock your system credential store and try again.',
  codeExpired: 'The sign-in code expired. Start again to get a new one.',
  signInFailed: 'Sign-in could not finish. Check your connection and start again.',
  googleExpired: 'Google sign-in expired. Start again to continue.',
  googleFailed: 'Google sign-in could not finish. Try again or continue with email.',
  googleCancelled: 'Google sign-in was cancelled.',
  googleStorage: 'Faangin could not save Google sign-in securely. Try again after checking your system credential store.',
  startFailed: 'Faangin could not reach the accounts service. Check your connection and try again.',
  revoked: 'You were signed out. Sign in again to keep using your plan.',
  clearAccount: 'You were signed out, but Faangin could not remove all saved sign-in data from this device.',
  clearLicense: 'Faangin could not remove the invalid saved license from this device.',
  deviceLimit: 'This account is already active on 3 devices. A device unused for 30 days frees its slot.',
  unverified: 'This build could not verify the license it received. Update Faangin and try again.',
  offline: 'Could not reach Faangin to check your license. A license you already have keeps working offline.',
  checkout: 'Checkout could not be started. Try again in a moment.',
  portal: 'Billing management could not be opened. Try again in a moment.',
  badLink: 'Faangin received an unexpected link and did not open it.',
  browser: 'The link could not be opened in your browser.'
} as const

type GoogleSignInAttempt = StoredGoogleSignIn & { exchanging: boolean }

export class LicenseService {
  private readonly cloud: CloudApi
  private readonly publicKeys: readonly string[]
  private readonly now: () => number
  private session: StoredSession | null = null
  private token: string | null = null
  private device: DeviceInfo | null = null
  private accessMemo: { accessToken: string; expiresAt: number } | null = null
  private activation: ActivationLease | null = null
  private signIn: SignInPrompt | null = null
  private signInAbort: AbortController | null = null
  private googleSignIn: GoogleSignInAttempt | null = null
  private googleSignInTimer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private error: string | null = null
  private awaitingPurchase = false
  private expectedPurchase: 'byok' | 'pro' | null = null
  private awaitingBillingReturn = false
  private purchaseTimer: ReturnType<typeof setTimeout> | null = null
  private purchaseChecks = 0
  private lastFocusRefresh = 0
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: LicenseServiceOptions) {
    this.cloud = options.cloud ?? realCloud
    this.publicKeys = options.publicKeys ?? options.config?.licensePublicKeys ?? LICENSE_PUBLIC_KEYS
    this.now = options.now ?? Date.now
  }

  /** Loads what is stored and re-checks the license in the background. Never blocks launch and needs no network. */
  start(): Promise<void> {
    return this.exclusive(async () => {
      const config = this.options.config
      if (!config) return
      const stored = await this.options.store.readSession()
      this.session = stored?.provider === 'supabase' && stored.supabaseUrl === config.supabaseUrl ? stored : null
      if (stored && !this.session) { await this.options.store.clearSession(); await this.options.store.clearLicense() }
      this.token = await this.options.store.readLicense()
      this.device = await this.options.identity.get()
      const pending = await this.options.store.readGoogleSignIn()
      if (pending) {
        if (!this.session && pending.supabaseUrl === config.supabaseUrl && pending.expiresAt > this.now()) this.setGoogleSignIn(pending)
        else {
          await this.options.store.clearGoogleSignIn()
          if (!this.session && pending.supabaseUrl === config.supabaseUrl) this.error = MESSAGES.googleExpired
        }
      }
      this.emit()
      if (this.options.dailyRefresh !== false) {
        this.timer = setInterval(() => { void this.refresh({ background: true }) }, DAY_MS)
        this.timer.unref?.()
      }
      if (this.session) void this.refresh({ background: true })
    })
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.signInAbort?.abort()
    this.forgetGoogleSignIn()
    void this.closeActivation()
    if (this.purchaseTimer) clearTimeout(this.purchaseTimer)
    this.purchaseTimer = null
    this.purchaseChecks = PURCHASE_REFRESH_ATTEMPTS
  }

  summary(): BillingSummary {
    const raw = this.token ? this.cloud.verifyLicenseWithKeys(this.token, this.now(), this.publicKeys) : null
    const verified = raw && this.session && this.device && raw.uid === this.session.uid && raw.deviceId === this.device.deviceId ? raw : null
    return {
      state: deriveLicenseState({ configured: this.options.config !== null, signedIn: this.session !== null, hasToken: this.token !== null, verified }),
      signIn: this.signIn,
      googleSignInPending: this.googleSignIn !== null,
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
    const controller = new AbortController()
    this.signInAbort = controller
    await this.exclusive(async () => {
      if (controller.signal.aborted) return
      await this.clearGoogleSignIn()
      await this.closeActivation()
    })
    if (controller.signal.aborted || this.signInAbort !== controller) return this.summary()
    this.signIn = null
    this.error = null
    this.emit()
    let start: DeviceSignInStart
    try { start = await this.cloud.startDeviceSignIn(config.functionsBase, await this.deviceInfo(), config.publishableKey) } catch {
      if (controller.signal.aborted) return this.summary()
      if (this.signInAbort === controller) this.signInAbort = null
      throw new BillingError(MESSAGES.startFailed)
    }
    if (controller.signal.aborted || this.signInAbort !== controller) return this.summary()
    const expiresAt = this.now() + start.expiresIn * 1000
    const activation = await (this.options.activationServer ?? startActivationServer)({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, functionsBase: config.functionsBase, userCode: start.userCode, deviceName: (await this.deviceInfo()).deviceName, expiresAt })
    if (controller.signal.aborted || this.signInAbort !== controller) { await activation.close(); return this.summary() }
    this.activation = activation
    const url = activation.url
    this.signIn = { userCode: start.userCode, verificationUrl: url, expiresAt }
    this.emit()
    void this.options.openExternal(url).catch(() => { /* the code and link stay on screen */ })
    void this.finishSignIn(config, start, controller, activation)
    return this.summary()
  }

  cancelSignIn(): BillingSummary {
    this.signInAbort?.abort()
    this.signInAbort = null
    this.signIn = null
    void this.closeActivation()
    this.emit()
    return this.summary()
  }

  startGoogleSignIn(): Promise<BillingSummary> {
    return this.exclusive(async () => {
      const config = this.requireConfig()
      if (this.session || this.googleSignIn) return this.summary()
      if (!this.options.encryptionAvailable()) throw new BillingError(MESSAGES.encryption)
      this.cancelSignIn()
      const { url, verifier } = createGoogleSignIn(config.supabaseUrl)
      const pending = { verifier, supabaseUrl: config.supabaseUrl, expiresAt: this.now() + GOOGLE_SIGN_IN_TTL_MS }
      try { await this.options.store.writeGoogleSignIn(pending) } catch { throw new BillingError(MESSAGES.googleStorage) }
      this.setGoogleSignIn(pending)
      this.error = null
      this.emit()
      try { await this.open(url) } catch (error) {
        await this.endGoogleSignIn(null)
        throw error
      }
      return this.summary()
    })
  }

  cancelGoogleSignIn(): Promise<BillingSummary> {
    return this.exclusive(async () => {
      if (this.googleSignIn) await this.endGoogleSignIn(null)
      return this.summary()
    })
  }

  async handleGoogleCallback(raw: string): Promise<void> {
    const callback = parseGoogleCallback(raw)
    const config = this.options.config
    if (!callback || !config) return
    const attempt = await this.exclusive(async () => {
      const pending = this.googleSignIn
      if (!pending || pending.exchanging || this.session) return null
      if (pending.expiresAt <= this.now()) { await this.endGoogleSignIn(MESSAGES.googleExpired); return null }
      if (callback.kind !== 'code') {
        await this.endGoogleSignIn(callback.kind === 'cancelled' ? MESSAGES.googleCancelled : MESSAGES.googleFailed)
        return null
      }
      pending.exchanging = true
      return pending
    })
    if (!attempt || callback.kind !== 'code') return

    // Supabase checks this code against the S256 challenge for this attempt. Its provider state is handled by Supabase.
    let session: AuthSession | undefined
    try { session = await this.cloud.exchangeOAuthCode(config.supabaseUrl, config.publishableKey, callback.code, attempt.verifier) } catch { /* Show a retryable error below. */ }
    const signedIn = await this.exclusive(async () => {
      if (this.googleSignIn !== attempt) return false
      try {
        await this.clearGoogleSignIn()
        if (session) await this.storeAuthSession(config, session)
        this.error = session ? null : MESSAGES.googleFailed
      } catch {
        this.error = MESSAGES.googleStorage
      }
      this.emit()
      return this.error === null
    })
    if (signedIn) await this.refresh()
    else if (session) void this.cloud.revokeAuthSession(config.supabaseUrl, config.publishableKey, session.accessToken).catch(() => {})
  }

  /** Renderer links may reopen only this exact live lease, never arbitrary loopback services. */
  isActivationUrl(raw: string): boolean {
    return !!this.activation && this.signIn?.verificationUrl === raw && this.signIn.expiresAt > this.now()
  }

  signOut(): Promise<BillingSummary> {
    this.cancelSignIn()
    return this.exclusive(async () => {
      const config = this.options.config, session = this.session, access = this.accessMemo
      const cleared = await this.dropAccount()
      this.error = cleared ? null : MESSAGES.clearAccount
      this.emit()
      if (config && session) {
        void (async () => {
          const current = access && access.expiresAt > this.now() ? access : await this.cloud.refreshAuthSession(config.supabaseUrl, config.publishableKey, session.refreshToken)
          if ('uid' in current && current.uid !== session.uid) return
          await this.cloud.revokeAuthSession(config.supabaseUrl, config.publishableKey, current.accessToken)
        })().catch(() => {})
      }
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
  openCheckout(plan: BillingPlan): Promise<BillingSummary> {
    return this.exclusive(async () => {
      if (!PLANS.includes(plan)) throw new BillingError('Unknown plan.')
      const url = await this.stripeLink('createCheckoutSession', { plan }, 'checkout', MESSAGES.checkout)
      this.awaitingPurchase = true
      this.expectedPurchase = 'pro'
      try { await this.open(url) } catch (error) { this.awaitingPurchase = false; this.expectedPurchase = null; throw error }
      this.beginPurchaseChecks()
      this.error = null
      this.emit()
      return this.summary()
    })
  }

  openPortal(): Promise<BillingSummary> {
    return this.exclusive(async () => {
      await this.open(await this.stripeLink('createPortalSession', {}, 'portal', MESSAGES.portal))
      this.awaitingBillingReturn = true
      this.beginPurchaseChecks()
      return this.summary()
    })
  }

  /** Call when a window gains focus: after Checkout the license is picked up without a manual refresh. */
  onWindowFocus(): void {
    if ((!this.awaitingPurchase && !this.awaitingBillingReturn) || !this.session || this.now() - this.lastFocusRefresh < FOCUS_REFRESH_GAP_MS) return
    this.lastFocusRefresh = this.now()
    void this.refresh({ background: true })
  }

  /** Account credentials and the gateway transport stay in the main process. */
  requireInferenceAccess(): Promise<InferenceAccess> {
    return this.exclusive(async () => {
      const state = this.summary().state
      if (state.kind === 'unavailable') return { kind: 'unconfigured' }
      if (state.kind === 'signed-out') throw new BillingError('Sign in in Settings → Plan & account before requesting assistance.')
      if (state.kind === 'no-plan') throw new BillingError('Choose a plan in Settings → Plan & account before requesting assistance.')
      if (state.kind === 'locked') throw new BillingError('Check your license in Settings → Plan & account before requesting assistance.')
      if (state.plan === 'byok') return { kind: 'byok' }
      const gatewayBase = this.requireConfig().gatewayBase
      if (!gatewayBase) throw new BillingError('This build has no Pro gateway configured. Update Faangin or contact support.')
      try { await this.accessToken() } catch (error) {
        await this.afterRefreshFailure(error, false)
        this.emit()
        throw new BillingError(this.error ?? MESSAGES.offline)
      }
      const uid = this.session!.uid
      return { kind: 'pro', transport: proTransport(() => {
        if (this.session?.uid !== uid || !this.accessMemo) throw new BillingError(MESSAGES.signedOutAlready)
        return this.accessMemo.accessToken
      }, gatewayBase, this.requireConfig().publishableKey) }
    })
  }

  async proAccess(): Promise<{ transport: InferenceTransport } | null> {
    const access = await this.requireInferenceAccess()
    return access.kind === 'pro' ? { transport: access.transport } : null
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

  private setGoogleSignIn(pending: StoredGoogleSignIn): void {
    const attempt = this.googleSignIn = { ...pending, exchanging: false }
    this.googleSignInTimer = setTimeout(() => {
      void this.exclusive(async () => {
        if (this.googleSignIn === attempt) await this.endGoogleSignIn(MESSAGES.googleExpired)
      }).catch(() => {})
    }, pending.expiresAt - this.now())
    this.googleSignInTimer.unref()
  }

  private forgetGoogleSignIn(): void {
    this.googleSignIn = null
    if (this.googleSignInTimer) clearTimeout(this.googleSignInTimer)
    this.googleSignInTimer = null
  }

  private async clearGoogleSignIn(): Promise<void> {
    this.forgetGoogleSignIn()
    await this.options.store.clearGoogleSignIn()
  }

  private async endGoogleSignIn(error: string | null): Promise<void> {
    try { await this.clearGoogleSignIn(); this.error = error }
    catch { this.error = MESSAGES.googleStorage }
    this.emit()
  }

  private async storeAuthSession(config: CloudConfig, session: AuthSession, signal?: AbortSignal): Promise<boolean> {
    const stored: StoredSession = { uid: session.uid, refreshToken: session.refreshToken, provider: 'supabase', supabaseUrl: config.supabaseUrl }
    await this.options.store.writeSession(stored)
    if (signal?.aborted) {
      if (this.session) await this.options.store.writeSession(this.session)
      else await this.options.store.clearSession()
      return false
    }
    this.session = stored
    this.accessMemo = { accessToken: session.accessToken, expiresAt: session.expiresAt }
    return true
  }

  private async finishSignIn(config: CloudConfig, start: DeviceSignInStart, controller: AbortController, activation: ActivationLease): Promise<void> {
    // Email confirmations and password recovery remain useful after the device code expires.
    // A fresh sign-in, explicit cancellation, disposal or the callback server's own one-hour limit closes it.
    let keepCallback = false
    let exchanged: AuthSession | undefined
    let accepted = false
    try {
      const result = await this.cloud.waitForDeviceSignIn(config.functionsBase, start, { signal: controller.signal, publishableKey: config.publishableKey })
      if (controller.signal.aborted || this.signInAbort !== controller) return
      if (result.status === 'aborted') return
      if (result.status === 'expired') { keepCallback = true; this.error = MESSAGES.codeExpired; return }
      const session = await this.cloud.exchangeDeviceToken(config.supabaseUrl, config.publishableKey, result.tokenHash, result.uid)
      exchanged = session
      await this.exclusive(async () => {
        if (controller.signal.aborted || this.signInAbort !== controller) return
        accepted = await this.storeAuthSession(config, session, controller.signal)
      })
    } catch (error) {
      if (!controller.signal.aborted) { keepCallback = true; this.error = MESSAGES.signInFailed }
      return
    } finally {
      if (exchanged && !accepted) void this.cloud.revokeAuthSession(config.supabaseUrl, config.publishableKey, exchanged.accessToken).catch(() => {})
      if (!keepCallback || controller.signal.aborted) {
        await activation.close()
        if (this.activation === activation) this.activation = null
      }
      if (this.signInAbort === controller) { this.signInAbort = null; this.signIn = null }
      this.emit()
    }
    if (!controller.signal.aborted) await this.refresh()
  }

  private async accessToken(): Promise<string> {
    const config = this.requireConfig()
    const session = this.session
    if (!session) throw new BillingError(MESSAGES.signedOutAlready)
    if (this.accessMemo && this.accessMemo.expiresAt - this.now() > ACCESS_TOKEN_MARGIN_MS) return this.accessMemo.accessToken
    try {
      const next = await this.cloud.refreshAuthSession(config.supabaseUrl, config.publishableKey, session.refreshToken)
      if (next.uid && next.uid !== session.uid) throw new SessionRevoked()
      if (next.refreshToken !== session.refreshToken) {
        const updated: StoredSession = { uid: session.uid, refreshToken: next.refreshToken, provider: 'supabase', supabaseUrl: config.supabaseUrl }
        await this.options.store.writeSession(updated)
        this.session = updated
      }
      this.accessMemo = { accessToken: next.accessToken, expiresAt: next.expiresAt }
      return next.accessToken
    } catch (error) {
      if (error instanceof CloudError && (['UNAUTHENTICATED', 'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'user_not_found', 'user_banned', 'invalid_grant'].includes(error.code))) throw new SessionRevoked()
      throw error
    }
  }

  private async fetchAndStoreLicense(): Promise<void> {
    const config = this.requireConfig()
    const session = this.session
    if (!session) throw new BillingError(MESSAGES.signedOutAlready)
    const device = await this.deviceInfo()
    const response = await this.cloud.fetchLicense(config.functionsBase, await this.accessToken(), device, config.publishableKey)
    const verified = this.cloud.verifyLicenseWithKeys(response.token, this.now(), this.publicKeys)
    if (!verified || verified.uid !== session.uid || verified.deviceId !== device.deviceId) throw new BillingError(MESSAGES.unverified)
    await this.options.store.writeLicense(response.token)
    this.token = response.token
    if (this.awaitingPurchase && verified.plan === this.expectedPurchase) {
      this.awaitingPurchase = false
      this.expectedPurchase = null
    }
    this.error = null
  }

  private async afterRefreshFailure(error: unknown, background: boolean): Promise<void> {
    if (error instanceof SessionRevoked || (error instanceof CloudError && error.code === 'UNAUTHENTICATED')) {
      this.error = await this.dropAccount() ? MESSAGES.revoked : MESSAGES.clearAccount
    } else if (error instanceof CloudError && (error.code === 'FAILED_PRECONDITION' || error.code === 'RESOURCE_EXHAUSTED')) {
      // A server denial invalidates the cached license, including when the device's slot has been reassigned.
      this.token = null
      this.error = error.code === 'RESOURCE_EXHAUSTED' ? MESSAGES.deviceLimit : null
      try { await this.options.store.clearLicense() } catch { this.error = MESSAGES.clearLicense }
    } else if (error instanceof BillingError) {
      this.error = error.message
    } else if (!background || !['active', 'grace'].includes(this.summary().state.kind)) {
      this.error = MESSAGES.offline
    }
  }

  private async dropAccount(): Promise<boolean> {
    this.signInAbort?.abort()
    this.signInAbort = null
    this.signIn = null
    this.session = null
    this.token = null
    this.accessMemo = null
    this.awaitingPurchase = false
    this.expectedPurchase = null
    this.awaitingBillingReturn = false
    if (this.purchaseTimer) clearTimeout(this.purchaseTimer)
    this.purchaseTimer = null
    const cleanup = await Promise.allSettled([
      this.closeActivation(),
      this.clearGoogleSignIn(),
      this.options.store.clearSession(),
      this.options.store.clearLicense()
    ])
    return cleanup.every(result => result.status === 'fulfilled')
  }

  private async stripeLink(name: 'createCheckoutSession' | 'createPortalSession', data: unknown, purpose: ExternalPurpose, failure: string): Promise<string> {
    const config = this.requireConfig()
    if (!this.session) throw new BillingError(MESSAGES.signedOutAlready)
    let result: { url?: unknown } | undefined
    try {
      result = await this.cloud.callFunction<{ url?: unknown }>(config.functionsBase, name, data, await this.accessToken(), config.publishableKey)
    } catch (error) {
      if (error instanceof SessionRevoked || (error instanceof CloudError && error.code === 'UNAUTHENTICATED')) {
        this.error = await this.dropAccount() ? MESSAGES.revoked : MESSAGES.clearAccount
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

  private async closeActivation(): Promise<void> {
    const activation = this.activation
    this.activation = null
    await activation?.close()
  }

  private beginPurchaseChecks(): void {
    if (this.purchaseTimer) clearTimeout(this.purchaseTimer)
    this.purchaseChecks = 0
    this.schedulePurchaseCheck()
  }

  private schedulePurchaseCheck(): void {
    if ((!this.awaitingPurchase && !this.awaitingBillingReturn) || !this.session || this.purchaseChecks >= PURCHASE_REFRESH_ATTEMPTS) return
    this.purchaseTimer = setTimeout(() => {
      this.purchaseTimer = null
      this.purchaseChecks += 1
      void this.refresh({ background: true }).finally(() => { this.schedulePurchaseCheck() })
    }, this.options.purchaseRefreshMs ?? 5_000)
    this.purchaseTimer.unref?.()
  }
}
