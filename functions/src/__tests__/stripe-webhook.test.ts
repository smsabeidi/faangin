import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { Firestore } from "firebase-admin/firestore";
import {
  dispatchEvent,
  handleCheckoutCompleted,
  handleSubscriptionChanged,
  isHandledEvent,
  recordEventIfNew,
} from "../endpoints/stripe-webhook.js";
import { makeMockDb } from "./mocks/firestore-mock.js";
import { COLLECTIONS } from "../firestore-schema.js";

function asDb(mock: ReturnType<typeof makeMockDb>): Firestore {
  return mock as unknown as Firestore;
}

function stripeEvent(type: string, obj: object, id = `evt_${Math.random().toString(16).slice(2)}`): Stripe.Event {
  return {
    id,
    type,
    api_version: "2025-09-30.clover",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    object: "event",
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: obj },
  } as unknown as Stripe.Event;
}

describe("stripe-webhook", () => {
  it("isHandledEvent recognises every event in the frozen allow list", () => {
    expect(isHandledEvent("checkout.session.completed")).toBe(true);
    expect(isHandledEvent("customer.subscription.updated")).toBe(true);
    expect(isHandledEvent("charge.refunded")).toBe(true);
    expect(isHandledEvent("product.created")).toBe(false);
  });

  it("recordEventIfNew is idempotent", async () => {
    const db = asDb(makeMockDb());
    const ev = stripeEvent("checkout.session.completed", {}, "evt_dup_1");
    expect(await recordEventIfNew(db, ev)).toBe(true);
    expect(await recordEventIfNew(db, ev)).toBe(false);
  });

  it("handleCheckoutCompleted creates an entitlement for a new BYOK buyer", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    const session = {
      id: "cs_byok_1",
      client_reference_id: "uid_sam",
      customer: "cus_sam",
      metadata: { plan: "byok" },
    } as unknown as Stripe.Checkout.Session;
    await handleCheckoutCompleted(stripeEvent("checkout.session.completed", session), db);
    const docs = mock._dump(COLLECTIONS.entitlements);
    expect(docs["uid_sam"]).toBeDefined();
    expect(docs["uid_sam"]?.plan).toBe("byok");
    expect(docs["uid_sam"]?.status).toBe("active");
    expect(typeof docs["uid_sam"]?.byokUpdateWindowEnd).toBe("number");
  });

  it("handleSubscriptionChanged marks the entitlement canceled on delete", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    // Seed an entitlement.
    const now = Math.floor(Date.now() / 1000);
    await db.collection(COLLECTIONS.entitlements).doc("uid_sam").set({
      uid: "uid_sam",
      plan: "pro_monthly",
      status: "active",
      stripeCustomerId: "cus_sam",
      stripeSubscriptionId: "sub_sam",
      currentPeriodEnd: now + 100,
      graceUntil: now + 200,
      devices: [],
      createdAt: now,
      updatedAt: now,
    });

    const sub = {
      id: "sub_sam",
      status: "canceled",
      metadata: { uid: "uid_sam" },
      current_period_end: now + 50,
    } as unknown as Stripe.Subscription;
    await handleSubscriptionChanged(
      stripeEvent("customer.subscription.deleted", sub),
      db,
    );
    const docs = mock._dump(COLLECTIONS.entitlements);
    expect(docs["uid_sam"]?.status).toBe("canceled");
  });

  it("dispatchEvent routes payment_failed to grace status", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    const now = Math.floor(Date.now() / 1000);
    await db.collection(COLLECTIONS.entitlements).doc("uid_pat").set({
      uid: "uid_pat",
      plan: "pro_monthly",
      status: "active",
      stripeCustomerId: "cus_pat",
      stripeSubscriptionId: "sub_pat",
      currentPeriodEnd: now + 100,
      graceUntil: now + 200,
      devices: [],
      createdAt: now,
      updatedAt: now,
    });
    const invoice = { id: "in_1", subscription: "sub_pat" } as unknown as Stripe.Invoice;
    await dispatchEvent(stripeEvent("invoice.payment_failed", invoice), db);
    const docs = mock._dump(COLLECTIONS.entitlements);
    expect(docs["uid_pat"]?.status).toBe("grace");
  });

  it("dispatchEvent on refund flips to refunded and writes a revocation", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    const now = Math.floor(Date.now() / 1000);
    await db.collection(COLLECTIONS.entitlements).doc("uid_q").set({
      uid: "uid_q",
      plan: "byok",
      status: "active",
      stripeCustomerId: "cus_q",
      currentPeriodEnd: now + 100,
      graceUntil: now + 200,
      devices: [],
      createdAt: now,
      updatedAt: now,
    });
    const charge = { id: "ch_1", customer: "cus_q" } as unknown as Stripe.Charge;
    await dispatchEvent(stripeEvent("charge.refunded", charge), db);
    const docs = mock._dump(COLLECTIONS.entitlements);
    expect(docs["uid_q"]?.status).toBe("refunded");
    const revs = mock._dump(COLLECTIONS.revokedJtis);
    expect(Object.keys(revs).length).toBeGreaterThan(0);
  });
});
