import { defineSecret } from 'firebase-functions/params'

/** One region for every function; Firestore's own location is chosen once in the console. */
export const REGION = 'us-central1'

// Secrets live in Secret Manager and are typed in by the owner (firebase functions:secrets:set NAME).
// Never read them from process.env outside the emulator (.secret.local).
export const STRIPE_CHECKOUT_KEY = defineSecret('STRIPE_CHECKOUT_KEY')   // rk_: write Checkout Sessions, Customers, Portal; read Prices, Subscriptions
export const STRIPE_WEBHOOK_KEY = defineSecret('STRIPE_WEBHOOK_KEY')     // rk_: read-only (sessions, subscriptions, invoices, charges, refunds, disputes)
export const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET') // whsec_
export const LICENSE_SIGNING_KEY = defineSecret('LICENSE_SIGNING_KEY')   // Ed25519 private key, PKCS#8 PEM

/** Stripe prices are found by lookup key; the client never sends a price or amount. */
export const PRICE_LOOKUP = {
  byok: 'faangin_byok_v1',
  pro_monthly: 'faangin_pro_monthly',
  pro_annual: 'faangin_pro_annual'
} as const
export type Plan = keyof typeof PRICE_LOOKUP

export const PRODUCTION_PROJECT_ID = 'faangin-prod'

/** The Firebase/GCP project this code runs in; '' in plain node scripts. Deployed functions and the emulator both set FIREBASE_CONFIG. */
export function projectId(): string {
  const config = process.env.FIREBASE_CONFIG
  if (config?.startsWith('{')) {
    try {
      const fromConfig = (JSON.parse(config) as { projectId?: string }).projectId
      if (fromConfig) return fromConfig
    } catch { /* fall through to the plain variables */ }
  }
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || ''
}

/**
 * Where hosted pages live (activate, billing return pages): FAANGIN_HOSTING_ORIGIN when set, otherwise this project's own
 * Hosting site, so production can never hand out staging URLs because an env file went missing.
 */
export function hostingOrigin(): string {
  const fromEnv = process.env.FAANGIN_HOSTING_ORIGIN
  if (fromEnv) return fromEnv
  const project = projectId()
  return project ? `https://${project}.web.app` : 'https://faangin-staging.web.app'
}

/**
 * Whether this deployment may see live-mode Stripe events: STRIPE_EXPECT_LIVEMODE when it is exactly 'true' or 'false',
 * otherwise true only in the production project, so a missing env file fails closed (prod rejects test events, staging live ones).
 */
export function expectLivemode(): boolean {
  const flag = process.env.STRIPE_EXPECT_LIVEMODE
  if (flag === 'true' || flag === 'false') return flag === 'true'
  return projectId() === PRODUCTION_PROJECT_ID
}

/** Tags every Checkout Session so the flow can be compared in the Stripe Dashboard (API 2026-03-25+). Fixed random suffix, per Stripe. */
export const CHECKOUT_INTEGRATION_IDENTIFIER = 'faangin_activate_kwdrtpzm'
/** createPortalSession uses the Customer Portal configuration carrying this metadata (created by scripts/stripe-setup.mjs portal). */
export const PORTAL_CONFIGURATION_TAG = { key: 'faangin', value: 'v1' } as const

export const DEVICE_LIMIT = 3
export const DEVICE_ACTIVE_WINDOW_DAYS = 30
export const LICENSE_TTL_DAYS = 30
export const LICENSE_GRACE_DAYS = 14
export const DEVICE_CODE_TTL_SECONDS = 600
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5
export const RAMP_DAYS = 14

/** Tests point the Stripe SDK at a local fake (http://127.0.0.1:PORT). Unset in deployed code. */
export const STRIPE_API_BASE = process.env.STRIPE_API_BASE
