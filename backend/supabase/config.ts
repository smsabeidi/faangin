/** Environment-independent account constants; secrets are injected by the Edge entry points. */
export const PRICE_LOOKUP = { pro_monthly: 'faangin_pro_monthly_v2', pro_annual: 'faangin_pro_annual_v2' } as const
export type Plan = keyof typeof PRICE_LOOKUP
export const CHECKOUT_PRICE_USD_CENTS: Record<Plan, number> = { pro_monthly: 4_999, pro_annual: 35_988 }
export const LEGACY_BYOK_PRICE = { lookupKey: 'faangin_byok_v1', amountUsdCents: 1_000 } as const
export function isCheckoutPlan(value: unknown): value is Plan {
  return typeof value === 'string' && Object.hasOwn(PRICE_LOOKUP, value)
}
export const CHECKOUT_INTEGRATION_IDENTIFIER = 'faangin_activate_kwdrtpzm'
export const PORTAL_CONFIGURATION_TAG = { key: 'faangin', value: 'v1' } as const
export const DEVICE_LIMIT = 3
export const DEVICE_ACTIVE_WINDOW_DAYS = 30
export const LICENSE_TTL_DAYS = 30
export const LICENSE_GRACE_DAYS = 14
export const DEVICE_CODE_TTL_SECONDS = 600
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5
export const RAMP_DAYS = 14
