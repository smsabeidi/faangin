import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { handleStartCheckout, type StripeCheckoutClient } from "../endpoints/checkout.js";

function makeMockStripe(): { client: StripeCheckoutClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => {
    return {
      id: "cs_test_123",
      url: "https://checkout.stripe.test/pay/cs_test_123",
      mode: params.mode,
      metadata: params.metadata,
    } as unknown as Stripe.Checkout.Session;
  });
  const client: StripeCheckoutClient = {
    checkout: { sessions: { create } },
  };
  return { client, create };
}

describe("handleStartCheckout", () => {
  it("returns a checkout URL and session id for a valid Pro Yearly request", async () => {
    const { client, create } = makeMockStripe();
    const result = await handleStartCheckout(
      { plan: "pro_yearly", uid: "uid_abc", email: "sam@example.com" },
      client,
    );
    expect(result.sessionId).toBe("cs_test_123");
    expect(result.checkoutUrl).toContain("checkout.stripe.test");
    const call = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(call.mode).toBe("subscription");
    expect(call.client_reference_id).toBe("uid_abc");
    expect(call.metadata).toEqual({ plan: "pro_yearly" });
  });

  it("uses payment mode and no subscription_data for BYOK", async () => {
    const { client, create } = makeMockStripe();
    await handleStartCheckout({ plan: "byok", uid: null }, client);
    const call = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(call.mode).toBe("payment");
    expect(call.subscription_data).toBeUndefined();
    expect(call.client_reference_id).toBeUndefined();
  });

  it("rejects invalid plan values at the schema level", async () => {
    const { client } = makeMockStripe();
    await expect(
      handleStartCheckout({ plan: "enterprise", uid: null }, client),
    ).rejects.toThrow();
  });

  it("throws when Stripe returns no URL", async () => {
    const client: StripeCheckoutClient = {
      checkout: {
        sessions: {
          create: vi.fn(async () => ({ id: "cs_test_x", url: null } as unknown as Stripe.Checkout.Session)),
        },
      },
    };
    await expect(
      handleStartCheckout({ plan: "pro_monthly", uid: "uid_1" }, client),
    ).rejects.toThrow(/checkout URL/);
  });
});
