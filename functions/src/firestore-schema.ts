/**
 * Zod schemas and TypeScript types for every Firestore document the billing
 * backend owns. The frozen app-side contract lives in `shared/billing-types.ts`;
 * these schemas add server-only wrappers (statuses, timestamps, idempotency).
 *
 * Proposed amendments to the frozen contract (not applied — awaiting owner):
 *   - Entitlement: add `lastInvoiceId` so the webhook idempotency ledger can
 *     deduplicate reruns of `invoice.payment_succeeded`.
 *   - LicenseTokenPayload: add `kid` so verifiers can round-trip the kid
 *     without parsing the JWT header.
 *   - DeviceDescriptor: add `firstDenied` for a soft block when a user tries
 *     to add a 4th device, so UI can show "which Mac to remove".
 */

import { z } from "zod";
import type {
  DeviceDescriptor,
  Entitlement,
  EntitlementStatus,
  Plan,
} from "./shared/billing-types.js";
import { HANDLED_STRIPE_EVENTS, PLAN_IDS } from "./shared/billing-types.js";

/* ------------------------------------------------------------------ */
/* Collection names                                                   */
/* ------------------------------------------------------------------ */

export const COLLECTIONS = Object.freeze({
  entitlements: "entitlements",
  deviceCodes: "deviceCodes",
  stripeEvents: "stripeEvents",
  revokedJtis: "revokedJtis",
} as const);

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/* ------------------------------------------------------------------ */
/* Entitlement                                                        */
/* ------------------------------------------------------------------ */

const planSchema = z.enum([...PLAN_IDS] as [Plan, ...Plan[]]);

const statusSchema = z.enum([
  "active",
  "grace",
  "expired",
  "canceled",
  "refunded",
  "disputed",
]) satisfies z.ZodType<EntitlementStatus>;

export const deviceDescriptorSchema = z.object({
  deviceId: z.string().regex(/^[a-f0-9]{64}$/, "deviceId must be 64 hex chars"),
  label: z.string().min(1).max(120),
  activatedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<DeviceDescriptor>;

export const entitlementSchema = z.object({
  uid: z.string().min(1),
  plan: planSchema,
  status: statusSchema,
  stripeCustomerId: z.string().min(1),
  stripeSubscriptionId: z.string().optional(),
  currentPeriodEnd: z.number().int().nonnegative(),
  graceUntil: z.number().int().nonnegative(),
  devices: z.array(deviceDescriptorSchema).max(3),
  byokUpdateWindowEnd: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<Entitlement>;

export type EntitlementDoc = z.infer<typeof entitlementSchema>;

/* ------------------------------------------------------------------ */
/* Device-code sessions                                               */
/* ------------------------------------------------------------------ */

export const deviceCodeStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "consumed",
]);

export type DeviceCodeStatus = z.infer<typeof deviceCodeStatusSchema>;

export const deviceCodeDocSchema = z.object({
  userCode: z.string().regex(/^[A-Z0-9]{6,8}$/),
  deviceCode: z.string().min(32),
  expiresAt: z.number().int().positive(),
  status: deviceCodeStatusSchema,
  uid: z.string().min(1).nullable(),
  deviceId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  deviceLabel: z.string().min(1).max(120).nullable(),
  createdAt: z.number().int().nonnegative(),
  // Soft rate-limit nudge: polls faster than `interval` get a `slow_down`.
  lastPolledAt: z.number().int().nonnegative().nullable(),
  interval: z.number().int().positive(),
});

export type DeviceCodeDoc = z.infer<typeof deviceCodeDocSchema>;

/* ------------------------------------------------------------------ */
/* Stripe webhook idempotency ledger                                  */
/* ------------------------------------------------------------------ */

export const stripeEventTypeSchema = z.enum([...HANDLED_STRIPE_EVENTS]);

export const stripeEventDocSchema = z.object({
  type: stripeEventTypeSchema,
  receivedAt: z.number().int().nonnegative(),
});

export type StripeEventDoc = z.infer<typeof stripeEventDocSchema>;

/* ------------------------------------------------------------------ */
/* License-token revocation list                                      */
/* ------------------------------------------------------------------ */

export const revocationReasonSchema = z.enum([
  "refund",
  "dispute",
  "manual",
  "device_removed",
  "rotation",
]);

export type RevocationReason = z.infer<typeof revocationReasonSchema>;

export const revokedJtiDocSchema = z.object({
  revokedAt: z.number().int().nonnegative(),
  reason: revocationReasonSchema,
  uid: z.string().min(1),
});

export type RevokedJtiDoc = z.infer<typeof revokedJtiDocSchema>;
