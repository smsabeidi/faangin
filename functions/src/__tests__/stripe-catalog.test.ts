import { describe, expect, it } from "vitest";
import { CATALOG, checkoutModeFor, planFromPriceId } from "../stripe-catalog.js";

describe("stripe-catalog", () => {
  it("CATALOG has an entry per plan with placeholder IDs when env unset", () => {
    expect(CATALOG.byok.priceId).toBe("price_TBD_byok");
    expect(CATALOG.pro_monthly.priceId).toBe("price_TBD_pro_monthly");
    expect(CATALOG.pro_yearly.priceId).toBe("price_TBD_pro_yearly");
  });

  it("planFromPriceId returns the matching plan", () => {
    expect(planFromPriceId(CATALOG.byok.priceId)).toBe("byok");
    expect(planFromPriceId(CATALOG.pro_monthly.priceId)).toBe("pro_monthly");
    expect(planFromPriceId(CATALOG.pro_yearly.priceId)).toBe("pro_yearly");
  });

  it("planFromPriceId returns null for an unknown price", () => {
    expect(planFromPriceId("price_bogus_42")).toBeNull();
  });

  it("checkoutModeFor maps BYOK to payment and Pro to subscription", () => {
    expect(checkoutModeFor("byok")).toBe("payment");
    expect(checkoutModeFor("pro_monthly")).toBe("subscription");
    expect(checkoutModeFor("pro_yearly")).toBe("subscription");
  });
});
