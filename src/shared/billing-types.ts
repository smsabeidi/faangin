/** Plans a signed-in user can start Checkout for. The server maps each to its own Stripe price. */
export type BillingPlan = 'byok' | 'pro_monthly' | 'pro_annual'
/** What a license carries: BYOK is the one-time key license, Pro covers both subscription cadences. */
export type LicensedPlan = 'byok' | 'pro'

/** All times are Unix milliseconds. */
export type LicenseState =
  /** This build has no accounts backend configured. */
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  /** Signed in, but nothing bought (or the purchase was refunded or ended). */
  | { kind: 'no-plan' }
  /** `pastDue`: the card failed and Stripe is retrying; access continues. `periodEnd` is Pro only. */
  | { kind: 'active'; plan: LicensedPlan; pastDue: boolean; periodEnd: number | null; cancelAtPeriodEnd: boolean }
  /** The license is past its 30 days but inside the 14-day grace window: it still works, and refreshes on reconnect. */
  | { kind: 'grace'; plan: LicensedPlan; graceUntil: number }
  /** Signed in with a stored license that is expired or cannot be verified. Reconnect to refresh it. */
  | { kind: 'locked' }

export interface SignInPrompt {
  /** Display form, ABCD-EFGH. */
  userCode: string
  verificationUrl: string
  expiresAt: number
}

export interface BillingSummary {
  state: LicenseState
  signIn: SignInPrompt | null
  /** Checkout was opened in the browser; the license is re-checked when the app regains focus. */
  awaitingPurchase: boolean
  busy: boolean
  error: string | null
  deviceName: string | null
}
