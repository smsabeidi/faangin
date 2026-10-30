/**
 * POST /startCheckout
 *
 * Validates a CheckoutStartRequest and returns a Stripe Checkout URL. We keep
 * the Stripe client behind a getter so tests can inject a mock without having
 * to touch module state.
 */

import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { logger } from "firebase-functions/v2";
import Stripe from "stripe";
import { z } from "zod";
import type {
  CheckoutStartRequest,
  CheckoutStartResponse,
  Plan,
} from "../shared/billing-types.js";
import { PLAN_IDS } from "../shared/billing-types.js";
import { CATALOG, checkoutModeFor } from "../stripe-catalog.js";
import { applyCors, websiteOrigin } from "../http-util.js";

/** Narrowed to the one method we use so tests only need to mock this. */
export interface StripeCheckoutClient {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session>;
    };
  };
}

let stripeClient: StripeCheckoutClient | null = null;

export function _setStripeClientForTests(client: StripeCheckoutClient | null): void {
  stripeClient = client;
}

function getStripeClient(): StripeCheckoutClient {
  if (stripeClient) return stripeClient;
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  stripeClient = new Stripe(key, { apiVersion: "2024-10-28.acacia" }) as unknown as StripeCheckoutClient;
  return stripeClient;
}

const checkoutRequestSchema = z.object({
  plan: z.enum([...PLAN_IDS] as [Plan, ...Plan[]]),
  uid: z.string().min(1).nullable(),
  email: z.string().email().optional(),
  successPath: z.string().startsWith("/").optional(),
  cancelPath: z.string().startsWith("/").optional(),
}) satisfies z.ZodType<CheckoutStartRequest>;

export async function handleStartCheckout(
  body: unknown,
  stripe: StripeCheckoutClient,
): Promise<CheckoutStartResponse> {
  const parsed = checkoutRequestSchema.parse(body);
  const plan: Plan = parsed.plan;
  const origin = websiteOrigin();
  const successUrl = `${origin}${parsed.successPath ?? "/thanks"}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}${parsed.cancelPath ?? "/pricing"}`;

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: checkoutModeFor(plan),
    line_items: [{ price: CATALOG[plan].priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { plan },
    ...(parsed.email ? { customer_email: parsed.email } : {}),
    ...(parsed.uid ? { client_reference_id: parsed.uid } : {}),
    ...(plan !== "byok" ? { subscription_data: { metadata: { plan } } } : {}),
  };

  const session = await stripe.checkout.sessions.create(params);
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return { checkoutUrl: session.url, sessionId: session.id };
}

export const startCheckout = onRequest(
  { cors: false },
  async (req: Request, res: Response): Promise<void> => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      const result = await handleStartCheckout(req.body, getStripeClient());
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "invalid_request", details: err.errors });
        return;
      }
      logger.error("startCheckout failed", err);
      res.status(500).json({ error: "internal" });
    }
  },
);
