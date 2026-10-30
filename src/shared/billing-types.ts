/**
 * Shared contracts between the Electron app, the Firebase Cloud Functions
 * backend, and the website. Treat as a frozen schema while the billing feature
 * is in flight — if a field must change, change it here first and update every
 * consumer.
 *
 * Pricing (adopted 2026-10-27, memory faangin-pricing-model):
 *   - BYOK:        $10 one-time, bring-your-own OpenAI key, perpetual on the
 *                  current major with ~12 months of updates.
 *   - PRO_MONTHLY: $14.99 / month, gpt-transcribe gateway, printed allowances.
 *   - PRO_YEARLY:  $144 / year  (equivalent $12/mo billed yearly).
 *
 * License tokens are KMS-signed Ed25519 JWTs with a 30-day lifetime plus
 * a 14-day grace window; a user can activate up to 3 Macs per entitlement.
 */

export type Plan = "byok" | "pro_monthly" | "pro_yearly";

export const PLAN_IDS: readonly Plan[] = ["byok", "pro_monthly", "pro_yearly"] as const;

export type EntitlementStatus =
  | "active"
  | "grace"       // past token expiry, inside the 14-day grace window
  | "expired"
  | "canceled"
  | "refunded"
  | "disputed";

/** Hashes identifying a given Mac install; never raw hardware IDs. */
export interface DeviceDescriptor {
  deviceId: string;         // sha256 of (hostname + machineId + salt), 64 hex
  label: string;            // human-visible: e.g. "Sam's MacBook Pro"
  activatedAt: number;      // unix seconds
  lastSeenAt: number;       // unix seconds
}

export interface Entitlement {
  uid: string;              // Firebase auth uid
  plan: Plan;
  status: EntitlementStatus;
  stripeCustomerId: string;
  stripeSubscriptionId?: string;    // absent for BYOK one-time
  currentPeriodEnd: number;         // unix seconds; for BYOK: purchase + ~1yr
  graceUntil: number;               // unix seconds (currentPeriodEnd + 14d)
  devices: DeviceDescriptor[];      // max 3
  byokUpdateWindowEnd?: number;     // BYOK only, when free updates lapse
  createdAt: number;
  updatedAt: number;
}

/**
 * Ed25519-signed license token payload. The envelope on the wire is a compact
 * JWT ("header.payload.signature"); this interface is the decoded payload.
 */
export interface LicenseTokenPayload {
  iss: "faangin-license-v1";
  sub: string;              // uid
  aud: "faangin-app";
  iat: number;              // issued-at, unix seconds
  exp: number;              // iat + 30 days
  nbf: number;              // iat - 60 seconds
  jti: string;              // 128-bit random, for revocation lookups
  plan: Plan;
  status: EntitlementStatus;
  deviceId: string;         // the specific Mac this token activates
  periodEnd: number;        // currentPeriodEnd mirrored for offline reads
  graceUntil: number;
}

/** Public key material for verifying tokens inside the Electron app. */
export interface LicensePublicKey {
  kid: string;              // key id, printed in the JWT header
  alg: "EdDSA";
  publicKey: string;        // base64url-encoded 32-byte Ed25519 public key
}

/* ------------------------------------------------------------------ */
/* Device-code sign-in flow                                           */
/* ------------------------------------------------------------------ */

export interface DeviceCodeStart {
  deviceCode: string;       // app polls with this; never shown to user
  userCode: string;         // 6-8 chars, shown in-app, typed on website
  verificationUri: string;  // https://faangin.app/sign-in
  verificationUriComplete: string;  // includes userCode as a param
  expiresIn: number;        // seconds until deviceCode becomes invalid
  interval: number;         // seconds, polling interval
}

export type DeviceCodePollStatus =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "success"; licenseToken: string; entitlement: Entitlement };

/* ------------------------------------------------------------------ */
/* Checkout / Stripe plumbing                                         */
/* ------------------------------------------------------------------ */

export interface CheckoutStartRequest {
  plan: Plan;
  uid: string | null;       // null if this is a first-time purchase
  email?: string;
  successPath?: string;     // defaults to /thanks
  cancelPath?: string;      // defaults to /pricing
}

export interface CheckoutStartResponse {
  checkoutUrl: string;      // Stripe-hosted
  sessionId: string;
}

/** Stripe webhook event types we ingest. */
export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
] as const;

export type HandledStripeEvent = (typeof HANDLED_STRIPE_EVENTS)[number];

/* ------------------------------------------------------------------ */
/* Pro gateway usage counters                                         */
/* ------------------------------------------------------------------ */

/**
 * Per-period usage, mirrored from the Pro gateway so the Settings panel can
 * show allowance consumption. The gateway is the source of truth; the app
 * reads this through a Cloud Function that aggregates gateway metrics.
 */
export interface ProUsageSnapshot {
  periodStart: number;      // unix seconds
  periodEnd: number;
  transcribedSeconds: number;    // billed audio-in seconds this period
  transcribedBudgetSeconds: number;  // 20h = 72000
  handsFreeCount: number;
  handsFreeBudget: number;       // ≥1500
  fastCount: number;
  fastBudget: number;            // ≥500
  smartCount: number;
  smartBudget: number;           // ≥25
  dollarBackstopUsed: number;    // cents this period
  dollarBackstopCap: number;     // 1600 (= $16)
  dailyBackstopUsed: number;     // cents this UTC day
  dailyBackstopCap: number;      // 1100 (= $11)
  rampingUntil: number;          // unix seconds; new subs capped ~30% to this
}
