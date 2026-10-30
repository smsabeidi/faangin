_Last updated: 2026-10-27_

# Launch Checklist

The pre-launch gate between "scaffolded" and "charging real cards". Nothing goes to live mode until every unlocked box in this file is checked. Boxes marked 🔒 are blocked on open rows in [decisions.md](./decisions.md); resolve the decision first, then come back and check.

## Infra

- [ ] Prod Firebase project (`faangin-prod`) created and on the Blaze plan.
- [ ] Firestore region in prod is `us-central1`, matching Cloud Functions region.
- [ ] Firestore rules deployed to prod (`allow read, write: if false` on every collection).
- [ ] Firestore composite indexes deployed to prod and all show "Enabled".
- [ ] Cloud KMS keyring `faangin-licensing` and key `license-signer` created in prod GCP project; algorithm is `ec-sign-ed25519`.
- [ ] Cloud Functions service account has `roles/cloudkms.signerVerifier` on `license-signer`.
- [ ] Functions code migrated off `LICENSE_SIGNING_SECRET` env var to the KMS client (`@google-cloud/kms`), deployed, verified by signing a test token and verifying with the KMS public key.
- [ ] `LICENSE_SIGNING_SECRET` destroyed in prod Secret Manager (`firebase functions:secrets:destroy`).
- [ ] All prod secrets set in Secret Manager: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BYOK`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `LICENSE_PUBLIC_KEY`, `APP_BUNDLE_URL`, `DEVICE_CAP_PRO`, `DEVICE_CAP_BYOK`.
- [ ] Stripe prod webhook endpoint created at the prod Cloud Function URL; signing secret recorded in prod Secret Manager; endpoint subscribed to the exact `HANDLED_STRIPE_EVENTS` set.
- [ ] Stripe account activated out of test mode (business profile verified, bank account linked, tax ID submitted).
- [ ] 🔒 Pro gpt-transcribe gateway on Cloud Run deployed and reachable; verifies license JWT against the prod KMS public key; reports usage to `/consumeAllowance` on Cloud Functions. (This is a separate repo; blocked on gateway readiness — see [architecture.md](./architecture.md).)

## App

- [ ] Packaged `.app` build is signed with the Developer ID Application certificate from the owner's Apple account.
- [ ] Build is notarized (`xcrun notarytool submit` → "Accepted") and stapled (`xcrun stapler staple`).
- [ ] Auto-updater (`electron-updater` or equivalent) is pointed at the stable release channel; a canary release channel exists but is not used by default.
- [ ] Env vars baked into the packaged build point at **prod** `BACKEND_ORIGIN` (`https://us-central1-faangin-prod.cloudfunctions.net`), not staging.
- [ ] Last-known-good `LICENSE_PUBLIC_KEY` is baked into the Electron bundle at build time; the app can verify a token offline using it.
- [ ] App gracefully handles public-key rotation: fetches `/public/license-key` on launch and caches the current key alongside the baked-in last-known-good.
- [ ] Offline grace window renders a visible but non-blocking "reconnect soon" banner between `exp` and `grace`, and gates features at `grace`.
- [ ] App shows the Customer Portal link to Pro subscribers in Settings.
- [ ] "Sign out of all devices" button in Settings calls `/revokeAllJtis` and clears local token.

## Business

- [ ] 🔒 Apple Developer enrollment complete (blocks on legal entity + country, see [decisions.md](./decisions.md)).
- [ ] 🔒 Stripe business profile reviewed and approved by Stripe (blocks on legal entity + country, see [decisions.md](./decisions.md)).
- [ ] Pricing page at `https://faangin.app/pricing` live with final SKU names and prices.
- [ ] 🔒 Refund policy page at `https://faangin.app/refunds` live (blocks on refund window decision, see [decisions.md](./decisions.md)).
- [ ] Privacy policy at `https://faangin.app/privacy` names Firebase (Google) and Stripe as sub-processors; explains device-id collection and gpt-transcribe audio handling for Pro.
- [ ] Terms of Service at `https://faangin.app/terms` live and linked from Checkout.
- [ ] Support email (`support@faangin.app`) monitored and the Stripe Business Profile points at it.
- [ ] 🔒 BYOK terms copy on pricing page agreed, including the "approximately N months of updates on current major" line (blocks on BYOK update window length, see [decisions.md](./decisions.md)).
- [ ] 🔒 "Pro Yearly includes BYOK unlock" decision reflected on the pricing page (blocks on BYOK license-with-yearly behavior, see [decisions.md](./decisions.md)).
- [ ] 🔒 BYOK → Pro upgrade credit copy and Checkout coupon code configured if the credit is on (blocks on upgrade-credit decision, see [decisions.md](./decisions.md)).

## QA (end-to-end, test mode first, then one live-mode smoke each)

- [ ] Purchase BYOK end-to-end on a real card in **test mode** (`4242` card): license lands in app, `entitlements.plan = "byok"`, `byokUnlock = true`, device added.
- [ ] Purchase Pro Monthly end-to-end in test mode: license lands, feature flags enable transcribe, device-cap enforcement visible in `entitlements.devices[]`.
- [ ] Purchase Pro Yearly end-to-end in test mode.
- [ ] Cancel Pro Monthly from Customer Portal: webhook arrives, `entitlements.status = "canceled"`, local app continues working until `periodEnd`.
- [ ] Trigger refund via Stripe dashboard on a test BYOK charge: webhook arrives, all `activeJtis` revoked, local app loses features on next online check.
- [ ] Simulate chargeback (`stripe trigger charge.dispute.created` or Stripe test clock): same revoke behavior.
- [ ] Offline grace behavior verified: unplug network, let token pass `exp`, confirm the banner appears and features still work until `grace`.
- [ ] 3-Mac device cap verified: sign in on Mac A, Mac B, Mac C; fourth sign-in attempt is rejected with the "remove a device from Settings" message.
- [ ] Device removal flow verified: remove Mac A from Settings on Mac B; Mac A loses features on next online check.
- [ ] Public-key rotation drill: rotate the KMS key version in staging, confirm the app continues working using the baked-in last-known-good until it fetches the new key.
- [ ] One live-mode smoke per SKU: owner purchases BYOK, Pro Monthly, Pro Yearly from a real card, cancels + refunds immediately. Record transaction IDs.

## Rollback

- [ ] Kill-switch tested: a `config/killSwitch` doc in Firestore with `{ newPurchases: false }` causes `/createCheckoutSession` to return 503 with a maintenance message. The Electron app shows "Purchases temporarily paused" instead of a Checkout URL.
- [ ] Downgrade drill tested: a function `downgradeAllProToFastOnly` iterates `entitlements` where `plan` starts with `pro_`, rewrites the `features` bitmap to `{fast: true, smart: false, transcribe: false}`, revokes all `activeJtis`. The app picks this up on next refresh and shows the degraded capability banner.
- [ ] Webhook pause: documented how to disable the Stripe webhook endpoint in the dashboard (one click) and queue events for later replay via `stripe events resend`.
- [ ] Secret rotation drill: rotate `STRIPE_WEBHOOK_SECRET` on both ends (Stripe + Secret Manager) within 5 minutes without dropping an event. Confirmed by replaying a buffered event.

## Final sign-off

- [ ] Owner has read every doc in `docs/engineering/billing/` and signed off.
- [ ] [decisions.md](./decisions.md) shows zero OPEN rows.
- [ ] [security.md](./security.md) accepted-risks section acknowledged.
- [ ] Switch Stripe account to live mode and announce.
