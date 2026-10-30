_Last updated: 2026-10-27_

# Local Development

This is the setup that lets a developer (or a sibling agent) exercise the full billing stack without ever touching a live Firebase project or a Stripe live key. Everything runs against the Firebase emulator suite and Stripe test mode. Three terminals, roughly.

## Prerequisites

- Node 20 (`nvm install 20 && nvm use 20`).
- `firebase-tools` installed globally (`npm i -g firebase-tools`).
- Stripe CLI (`brew install stripe/stripe-cli/stripe`).
- Java 11+ on PATH (required by the Firestore emulator — `brew install openjdk@17` and follow the brew-printed symlink step).
- The staging Firebase project id from [firebase-setup.md](./firebase-setup.md).

**AUTO:** From the repo root:

```bash
cd functions && npm ci && cd ..
```

## 1. Point the emulator at the staging project

**AUTO:**

```bash
firebase use <staging-project-id>
```

The emulator pulls rules, indexes, and function source from the local tree; it uses the project id for namespacing emulated Firestore data.

## 2. Install the Firebase emulator suite

First run only:

**AUTO:**

```bash
firebase init emulators
```

Pick: Functions, Firestore, Auth. Ports default to 5001 (Functions), 8080 (Firestore), 9099 (Auth), 4000 (Emulator UI). Accept the defaults unless they collide with another process. The CLI writes a `firebase.json` block — commit that.

## 3. Prepare `.secret.local` for emulators

Emulators read `.secret.local` via a `--project` + `--import` combo. The scaffold's `functions/src/env.ts` reads `process.env.STRIPE_SECRET_KEY` etc., which Firebase CLI populates from `.secret.local` when running under emulators.

**OWNER:** `.secret.local` at the repo root should have at least:

```bash
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME_from_stripe_listen
STRIPE_PRICE_BYOK=price_REPLACE_ME_byok
STRIPE_PRICE_PRO_MONTHLY=price_REPLACE_ME_pro_monthly
STRIPE_PRICE_PRO_YEARLY=price_REPLACE_ME_pro_yearly
LICENSE_SIGNING_SECRET=base64url_32_byte_seed_REPLACE_ME
LICENSE_PUBLIC_KEY=base64url_32_byte_pubkey_REPLACE_ME
DEVICE_CAP_PRO=3
DEVICE_CAP_BYOK=3
```

