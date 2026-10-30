/**
 * POST /stripeWebhook
 *
 * Verifies the Stripe-Signature header, dedupes by event id, dispatches to
 * typed handlers. Each handler takes `(event, db)` so tests can run them
 * directly against the Firestore emulator or a mock Firestore.
 *
 * NB: We never mint license tokens here. The webhook writes the entitlement
 * doc; tokens are minted on sign-in (device-code success) or on refresh.
 */

import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { logger } from "firebase-functions/v2";
import Stripe from "stripe";
import type { Firestore } from "firebase-admin/firestore";
import type {
  Entitlement,
  EntitlementStatus,
  HandledStripeEvent,
  Plan,
} from "../shared/billing-types.js";
import { HANDLED_STRIPE_EVENTS } from "../shared/billing-types.js";
import { COLLECTIONS } from "../firestore-schema.js";
import { planFromPriceId } from "../stripe-catalog.js";
import { getDb } from "../firebase-admin.js";

const GRACE_SECONDS = 14 * 24 * 60 * 60;
const BYOK_UPDATE_WINDOW_SECONDS = 365 * 24 * 60 * 60;

/* ------------------------------------------------------------------ */
/* Stripe client (injectable for tests)                               */
/* ------------------------------------------------------------------ */

export interface StripeWebhookClient {
  webhooks: {
    constructEvent(payload: string | Buffer, signature: string, secret: string): Stripe.Event;
  };
}

let stripeClient: StripeWebhookClient | null = null;

export function _setStripeClientForTests(client: StripeWebhookClient | null): void {
  stripeClient = client;
}

function getStripeClient(): StripeWebhookClient {
  if (stripeClient) return stripeClient;
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  stripeClient = new Stripe(key, { apiVersion: "2024-10-28.acacia" });
  return stripeClient;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                        */
/* ------------------------------------------------------------------ */

/** Returns true if this event is new; false if it was already recorded. */
export async function recordEventIfNew(
  db: Firestore,
  event: Stripe.Event,
): Promise<boolean> {
  const ref = db.collection(COLLECTIONS.stripeEvents).doc(event.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { type: event.type, receivedAt: nowSeconds() });
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                           */
/* ------------------------------------------------------------------ */

export async function handleCheckoutCompleted(
  event: Stripe.Event,
  db: Firestore,
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const uid = session.client_reference_id ?? session.metadata?.["uid"] ?? null;
  if (!uid) {
    logger.warn("checkout.session.completed without uid", { sessionId: session.id });
    return;
  }

  // Derive plan from metadata when present, else from the first line item price.
  const metaPlan = session.metadata?.["plan"] as Plan | undefined;
  const plan: Plan | null = metaPlan ?? null;
  if (!plan) {
    logger.warn("checkout.session.completed missing plan metadata", {
      sessionId: session.id,
    });
    return;
  }

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? "";
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const now = nowSeconds();
  const periodEnd = plan === "byok" ? now + BYOK_UPDATE_WINDOW_SECONDS : now;
  const graceUntil = periodEnd + GRACE_SECONDS;

  const base: Entitlement = {
    uid,
    plan,
    status: "active",
    stripeCustomerId: customerId,
    currentPeriodEnd: periodEnd,
    graceUntil,
    devices: [],
    createdAt: now,
    updatedAt: now,
    ...(subId ? { stripeSubscriptionId: subId } : {}),
    ...(plan === "byok" ? { byokUpdateWindowEnd: periodEnd } : {}),
  };

  const ref = db.collection(COLLECTIONS.entitlements).doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, base);
      return;
    }
    // Upgrade/renew path: keep devices + createdAt, update plan + stripe refs.
    tx.set(
      ref,
      {
        plan,
        status: "active",
        stripeCustomerId: customerId,
        ...(subId ? { stripeSubscriptionId: subId } : {}),
        currentPeriodEnd: periodEnd,
        graceUntil,
        updatedAt: now,
        ...(plan === "byok" ? { byokUpdateWindowEnd: periodEnd } : {}),
      },
      { merge: true },
    );
  });
}

export async function handleSubscriptionChanged(
  event: Stripe.Event,
  db: Firestore,
): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const uid = (sub.metadata?.["uid"] as string | undefined) ?? null;
  if (!uid) {
    // Fallback: look up by subscriptionId.
    const q = await db
      .collection(COLLECTIONS.entitlements)
      .where("stripeSubscriptionId", "==", sub.id)
      .limit(1)
      .get();
    if (q.empty) {
      logger.warn("subscription event without uid or match", { subId: sub.id });
      return;
    }
    const doc = q.docs[0];
    if (!doc) return;
    await applySubscriptionUpdate(doc.ref, sub, event.type);
    return;
  }
  const ref = db.collection(COLLECTIONS.entitlements).doc(uid);
  await applySubscriptionUpdate(ref, sub, event.type);
}

