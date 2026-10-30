/**
 * Single source of truth for Stripe product/price IDs.
 *
 * The real IDs come from env (`STRIPE_PRICE_BYOK`, `STRIPE_PRICE_PRO_MONTHLY`,
 * `STRIPE_PRICE_PRO_YEARLY`). Placeholder defaults make it obvious when the
 * backend is running unconfigured — any Stripe call using `price_TBD_*` will
 * reject with an unmistakable error upstream.
 *
 * The product IDs are optional; most call-sites only need the price. We still
 * surface them here so the catalog is navigable from one file.
 */

import type { Plan } from "./shared/billing-types.js";
import { PLAN_IDS } from "./shared/billing-types.js";

export interface StripeCatalogEntry {
  productId: string;
  priceId: string;
}

export type StripeCatalog = Readonly<Record<Plan, StripeCatalogEntry>>;

const envOr = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
};

/**
 * Resolved at import time; Cloud Functions v2 loads env vars via
 * `defineSecret`/`defineString` or the runtime's own `process.env`.
 */
export const CATALOG: StripeCatalog = Object.freeze({
  byok: {
    productId: envOr("STRIPE_PRODUCT_BYOK", "prod_TBD_byok"),
    priceId: envOr("STRIPE_PRICE_BYOK", "price_TBD_byok"),
  },
  pro_monthly: {
    productId: envOr("STRIPE_PRODUCT_PRO_MONTHLY", "prod_TBD_pro_monthly"),
    priceId: envOr("STRIPE_PRICE_PRO_MONTHLY", "price_TBD_pro_monthly"),
  },
  pro_yearly: {
    productId: envOr("STRIPE_PRODUCT_PRO_YEARLY", "prod_TBD_pro_yearly"),
    priceId: envOr("STRIPE_PRICE_PRO_YEARLY", "price_TBD_pro_yearly"),
  },
});

/** Reverse-lookup: given a Stripe priceId, which plan is it? */
export function planFromPriceId(priceId: string): Plan | null {
  for (const plan of PLAN_IDS) {
    if (CATALOG[plan].priceId === priceId) return plan;
  }
  return null;
}

/** Stripe `mode` differs between one-time (BYOK) and subscriptions. */
export function checkoutModeFor(plan: Plan): "payment" | "subscription" {
  return plan === "byok" ? "payment" : "subscription";
}
