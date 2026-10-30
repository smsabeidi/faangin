import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  approveDeviceCodeImpl,
  pollDeviceCodeImpl,
  startDeviceCodeImpl,
} from "../endpoints/device-code.js";
import { makeMockDb } from "./mocks/firestore-mock.js";
import { COLLECTIONS } from "../firestore-schema.js";

function asDb(mock: ReturnType<typeof makeMockDb>): Firestore {
  return mock as unknown as Firestore;
}

const DEVICE_ID_A = "a".repeat(64);
const DEVICE_ID_B = "b".repeat(64);
const DEVICE_ID_C = "c".repeat(64);
const DEVICE_ID_D = "d".repeat(64);

function seedActiveEntitlement(mock: ReturnType<typeof makeMockDb>, uid: string, devicesLen = 0): void {
  const now = Math.floor(Date.now() / 1000);
  const devices = [DEVICE_ID_A, DEVICE_ID_B, DEVICE_ID_C].slice(0, devicesLen).map((id, i) => ({
    deviceId: id,
    label: `Mac ${i + 1}`,
    activatedAt: now - 100,
    lastSeenAt: now - 10,
  }));
  void mock.collection(COLLECTIONS.entitlements).doc(uid).set({
    uid,
    plan: "pro_monthly",
    status: "active",
    stripeCustomerId: "cus_x",
    stripeSubscriptionId: "sub_x",
    currentPeriodEnd: now + 86400,
    graceUntil: now + 86400 + 14 * 86400,
    devices,
    createdAt: now - 1000,
    updatedAt: now - 100,
  });
}

describe("device-code endpoints", () => {
  it("startDeviceCode writes a pending doc and returns display codes", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    const result = await startDeviceCodeImpl(db);
    expect(result.userCode).toMatch(/^[A-Z0-9]{6,8}$/);
    expect(result.deviceCode.length).toBeGreaterThan(32);
    expect(result.verificationUriComplete).toContain(result.userCode);
    const docs = mock._dump(COLLECTIONS.deviceCodes);
    const only = Object.values(docs)[0];
    expect(only?.status).toBe("pending");
  });

  it("pollDeviceCode returns pending for a freshly created code", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    const started = await startDeviceCodeImpl(db);
    const status = await pollDeviceCodeImpl(db, { deviceCode: started.deviceCode });
    expect(status.status).toBe("pending");
  });

  it("approveDeviceCode pairs the code and adds a new device", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    seedActiveEntitlement(mock, "uid_1", 0);
    const started = await startDeviceCodeImpl(db);
    await approveDeviceCodeImpl(db, "uid_1", {
      userCode: started.userCode,
      deviceId: DEVICE_ID_A,
      deviceLabel: "Sam's MacBook",
    });
    const ent = mock._dump(COLLECTIONS.entitlements)["uid_1"];
    expect(Array.isArray(ent?.devices)).toBe(true);
    expect((ent?.devices as unknown[]).length).toBe(1);
  });

  it("approveDeviceCode rejects when the entitlement is already at the device limit", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    seedActiveEntitlement(mock, "uid_2", 3);
    const started = await startDeviceCodeImpl(db);
    await expect(
      approveDeviceCodeImpl(db, "uid_2", {
        userCode: started.userCode,
        deviceId: DEVICE_ID_D,
        deviceLabel: "Fourth Mac",
      }),
    ).rejects.toThrow(/device_limit/);
  });

  it("pollDeviceCode mints a token after approval and transitions to consumed", async () => {
    const mock = makeMockDb();
    const db = asDb(mock);
    seedActiveEntitlement(mock, "uid_3", 0);
    const started = await startDeviceCodeImpl(db);
    await approveDeviceCodeImpl(db, "uid_3", {
      userCode: started.userCode,
      deviceId: DEVICE_ID_A,
      deviceLabel: "Mac 1",
    });
    const result = await pollDeviceCodeImpl(db, { deviceCode: started.deviceCode });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.licenseToken.split(".").length).toBe(3);
      expect(result.entitlement.uid).toBe("uid_3");
    }
    // Second poll should see "consumed" → mapped to "expired".
    const again = await pollDeviceCodeImpl(db, { deviceCode: started.deviceCode });
    expect(["expired", "slow_down"]).toContain(again.status);
  });
});