Generate the Ed25519 pair with the Node snippet in [firebase-setup.md §7a](./firebase-setup.md#7a-generate-a-local-ed25519-key-pair-pre-kms-staging-only). For local-only emulator work it's fine to let agents see this generated staging-only pair; just don't reuse it for prod.

Confirm `.secret.local` is in `.gitignore` before you add anything to it (see [security.md](./security.md); as of 2026-10-27 the readiness review flagged this as missing).

## 4. Start the emulators (terminal 1)

**AUTO:**

```bash
firebase emulators:start --import=./.emulator-data --export-on-exit
```

The `--import` + `--export-on-exit` pair persists Firestore state between runs in `./.emulator-data` (gitignored). First run can skip `--import`; create the folder after you have seed data.

The UI opens at http://localhost:4000. You should see Auth, Firestore, and Functions tabs. The Functions tab lists every exported function with a public URL like `http://localhost:5001/<project-id>/us-central1/stripeWebhook`.

## 5. Forward Stripe webhooks (terminal 2)

**OWNER:** (CLI login already happened in [stripe-setup.md](./stripe-setup.md); agents can run `stripe listen` after the owner has logged the CLI in.)

```bash
stripe listen \
  --forward-to localhost:5001/<staging-project-id>/us-central1/stripeWebhook
```

The CLI prints a `whsec_...` signing secret. Paste it into `.secret.local` as `STRIPE_WEBHOOK_SECRET` and restart the emulator (terminal 1) so the new value is picked up. This secret rotates per session — expect to repeat this whenever `stripe listen` is restarted.

## 6. Run the Electron app pointed at the emulator (terminal 3)

**AUTO:**

```bash
export BACKEND_ORIGIN=http://localhost:5001/<staging-project-id>/us-central1
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
npm run dev
```

The scaffold's app reads `BACKEND_ORIGIN` to compose function URLs. `FIREBASE_AUTH_EMULATOR_HOST` tells the Firebase client SDK (if the app uses one for the device-code approval webview) to hit the Auth emulator. Both are no-ops in packaged builds.

Verify by opening the overlay, triggering "Sign in", and watching the device code appear in the Firestore emulator UI under `deviceCodes/`.

## 7. Seed test Firestore state

For most flows you don't need to seed — the app creates docs as it goes. For webhook-replay testing, seed a known `entitlements/{uid}` manually:

**AUTO:** In the Firestore emulator UI (http://localhost:4000/firestore), add a doc:

- Collection: `entitlements`
- Doc id: `test-uid-123`
- Fields: `uid: "test-uid-123"`, `email: "dev@example.com"`, `plan: "free"`, `status: "active"`, `devices: []`, `activeJtis: []`, `byokUnlock: false`, `createdAt: <serverTimestamp>`, `updatedAt: <serverTimestamp>`.

Then `stripe trigger checkout.session.completed --add 'metadata[uid]=test-uid-123' --add 'metadata[price_id]=price_test_byok_123'` and watch the entitlement flip to `byok`.

To fully drive a checkout, use the test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP. Stripe's test clocks (`stripe test clocks ...`) advance a subscription forward for renewal and grace-period testing.

## 8. Running function tests

**AUTO:**

```bash
cd functions
npm test
```

The scaffold's unit tests stub Stripe and Firestore. Integration tests (webhook replay, device-code flow) run under the emulator and need it already up — the test runner picks up `FIRESTORE_EMULATOR_HOST=localhost:8080` automatically if the emulator is running.

## Common failure modes

**"Signing secret mismatch" from `stripeWebhook`.** The `STRIPE_WEBHOOK_SECRET` in `.secret.local` is stale (you restarted `stripe listen`). Copy the new `whsec_` from the CLI, update `.secret.local`, restart the emulator.

**Function logs show "LICENSE_SIGNING_SECRET not set".** Secret missing from `.secret.local` or the emulator was started before you added it. Restart emulators.

**Device-code polling returns `expired` within seconds.** Your workstation's clock is more than 10 minutes off UTC. Check with `date -u` and sync via `sudo sntp -sS time.apple.com`.

**Firestore writes succeed in app but UI shows nothing.** You're writing to prod Firestore because the Firebase client SDK didn't pick up the emulator host. Confirm `FIREBASE_AUTH_EMULATOR_HOST` and the Firestore equivalent (`FIRESTORE_EMULATOR_HOST=localhost:8080`) are both exported in the terminal running the Electron dev build.

**`stripe trigger` events arrive but function returns 500 "no uid in metadata".** The generic trigger doesn't carry Faangin metadata. Either pass `--add 'metadata[uid]=...'`, or drive a real test-mode checkout from the pricing page so the Checkout Session carries metadata set by `/createCheckoutSession`.

**Function cold-starts are slow (>10s).** Expected on first call after emulator start. Subsequent calls are sub-100ms. If prod cold-start is a concern, that's a Cloud Functions min-instances decision tracked separately.

**Emulator UI shows "Functions emulator stopped unexpectedly".** Open `firebase-debug.log` in the repo root; the top of the trace usually names the syntax or import error. The emulator does not hot-reload gracefully on syntax errors in function sources.

**The emulator refuses to start because port 8080 is taken.** Another dev server (common with Vite/Webpack defaults). Change the port in `firebase.json` → `emulators.firestore.port` and set `FIRESTORE_EMULATOR_HOST` accordingly.
