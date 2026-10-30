/**
 * Small, test-friendly helpers for the HTTPS endpoints. CORS allow-list is
 * populated from the ALLOWED_ORIGINS env var (comma-separated); unset means
 * "no cross-origin reads", which is the safest default.
 */

import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";

export function allowedOrigins(): ReadonlySet<string> {
  const raw = process.env["ALLOWED_ORIGINS"];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Returns true if the response is complete (preflight) and the caller
 *  should early-return. */
export function applyCors(req: Request, res: Response): boolean {
  const origin = typeof req.headers["origin"] === "string" ? req.headers["origin"] : "";
  const allow = allowedOrigins();
  if (origin && allow.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Stripe-Signature");
    res.set("Access-Control-Max-Age", "3600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

export function websiteOrigin(): string {
  return process.env["WEBSITE_ORIGIN"] ?? "https://faangin.app";
}
