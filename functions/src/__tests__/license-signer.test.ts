import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLicenseSignerCacheForTests,
  base64urlDecode,
  base64urlEncode,
  getPublicJwk,
  signLicense,
  verifyLicense,
} from "../license-signer.js";
import type { LicenseTokenPayload } from "../shared/billing-types.js";

const buildPayload = (overrides: Partial<LicenseTokenPayload> = {}): LicenseTokenPayload => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "faangin-license-v1",
    sub: "uid_test",
    aud: "faangin-app",
    iat: now,
    exp: now + 60,
    nbf: now - 60,
    jti: "jti_test",
    plan: "pro_monthly",
    status: "active",
    deviceId: "a".repeat(64),
    periodEnd: now + 3600,
    graceUntil: now + 7200,
    ...overrides,
  };
};

describe("license-signer", () => {
  beforeEach(() => {
    _resetLicenseSignerCacheForTests();
    delete process.env["LICENSE_SIGNING_SECRET"];
  });
  afterEach(() => {
    _resetLicenseSignerCacheForTests();
  });

  it("base64url roundtrips", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = base64urlEncode(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const back = base64urlDecode(encoded);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("signLicense emits a well-formed compact JWT", async () => {
    const token = await signLicense(buildPayload());
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    const header = JSON.parse(Buffer.from(base64urlDecode(parts[0] ?? "")).toString("utf8"));
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");
    expect(typeof header.kid).toBe("string");
  });

  it("signLicense + verifyLicense roundtrip succeeds", async () => {
    const payload = buildPayload();
    const token = await signLicense(payload);
    const verified = await verifyLicense(token);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe("uid_test");
    expect(verified?.plan).toBe("pro_monthly");
  });

  it("verifyLicense rejects a tampered token", async () => {
    const token = await signLicense(buildPayload());
    // Flip one char in the payload.
    const [h, p, s] = token.split(".");
    const bad = `${h}.${(p ?? "").slice(0, -1)}X.${s}`;
    expect(await verifyLicense(bad)).toBeNull();
  });

  it("verifyLicense rejects an expired token", async () => {
    const expired = buildPayload({ exp: Math.floor(Date.now() / 1000) - 10 });
    const token = await signLicense(expired);
    expect(await verifyLicense(token)).toBeNull();
  });

  it("getPublicJwk returns a 32-byte Ed25519 key", async () => {
    const jwk = await getPublicJwk();
    expect(jwk.alg).toBe("EdDSA");
    expect(jwk.kid.length).toBeGreaterThan(0);
    expect(base64urlDecode(jwk.publicKey).length).toBe(32);
  });
});
