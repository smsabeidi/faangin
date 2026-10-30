/**
 * Device-code sign-in flow.
 *
 * - `startDeviceCode`:   app -> backend; returns (deviceCode, userCode) pair.
 * - `approveDeviceCode`: website -> backend; auth'd user types the userCode,
 *                        plus the app has already told it the deviceId/label.
 * - `pollDeviceCode`:    app -> backend; polls deviceCode; on "approved" we
 *                        mint a fresh Ed25519 license token.
 *
 * We expose each as a callable using firebase-functions/v2/https for an
 * ergonomic app client, and also expose a pure handler for direct tests.
 */

import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { randomBytes } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type {
  DeviceCodePollStatus,
  DeviceCodeStart,
  Entitlement,
  LicenseTokenPayload,
} from "../shared/billing-types.js";
import { COLLECTIONS, deviceCodeDocSchema, entitlementSchema } from "../firestore-schema.js";
import { getDb } from "../firebase-admin.js";
import { signLicense } from "../license-signer.js";

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRY_SECONDS = 15 * 60;
const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_DEVICES = 3;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomDeviceCode(): string {
  return randomBytes(32).toString("hex"); // 64 chars
}

function randomUserCode(): string {
  // 6-char uppercase alphanumeric (Crockford-ish; no I/O/1/0).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    const byte = buf[i] ?? 0;
    const ch = alphabet[byte % alphabet.length];
    out += ch ?? "A";
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

export async function startDeviceCodeImpl(db: Firestore): Promise<DeviceCodeStart> {
  const deviceCode = randomDeviceCode();
  const userCode = randomUserCode();
  const now = nowSeconds();
  const expiresAt = now + DEFAULT_EXPIRY_SECONDS;

  await db.collection(COLLECTIONS.deviceCodes).doc(deviceCode).set({
    userCode,
    deviceCode,
    expiresAt,
    status: "pending",
    uid: null,
    deviceId: null,
    deviceLabel: null,
    createdAt: now,
    lastPolledAt: null,
    interval: DEFAULT_INTERVAL_SECONDS,
  });

  const base = process.env["WEBSITE_ORIGIN"] ?? "https://faangin.app";
  return {
    deviceCode,
    userCode,
    verificationUri: `${base}/sign-in`,
    verificationUriComplete: `${base}/sign-in?code=${userCode}`,
    expiresIn: DEFAULT_EXPIRY_SECONDS,
    interval: DEFAULT_INTERVAL_SECONDS,
  };
}

export const startDeviceCode = onCall(async (_req: CallableRequest<unknown>) => {
  return startDeviceCodeImpl(getDb());
});

/* ------------------------------------------------------------------ */
/* approve                                                            */
/* ------------------------------------------------------------------ */

export const approveRequestSchema = z.object({
  userCode: z.string().regex(/^[A-Z0-9]{6,8}$/),
  deviceId: z.string().regex(/^[a-f0-9]{64}$/),
  deviceLabel: z.string().min(1).max(120),
});

export type ApproveRequest = z.infer<typeof approveRequestSchema>;

export async function approveDeviceCodeImpl(
  db: Firestore,
  uid: string,
  input: unknown,
): Promise<{ ok: true }> {
  const parsed = approveRequestSchema.parse(input);
  const q = await db
    .collection(COLLECTIONS.deviceCodes)
    .where("userCode", "==", parsed.userCode)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (q.empty) throw new HttpsError("not-found", "code_not_found");
  const codeDoc = q.docs[0];
  if (!codeDoc) throw new HttpsError("not-found", "code_not_found");

  const code = deviceCodeDocSchema.parse(codeDoc.data());
  if (code.expiresAt < nowSeconds()) {
    throw new HttpsError("deadline-exceeded", "code_expired");
  }

  const entRef = db.collection(COLLECTIONS.entitlements).doc(uid);
  const entSnap = await entRef.get();
  if (!entSnap.exists) throw new HttpsError("failed-precondition", "no_entitlement");
  const ent = entitlementSchema.parse(entSnap.data());
  if (ent.status !== "active" && ent.status !== "grace") {
    throw new HttpsError("failed-precondition", "entitlement_inactive");
  }

  // Register the device if new, cap at MAX_DEVICES.
  const existing = ent.devices.find((d) => d.deviceId === parsed.deviceId);
  if (!existing && ent.devices.length >= MAX_DEVICES) {
    throw new HttpsError("resource-exhausted", "device_limit");
  }
  const now = nowSeconds();
  const nextDevices = existing
    ? ent.devices.map((d) =>
        d.deviceId === parsed.deviceId ? { ...d, lastSeenAt: now, label: parsed.deviceLabel } : d,
      )
    : [
        ...ent.devices,
        {
          deviceId: parsed.deviceId,
          label: parsed.deviceLabel,
          activatedAt: now,
          lastSeenAt: now,
        },
      ];

  await entRef.set({ devices: nextDevices, updatedAt: now }, { merge: true });
  await codeDoc.ref.set(
    {
      status: "approved",
      uid,
      deviceId: parsed.deviceId,
      deviceLabel: parsed.deviceLabel,
    },
    { merge: true },
  );
  return { ok: true };
}

export const approveDeviceCode = onCall(async (req: CallableRequest<unknown>) => {
  if (!req.auth?.uid) {
    throw new HttpsError("unauthenticated", "sign_in_required");
  }
  return approveDeviceCodeImpl(getDb(), req.auth.uid, req.data);
});

/* ------------------------------------------------------------------ */
/* poll                                                               */
/* ------------------------------------------------------------------ */

export const pollRequestSchema = z.object({
  deviceCode: z.string().min(32),
});

export async function pollDeviceCodeImpl(
  db: Firestore,
  input: unknown,
): Promise<DeviceCodePollStatus> {
  const { deviceCode } = pollRequestSchema.parse(input);
  const ref = db.collection(COLLECTIONS.deviceCodes).doc(deviceCode);
  const snap = await ref.get();
  if (!snap.exists) return { status: "expired" };
  const code = deviceCodeDocSchema.parse(snap.data());

  const now = nowSeconds();
  if (code.expiresAt < now) return { status: "expired" };

  // Rate-limit: polls more frequent than `interval` get slow_down.
  if (code.lastPolledAt && now - code.lastPolledAt < code.interval) {
    await ref.set({ interval: Math.min(code.interval * 2, 30) }, { merge: true });
    return { status: "slow_down", interval: Math.min(code.interval * 2, 30) };
  }
  await ref.set({ lastPolledAt: now }, { merge: true });

  if (code.status === "pending") return { status: "pending" };
  if (code.status === "denied") return { status: "denied" };
  if (code.status === "consumed") return { status: "expired" };

  // approved → mint a license token and transition to consumed.
  if (!code.uid || !code.deviceId) return { status: "expired" };
  const entSnap = await db.collection(COLLECTIONS.entitlements).doc(code.uid).get();
  if (!entSnap.exists) return { status: "denied" };
  const ent = entitlementSchema.parse(entSnap.data()) as Entitlement;

  const iat = now;
  const payload: LicenseTokenPayload = {
    iss: "faangin-license-v1",
    sub: ent.uid,
    aud: "faangin-app",
    iat,
    exp: iat + TOKEN_LIFETIME_SECONDS,
    nbf: iat - 60,
    jti: randomBytes(16).toString("hex"),
    plan: ent.plan,
    status: ent.status,
    deviceId: code.deviceId,
    periodEnd: ent.currentPeriodEnd,
    graceUntil: ent.graceUntil,
  };
  const token = await signLicense(payload);

  await ref.set({ status: "consumed" }, { merge: true });
  return { status: "success", licenseToken: token, entitlement: ent };
}

export const pollDeviceCode = onCall(async (req: CallableRequest<unknown>) => {
  return pollDeviceCodeImpl(getDb(), req.data);
});
