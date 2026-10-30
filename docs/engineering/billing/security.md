_Last updated: 2026-10-27_

# Security Review

Short review of the billing feature's threat model, mitigations, and accepted risks. Pairs with [architecture.md](./architecture.md), which has the full data-flow diagram.

## Key management

The Ed25519 private key that signs license tokens is the single most sensitive secret in the system. Its lifecycle:

**During staging and the first week of local dev** the key is a 32-byte seed stored in Secret Manager as `LICENSE_SIGNING_SECRET`, read into the function at cold-start, and used by `@noble/ed25519`. This is acceptable because the staging key cannot sign tokens that any prod install would accept — the public key is scoped to the staging deployment.

**For prod**, the key lives in Google Cloud KMS as an `ec-sign-ed25519` key version. It is never readable (not even by the owner — KMS exposes only "sign this payload" and "give me the public key"). The Cloud Functions default service account holds `roles/cloudkms.signerVerifier` on the specific key; nothing else. Key rotation creates a new key version; the function signs with the primary version and the public-key endpoint serves `{current, previous}` so clients can verify tokens signed before the rotation.

The **public key** is served by `/public/license-key` and also baked into the Electron app at build time as a "last-known-good". If the server is unreachable, the app falls back to the baked-in key; this means a key rotation requires either (a) planning the rotation so no in-flight tokens are stranded, or (b) shipping an app update with the new baked-in key before the old version is retired. The app always prefers the online key when available.

## Device cap enforcement

Device cap (`DEVICE_CAP_PRO=3`, `DEVICE_CAP_BYOK=3`) is enforced **only server-side at token issuance**. The function:

1. Reads `entitlements/{uid}.devices[]`.
2. If the requesting `deviceId` is already present, update `lastRefresh` and reissue.
3. Else if `devices.length < DEVICE_CAP_*`, append the new device and issue.
4. Else return 409 with "device cap reached; remove a device to continue".

The client cannot bypass this by rotating the local `deviceId` UUID: that just presents as a new device, which hits the cap check. The user must explicitly remove a device from Settings (which revokes that device's JTI).

## Replay

Every token carries a random 128-bit `jti`. Mitigations layer:

- `nbf` + `exp` bound the replay window to 30 days.
- `activeJtis` on the entitlement doc is the whitelist of valid JTIs; `revokedJtis/{jti}` is the deny-list. The Pro gateway checks both on each JWT verify (via `/mintGatewayToken`'s short-lived child token, which carries a `parent_jti` claim).
- A refreshed token issues a new `jti`; the old one is left in `activeJtis` until either `exp` or an explicit revocation path moves it, which tolerates overlap during refresh.

A refresh-storm attack (a client floods `/refreshLicense`) is rate-limited at Cloud Functions concurrency limits plus a per-uid Firestore counter.

## Chargeback and refund

`charge.refunded` and `charge.dispute.created` webhooks both call the same handler: look up the uid from the Stripe customer, mark `entitlements.status` (`refunded` or `chargeback`), move every entry in `activeJtis` to `revokedJtis`, set `plan = "free"`. On the client's next online check (any Fn call), the refresh will fail and the local token is torn up.

Payment-failed is lighter: `invoice.payment_failed` moves `status` to `past_due` but does not revoke tokens; the subscription has its own dunning window. If dunning fails, `customer.subscription.deleted` fires and we revoke then.

## Offline bypass — accepted risk

A valid, unexpired license token works offline. If a user purchases Pro, saves the token, immediately requests a refund, and goes offline, the token keeps working until `exp` + `grace` passes — up to 44 days.

This is **accepted**. Rationale:

- Offline grace is a product feature, not a bug — users on planes, in secure rooms, or on flaky hotel wifi expect the overlay to just work.
- The 30-day `exp` bounds the base window; `grace` adds 14 days.
- The economic blast radius is bounded: BYOK is a $10 one-time (uses the user's own OpenAI key, so no gateway cost); Pro Monthly is $14.99 (gateway cost per abusive user is bounded by the gateway's own per-day cap).
- Making this airtight would require always-online gating, which we rejected on UX grounds.

Logged for the record so no one later discovers it as a "bug".

## Token theft

An attacker with the user's `license.json` can present it. Mitigations:

- The token's `deviceId` claim is checked by the Pro gateway against the gateway's own view of `entitlements.devices[]` on each request. A token presented from a connection that doesn't match the stored `deviceId` is rejected.
- The user can "Sign out of all devices" from Settings, which calls `/revokeAllJtis` and invalidates every token. The attacker's copy stops working on next online check.
- BYOK tokens don't talk to the gateway, so this check doesn't apply — but a stolen BYOK token can only unlock the local app on a device that doesn't already have a license, which still requires the attacker to have the user's binary and user data. The blast radius is one $10 unlock.

This is a known limitation of signed-token licensing on consumer-grade workstations; proper remote attestation would require TPM/Keychain-sealed storage, which we are not building for launch.

## Secret handling

The core discipline: **the owner runs every CLI login and types every secret; agents never see live keys.**

- `.secret.local` at the repo root holds local-dev secrets. It must be gitignored. The current `.gitignore` (per the readiness review on 2026-10-27) does **not** yet cover `.secret.local`, `*.p8`, `*.p12`, or `service-account*.json`. This is a launch blocker; add these lines before any key material enters the repo tree:

  ```gitignore
  .secret.local
  *.p8
  *.p12
  service-account*.json
  .emulator-data/
  ```

- Prod secrets live in Google Secret Manager, never on disk. The owner uses `firebase functions:secrets:set <NAME>` (hidden input).
- CLI sessions (`stripe login`, `firebase login`, `gcloud auth login`) persist tokens under the owner's home directory. These are machine-local; FileVault + a strong account password are the mitigations.
- Agent transcripts and chat logs are off-limits for pasting any secret. Even test-mode Stripe keys and dev-only Ed25519 seeds are handled with the live-mode discipline so the habit holds under pressure.

## Open security items

- KMS migration (currently `LICENSE_SIGNING_SECRET` env var, see [firebase-setup.md §7](./firebase-setup.md#7-cloud-kms-key-for-ed25519-signing)) — tracked in [launch-checklist.md](./launch-checklist.md).
- `.gitignore` hygiene — the four lines above must land before any secret is written.
- No audit logging yet on `/revokeAllJtis` and `/refreshLicense`. For launch we rely on Cloud Functions request logs; add structured audit events to a Firestore `audit/` collection as a post-launch task.
- No bug bounty / disclosure policy page at launch — accept, publish `security@faangin.app` on the website and route it to the owner.
