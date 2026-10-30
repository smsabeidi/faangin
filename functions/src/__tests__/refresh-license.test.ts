import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { refreshLicenseImpl } from "../endpoints/refresh-license.js";
import { signLicense, _resetLicenseSignerCacheForTests } from "../license-signer.js";
import type { LicenseTokenPayload } from "../shared/billing-types.js";
import { makeMockDb } from "./mocks/firestore-mock.js";
import { COLLECTIONS } from "../firestore-schema.js";

function asDb(mock: ReturnType<typeof makeMockDb>): Firestore {
  return mock as unknown as Firestore;
}

const DEVICE_ID = "a".repeat(64);

async function seedTokenFor(uid: string, overrides: Partial<LicenseTokenPayload> = {}): Promise<{ token: string; payload: LicenseTokenPayload }> {
  const now = Math.floor(Date.now() / 1000);
  const payload: LicenseTokenPayload = {
    iss: "faangin-license-v1",
    sub: uid,
    aud: "faangin-app",
    iat: now,
    exp: now + 60,
    nbf: now - 60,
    jti: "jti_" + Math.random().toString(16).slice(2),
    plan: "pro_monthly",
    status: "active",
    deviceId: DEVICE_ID,
    periodEnd: now + 3600,
    graceUntil: now + 7200,
    ...overrides,
  };
  const token = await signLicense(payload);
  return { token, payload };
}

function seedEntitlement(mock: ReturnType<typeof makeMockDb>, uid: string): void {
  const now = Math.floor(Date.now() / 1000);
  void mock.collection(COLLECTIONS.entitlements).doc(uid).set({
    uid,
    plan: "pro_monthly",
    status: "active",
    stripeCustomerId: "cus_r",
    stripeSubscriptionId: "sub_r",
    currentPeriodEnd: now + 86400,
    graceUntil: now + 86400 + 14 * 86400,
    devices: [
      { deviceId: DEVICE_ID, label: "Mac", activatedAt: now - 100, lastSeenAt: now - 10 },
    ],
    createdAt: now - 1000,
    updatedAt: now - 100,
  });
}

describe("refreshLicense", () => {
  beforeEach(() => {
    _resetLicenseSignerCacheForTests();
  });
  afterEach(() => {
    _resetLicenseSignerCacheForTests();
  });

  it("mints a fresh token for a valid request", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    seedEntitlement(mock, "uid_ok");
    const { token, payload } = await seedTokenFor("uid_ok");
    const result = await refreshLicenseImpl(db, { licenseToken: token });
    expect(result.licenseToken.split(".").length).toBe(3);
    expect(result.entitlement.uid).toBe("uid_ok");
    expect(result.licenseToken).not.toBe(token);
    // Different jti.
    expect(result.licenseToken.split(".")[1]).not.toBe(payload.jti);
  });

  it("rejects when the jti is in revokedJtis", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    seedEntitlement(mock, "uid_revoked");
    const { token, payload } = await seedTokenFor("uid_revoked");
    await mock.collection(COLLECTIONS.revokedJtis).doc(payload.jti).set({
      revokedAt: Math.floor(Date.now() / 1000),
      reason: "manual",
      uid: "uid_revoked",
    });
    await expect(refreshLicenseImpl(db, { licenseToken: token })).rejects.toThrow(/revoked/);
  });

  it("rejects when the token signature doesn't verify", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    seedEntitlement(mock, "uid_bad");
    const { token } = await seedTokenFor("uid_bad");
    const [h, p, s] = token.split(".");
    const bad = `${h}.${p}.${(s ?? "").slice(0, -1)}A`;
    await expect(refreshLicenseImpl(db, { licenseToken: bad })).rejects.toThrow(/invalid_token/);
  });
});
