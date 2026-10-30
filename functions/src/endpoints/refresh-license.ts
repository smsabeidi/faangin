/**
 * Callable `refreshLicense`.
 *
 * The app presents its current (unexpired or in-grace) license token; we
 * verify its signature, check the entitlement is still active, confirm the
 * jti isn't revoked, and mint a fresh 30-day token for the same device.
 */

import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { randomBytes } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { Entitlement, LicenseTokenPayload } from "../shared/billing-types.js";
import { COLLECTIONS, entitlementSchema } from "../firestore-schema.js";
import { getDb } from "../firebase-admin.js";
import { signLicense, verifyLicense } from "../license-signer.js";

const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export const refreshRequestSchema = z.object({
  licenseToken: z.string().min(16),
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function refreshLicenseImpl(
  db: Firestore,
  input: unknown,
): Promise<{ licenseToken: string; entitlement: Entitlement }> {
  const { licenseToken } = refreshRequestSchema.parse(input);
  const payload = await verifyLicense(licenseToken);
  if (!payload) throw new HttpsError("unauthenticated", "invalid_token");

  // jti revoked?
  const revokedSnap = await db
    .collection(COLLECTIONS.revokedJtis)
    .doc(payload.jti)
    .get();
  if (revokedSnap.exists) {
    throw new HttpsError("permission-denied", "revoked");
  }

  // Also honor the "all outstanding" sentinel: any revokedJtis doc with
  // uid=this user and marker=all_outstanding written AFTER our iat kills it.
  const allRevoked = await db
    .collection(COLLECTIONS.revokedJtis)
    .where("uid", "==", payload.sub)
    .where("revokedAt", ">=", payload.iat)
    .limit(1)
    .get();
  if (!allRevoked.empty) {
    throw new HttpsError("permission-denied", "revoked");
  }

  const entSnap = await db.collection(COLLECTIONS.entitlements).doc(payload.sub).get();
  if (!entSnap.exists) throw new HttpsError("failed-precondition", "no_entitlement");
  const ent = entitlementSchema.parse(entSnap.data()) as Entitlement;
  if (ent.status !== "active" && ent.status !== "grace") {
    throw new HttpsError("failed-precondition", "entitlement_inactive");
  }

  const iat = nowSeconds();
  const nextPayload: LicenseTokenPayload = {
    iss: "faangin-license-v1",
    sub: ent.uid,
    aud: "faangin-app",
    iat,
    exp: iat + TOKEN_LIFETIME_SECONDS,
    nbf: iat - 60,
    jti: randomBytes(16).toString("hex"),
    plan: ent.plan,
    status: ent.status,
    deviceId: payload.deviceId,
    periodEnd: ent.currentPeriodEnd,
    graceUntil: ent.graceUntil,
  };
  const token = await signLicense(nextPayload);
  // Bump lastSeenAt for the device.
  const nextDevices = ent.devices.map((d) =>
    d.deviceId === payload.deviceId ? { ...d, lastSeenAt: iat } : d,
  );
  await entSnap.ref.set({ devices: nextDevices, updatedAt: iat }, { merge: true });
  return { licenseToken: token, entitlement: ent };
}

export const refreshLicense = onCall(async (req: CallableRequest<unknown>) => {
  return refreshLicenseImpl(getDb(), req.data);
});
