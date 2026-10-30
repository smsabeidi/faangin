import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  deviceCodeDocSchema,
  entitlementSchema,
  revokedJtiDocSchema,
  stripeEventDocSchema,
} from "../firestore-schema.js";

const SIXTY_FOUR_HEX = "a".repeat(64);

describe("firestore-schema", () => {
  it("COLLECTIONS enumerates every billing collection", () => {
    expect(Object.values(COLLECTIONS).sort()).toEqual(
      ["deviceCodes", "entitlements", "revokedJtis", "stripeEvents"],
    );
  });

  it("entitlementSchema accepts a valid record and rejects a bad plan", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      entitlementSchema.parse({
        uid: "uid_1",
        plan: "pro_monthly",
        status: "active",
        stripeCustomerId: "cus_1",
        currentPeriodEnd: now + 100,
        graceUntil: now + 200,
        devices: [],
        createdAt: now,
        updatedAt: now,
      }),
    ).not.toThrow();
    expect(() =>
      entitlementSchema.parse({
        uid: "uid_1",
        plan: "enterprise",
        status: "active",
        stripeCustomerId: "cus_1",
        currentPeriodEnd: now + 100,
        graceUntil: now + 200,
        devices: [],
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
  });

  it("entitlementSchema caps devices at 3", () => {
    const now = Math.floor(Date.now() / 1000);
    const d = { deviceId: SIXTY_FOUR_HEX, label: "L", activatedAt: now, lastSeenAt: now };
    expect(() =>
      entitlementSchema.parse({
        uid: "uid_1",
        plan: "pro_monthly",
        status: "active",
        stripeCustomerId: "cus_1",
        currentPeriodEnd: now + 100,
        graceUntil: now + 200,
        devices: [d, d, d, d],
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
  });

  it("deviceCodeDocSchema requires a 6-8 char uppercase user code", () => {
    const base = {
      userCode: "ABC123",
      deviceCode: "x".repeat(64),
      expiresAt: 1_000_000_000,
      status: "pending" as const,
      uid: null,
      deviceId: null,
      deviceLabel: null,
      createdAt: 1,
      lastPolledAt: null,
      interval: 5,
    };
    expect(() => deviceCodeDocSchema.parse(base)).not.toThrow();
    expect(() => deviceCodeDocSchema.parse({ ...base, userCode: "abc123" })).toThrow();
  });

  it("stripeEventDocSchema accepts a known event type only", () => {
    expect(() =>
      stripeEventDocSchema.parse({ type: "charge.refunded", receivedAt: 1 }),
    ).not.toThrow();
    expect(() =>
      stripeEventDocSchema.parse({ type: "something.else", receivedAt: 1 }),
    ).toThrow();
  });

  it("revokedJtiDocSchema accepts a valid revocation", () => {
    expect(() =>
      revokedJtiDocSchema.parse({ revokedAt: 1, reason: "refund", uid: "uid_1" }),
    ).not.toThrow();
  });
});