async function applySubscriptionUpdate(
  ref: FirebaseFirestore.DocumentReference,
  sub: Stripe.Subscription,
  eventType: string,
): Promise<void> {
  let status: EntitlementStatus = "active";
  if (eventType === "customer.subscription.deleted" || sub.status === "canceled") {
    status = "canceled";
  } else if (sub.status === "past_due" || sub.status === "unpaid") {
    status = "grace";
  } else if (sub.status === "incomplete_expired") {
    status = "expired";
  }
  const periodEndSource = (sub as unknown as { current_period_end?: number }).current_period_end;
  const periodEnd = typeof periodEndSource === "number" ? periodEndSource : nowSeconds();
  await ref.set(
    {
      status,
      currentPeriodEnd: periodEnd,
      graceUntil: periodEnd + GRACE_SECONDS,
      updatedAt: nowSeconds(),
    },
    { merge: true },
  );
}

export async function handlePaymentFailed(
  event: Stripe.Event,
  db: Firestore,
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const subId = typeof (invoice as unknown as { subscription?: string | { id: string } }).subscription === "string"
    ? ((invoice as unknown as { subscription?: string }).subscription as string)
    : (invoice as unknown as { subscription?: { id: string } }).subscription?.id;
  if (!subId) return;
  const q = await db
    .collection(COLLECTIONS.entitlements)
    .where("stripeSubscriptionId", "==", subId)
    .limit(1)
    .get();
  if (q.empty) return;
  const doc = q.docs[0];
  if (!doc) return;
  await doc.ref.set({ status: "grace", updatedAt: nowSeconds() }, { merge: true });
}

export async function handlePaymentSucceeded(
  _event: Stripe.Event,
  _db: Firestore,
): Promise<void> {
  // Covered by subscription.updated. We ack the event (idempotency ledger
  // already recorded it) and no-op the entitlement write so we don't double
  // up on currentPeriodEnd when both events arrive.
}

export async function handleRefundOrDispute(
  event: Stripe.Event,
  db: Firestore,
): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
  if (!customerId) return;
  const q = await db
    .collection(COLLECTIONS.entitlements)
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  if (q.empty) return;
  const doc = q.docs[0];
  if (!doc) return;

  const terminalStatus: EntitlementStatus =
    event.type === "charge.dispute.created" ? "disputed" : "refunded";

  await doc.ref.set(
    { status: terminalStatus, updatedAt: nowSeconds() },
    { merge: true },
  );

  // Mark every outstanding token for this uid as revoked. Clients re-check
  // on next refresh and the Pro gateway JWT shortens the blast radius.
  const uid = doc.id;
  const revocationReason = event.type === "charge.dispute.created" ? "dispute" : "refund";
  await db.collection(COLLECTIONS.revokedJtis).add({
    revokedAt: nowSeconds(),
    reason: revocationReason,
    uid,
    marker: "all_outstanding", // sentinel: refresh-license treats any match as revoked
  });
  // Also bump an `allRevokedAt` on the entitlement so refresh-license can
  // compare against token iat without a full collection scan.
  await doc.ref.set({ allRevokedAt: nowSeconds() } as unknown as Partial<Entitlement>, {
    merge: true,
  });
  // Note: we deliberately use numeric unix seconds (not FieldValue
  // serverTimestamp) so unit tests can run against the in-memory Firestore
  // mock without extra plumbing.
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

const EVENT_SET: ReadonlySet<string> = new Set(HANDLED_STRIPE_EVENTS);

export function isHandledEvent(type: string): type is HandledStripeEvent {
  return EVENT_SET.has(type);
}

export async function dispatchEvent(event: Stripe.Event, db: Firestore): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event, db);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionChanged(event, db);
      return;
    case "invoice.payment_failed":
      await handlePaymentFailed(event, db);
      return;
    case "invoice.payment_succeeded":
      await handlePaymentSucceeded(event, db);
      return;
    case "charge.refunded":
    case "charge.dispute.created":
      await handleRefundOrDispute(event, db);
      return;
    default:
      logger.info("stripeWebhook: ignoring unhandled event", { type: event.type });
      return;
  }
}

export const stripeWebhook = onRequest(
  { cors: false },
  async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    const sig = req.headers["stripe-signature"];
    const secret = process.env["STRIPE_WEBHOOK_SECRET"];
    if (!sig || typeof sig !== "string" || !secret) {
      res.status(400).json({ error: "missing_signature" });
      return;
    }
    // req.rawBody is populated by Cloud Functions for HTTP webhooks.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "missing_body" });
      return;
    }
    let event: Stripe.Event;
    try {
      event = getStripeClient().webhooks.constructEvent(rawBody, sig, secret);
    } catch (err) {
      logger.warn("stripeWebhook signature verification failed", err);
      res.status(400).json({ error: "bad_signature" });
      return;
    }
    if (!isHandledEvent(event.type)) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }
    try {
      const db = getDb();
      const isNew = await recordEventIfNew(db, event);
      if (!isNew) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      await dispatchEvent(event, db);
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error("stripeWebhook handler failed", err);
      res.status(500).json({ error: "internal" });
    }
  },
);
