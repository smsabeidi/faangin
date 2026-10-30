// TODO(kms): migrate to Google Cloud KMS asymmetric signing before launch.
// The current implementation builds an Ed25519 keypair from a 32-byte seed
// supplied via the `LICENSE_SIGNING_SECRET` env (base64url-encoded) and signs
// in-process using Node's built-in crypto. That is acceptable for dev +
// emulator work only. In production the private key must live in Cloud KMS;
// this module should become a thin wrapper around `kms.asymmetricSign` that
// formats the JWT header/payload, retrieves the signature, and never
// materializes raw key bytes.

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { LicensePublicKey, LicenseTokenPayload } from "./shared/billing-types.js";

const DEFAULT_KID = "faangin-license-dev-2026-10";

// PKCS#8 ASN.1 DER prefix for an Ed25519 private key, followed by the raw
// 32-byte seed. Together these form a valid pkcs8 DER blob that Node's
// crypto module can import.
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/* ------------------------------------------------------------------ */
/* Base64url helpers                                                  */
/* ------------------------------------------------------------------ */

export function base64urlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64urlDecode(input: string): Uint8Array {
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/* ------------------------------------------------------------------ */
/* Key material                                                       */
/* ------------------------------------------------------------------ */

interface Keypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicRaw: Buffer;
  kid: string;
}

let cachedKeypair: Keypair | null = null;

function pkcs8FromSeed(seed: Uint8Array): Buffer {
  return Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
}

function loadKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  const raw = process.env["LICENSE_SIGNING_SECRET"];
  let seed: Uint8Array;
  if (raw && raw.length > 0) {
    seed = base64urlDecode(raw);
    if (seed.length !== 32) {
      throw new Error(
        `LICENSE_SIGNING_SECRET must decode to 32 bytes, got ${seed.length}`,
      );
    }
  } else {
    // Deterministic dev seed so the emulator produces a stable kid across
    // restarts. NEVER acceptable in production — the KMS migration removes
    // this path entirely.
    seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 13) & 0xff;
  }

  const privateKey = createPrivateKey({
    key: pkcs8FromSeed(seed),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  // SPKI DER is 12-byte prefix + 32-byte raw public key.
  const spki = publicKey.export({ format: "der", type: "spki" });
  const publicRaw = Buffer.from(spki.subarray(spki.length - 32));
  const kid = process.env["LICENSE_SIGNING_KID"] ?? DEFAULT_KID;
  cachedKeypair = { privateKey, publicKey, publicRaw, kid };
  return cachedKeypair;
}

/** Testing helper: forget the cached key so a new env var takes effect. */
export function _resetLicenseSignerCacheForTests(): void {
  cachedKeypair = null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

export async function getPublicJwk(): Promise<LicensePublicKey> {
  const kp = loadKeypair();
  return {
    kid: kp.kid,
    alg: "EdDSA",
    publicKey: base64urlEncode(kp.publicRaw),
  };
}

export async function signLicense(payload: LicenseTokenPayload): Promise<string> {
  const kp = loadKeypair();
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: kp.kid,
  };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = cryptoSign(null, Buffer.from(signingInput, "utf8"), kp.privateKey);
  return `${signingInput}.${base64urlEncode(sig)}`;
}

export async function verifyLicense(token: string): Promise<LicenseTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const kp = loadKeypair();
    const signingInput = `${h}.${p}`;
    const sig = Buffer.from(base64urlDecode(s));
    const ok = cryptoVerify(
      null,
      Buffer.from(signingInput, "utf8"),
      kp.publicKey,
      sig,
    );
    if (!ok) return null;
    const payloadJson = Buffer.from(base64urlDecode(p)).toString("utf8");
    const payload = JSON.parse(payloadJson) as LicenseTokenPayload;
    // Sanity: iss / aud / exp.
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== "faangin-license-v1") return null;
    if (payload.aud !== "faangin-app") return null;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
