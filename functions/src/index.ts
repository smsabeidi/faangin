/**
 * Cloud Functions v2 entry point. Each endpoint is implemented in its own
 * file; we only re-export here to keep the deploy manifest tidy and to let
 * Firebase tree-shake unused imports.
 */

export { startCheckout } from "./endpoints/checkout.js";
export { stripeWebhook } from "./endpoints/stripe-webhook.js";
export {
  startDeviceCode,
  approveDeviceCode,
  pollDeviceCode,
} from "./endpoints/device-code.js";
export { refreshLicense } from "./endpoints/refresh-license.js";
export { publicLicenseKey } from "./endpoints/public-key.js";
