/** Environment-independent account constants; secrets are injected by the Edge entry points. */
export const PRICE_LOOKUP = { byok: 'faangin_byok_v1', pro_monthly: 'faangin_pro_monthly', pro_annual: 'faangin_pro_annual' } as const
export type Plan = keyof typeof PRICE_LOOKUP
export const CHECKOUT_INTEGRATION_IDENTIFIER = 'faangin_activate_kwdrtpzm'
export const PORTAL_CONFIGURATION_TAG = { key: 'faangin', value: 'v1' } as const
export const DEVICE_LIMIT = 3
export const DEVICE_ACTIVE_WINDOW_DAYS = 30
export const LICENSE_TTL_DAYS = 30
export const LICENSE_GRACE_DAYS = 14
export const DEVICE_CODE_TTL_SECONDS = 600
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5
export const RAMP_DAYS = 14
