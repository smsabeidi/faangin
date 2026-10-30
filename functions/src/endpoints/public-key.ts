/**
 * GET /publicLicenseKey
 *
 * Returns the current `LicensePublicKey` so the Electron app can verify
 * license-token signatures without a redeploy on rotation. The app caches
 * this response and falls back to a baked-in last-known-good key when the
 * network is down.
 */

import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { logger } from "firebase-functions/v2";
import { getPublicJwk } from "../license-signer.js";
import { applyCors } from "../http-util.js";

export const publicLicenseKey = onRequest(
  { cors: false },
  async (req: Request, res: Response): Promise<void> => {
    if (applyCors(req, res)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      const jwk = await getPublicJwk();
      // Cache for 5 minutes at the edge; apps can also use `kid` to detect
      // rotation and bust their local cache aggressively.
      res.set("Cache-Control", "public, max-age=300");
      res.status(200).json(jwk);
    } catch (err) {
      logger.error("publicLicenseKey failed", err);
      res.status(500).json({ error: "internal" });
    }
  },
);
