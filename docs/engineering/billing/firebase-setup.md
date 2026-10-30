_Last updated: 2026-10-27_

# Firebase Setup — Owner Runbook

For the **owner** only. Agents never run against prod. Two Firebase projects exist: one for staging and one for prod. Everything in this runbook assumes you have Homebrew-installed `firebase-tools` (`npm i -g firebase-tools`) and `gcloud` (`brew install --cask google-cloud-sdk`), and that you have the Google account that will own the project.

## 1. Create the two projects

**OWNER:** Go to https://console.firebase.google.com and create two projects:

- Staging: `faangin-staging` (project id `faangin-staging` or similar — the id is permanent).
- Prod: `faangin-prod`.

Pick names that make the environment unmistakable in URLs. Firebase will prepend a suffix if the id is taken; record whatever Firebase actually gave you below.

- [ ] Staging project id: ______________
- [ ] Prod project id: ______________

Attach each project to a Google Cloud **billing account**. Firebase Functions v2 and Secret Manager both require billing enabled (Blaze plan). The free tier covers all development usage.

**OWNER:** Log in via CLI:

```bash
firebase login
```

Then verify both projects are listed:

```bash
firebase projects:list
```

## 2. Enable Auth

**OWNER:** For each project, in the Firebase console → Authentication → Sign-in method:

- Enable **Email/Password** with "Email link (passwordless sign-in)" **on**. This is the primary flow — the website presents a "Send me a sign-in link" form, the user clicks the link from their inbox, lands back on the device-code approval page, and approves the Electron client.
- Leave "Email/Password" classic (password-based) **off**. We don't want password reset flows at launch.
- **No social providers at launch** (no Google, Apple, GitHub). This is intentional — fewer provider accounts to manage, no OAuth client secrets to rotate. Record the decision in [decisions.md](./decisions.md). If this is still open for you, treat it as a DECISION REQUIRED:
  - [ ] Email link only / add Google / add Apple / add GitHub: ______________

Add your domain to Authorized domains: `faangin.app` and `localhost` (for dev).

## 3. Firestore region

**OWNER:** Firebase console → Firestore Database → Create database.

- Mode: **Production** (not Datastore mode).
- Location: **`us-central1`** (regional, not multi-region). This MUST match the Cloud Functions region in the scaffold (`functions.region("us-central1")`) — mismatches add per-request latency and cost.

Repeat for prod.

The location is permanent for the project. If you pick wrong, you make a new project.

## 4. Deploy rules & indexes

Rules in the scaffold already deny all client reads/writes (`allow read, write: if false`); all access is via Admin SDK inside Cloud Functions. Indexes cover the queries in the webhook handler.

**AUTO:** From the repo root with staging project selected:

```bash
firebase use <staging-project-id>
firebase deploy --only firestore:rules,firestore:indexes
```

Verify in the console that the rules timestamp updated and all composite indexes show "Enabled" (not "Building").

**OWNER:** When ready for prod, switch and redeploy:

```bash
firebase use <prod-project-id>
firebase deploy --only firestore:rules,firestore:indexes
```

## 5. Deploy functions

The scaffold is Cloud Functions v2 (`firebase-functions/v2`), region `us-central1`, Node 20 runtime.

**AUTO:** From the repo root (staging):

```bash
firebase use <staging-project-id>
cd functions && npm ci && cd ..
firebase deploy --only functions
```

First deploy takes ~5 min while Cloud Build provisions. Each function URL prints at the end — note the `stripeWebhook` URL; it's the one you paste into the Stripe webhook endpoint config in [stripe-setup.md](./stripe-setup.md).

If the deploy fails with "secret not found", you need to create the secrets first (next step), then redeploy.

**OWNER:** Prod deploy is the same with `faangin-prod` selected. Only do this after the launch checklist is green.

## 6. Set env vars via Secret Manager

Cloud Functions v2 reads secrets from Google Secret Manager at function cold-start — they are not baked into the deployed bundle. The scaffold declares them via `defineSecret(...)`.

**OWNER:** For each secret below, in each environment, run:

```bash
firebase use <project-id>
firebase functions:secrets:set <SECRET_NAME>
```

The CLI prompts for the value (hidden input, not echoed). Paste the real value here, not into chat with Claude. The CLI then prints a Secret Manager resource name you don't need to record.

Secrets the scaffold reads:

| Secret name | Value | Source |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_REPLACE_ME` (staging) / `sk_live_REPLACE_ME` (prod) | Stripe dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_REPLACE_ME` | Stripe dashboard → the specific webhook endpoint's signing secret |
| `STRIPE_PRICE_BYOK` | `price_REPLACE_ME_byok` | Stripe product price id |
| `STRIPE_PRICE_PRO_MONTHLY` | `price_REPLACE_ME_pro_monthly` | Stripe product price id |
| `STRIPE_PRICE_PRO_YEARLY` | `price_REPLACE_ME_pro_yearly` | Stripe product price id |
| `LICENSE_SIGNING_SECRET` | base64url-encoded 32-byte Ed25519 seed (see §7) | Local generation, pre-KMS migration only |
| `LICENSE_PUBLIC_KEY` | base64url-encoded Ed25519 public key (derived from seed) | Local generation, pre-KMS migration only |
| `APP_BUNDLE_URL` | `https://faangin.app/download` | Public URL, OK to echo |
| `DEVICE_CAP_PRO` | `3` | Config value, OK to echo |
| `DEVICE_CAP_BYOK` | `3` | Config value, OK to echo |

After setting, verify with `firebase functions:secrets:access <SECRET_NAME>` (prints the value — only run on a workstation, never in a shared terminal). Rotate with `firebase functions:secrets:set <SECRET_NAME>` again; the old version stays accessible for 24h unless you destroy it explicitly.

Redeploy functions after changing a secret so new versions pick it up:

```bash
firebase deploy --only functions
```

## 7. Cloud KMS key for Ed25519 signing

The scaffold's initial implementation uses `@noble/ed25519` with the `LICENSE_SIGNING_SECRET` env var (a raw 32-byte seed). This is **acceptable for the staging project and for the first week of local dev only**. Before prod launch, migrate to Cloud KMS so the signing key never leaves Google's HSM.

### 7a. Generate a local Ed25519 key pair (pre-KMS, staging only)

**OWNER:** Run this once, on your workstation, in a scratch directory. Node 20 required.

```bash
node -e "
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
console.log('LICENSE_SIGNING_SECRET=' + seed.toString('base64url'));
console.log('LICENSE_PUBLIC_KEY=' + pub.toString('base64url'));
"
```

Copy the two lines into Secret Manager via `firebase functions:secrets:set` (step 6). Delete the terminal scrollback (`Cmd+K`) and close the window. **Do not** save these to a file or paste into chat with Claude.

### 7b. Create a KMS key (prod)

**OWNER:** Pick a GCP project (same as the Firebase prod project is fine) and a keyring location that matches your Firestore region.

```bash
gcloud auth login
gcloud config set project <prod-project-id>

gcloud kms keyrings create faangin-licensing \
    --location us-central1

gcloud kms keys create license-signer \
    --location us-central1 \
    --keyring faangin-licensing \
    --purpose asymmetric-signing \
    --default-algorithm ec-sign-ed25519
```

Grant the Cloud Functions default service account (`<prod-project-id>@appspot.gserviceaccount.com` for Gen 1, `<project-number>-compute@developer.gserviceaccount.com` for v2) the `roles/cloudkms.signerVerifier` role on that key:

```bash
gcloud kms keys add-iam-policy-binding license-signer \
    --location us-central1 \
    --keyring faangin-licensing \
    --member "serviceAccount:<project-number>-compute@developer.gserviceaccount.com" \
    --role roles/cloudkms.signerVerifier
```

Export the public key (one-time) to a file, then upload its base64url form to Secret Manager as `LICENSE_PUBLIC_KEY` (the function serves this at `/public/license-key`; the Electron app bakes a copy as last-known-good):

```bash
gcloud kms keys versions get-public-key 1 \
    --key license-signer \
    --keyring faangin-licensing \
    --location us-central1 \
    --output-file /tmp/license-public.pem

# Convert to raw base64url (the handler expects raw, not PEM)
# OWNER: do this conversion in Node locally, same shape as 7a's public key export.
```

Flip the function's signing code from `@noble/ed25519` to the `@google-cloud/kms` client (the migration is a sibling-agent task tracked under [launch-checklist.md](./launch-checklist.md)). After the switch, destroy `LICENSE_SIGNING_SECRET` in Secret Manager:

```bash
firebase functions:secrets:destroy LICENSE_SIGNING_SECRET
```

## 8. Service account for CI / sibling agent builds

If sibling agents need to deploy Functions to **staging** (not prod), create a service account with least privilege:

```bash
gcloud iam service-accounts create faangin-ci \
    --display-name "Faangin CI deployer (staging)"

gcloud projects add-iam-policy-binding <staging-project-id> \
    --member "serviceAccount:faangin-ci@<staging-project-id>.iam.gserviceaccount.com" \
    --role roles/cloudfunctions.developer

gcloud projects add-iam-policy-binding <staging-project-id> \
    --member "serviceAccount:faangin-ci@<staging-project-id>.iam.gserviceaccount.com" \
    --role roles/firebasehosting.admin

gcloud iam service-accounts keys create ./service-account.staging.json \
    --iam-account faangin-ci@<staging-project-id>.iam.gserviceaccount.com
```

The resulting `service-account.staging.json` is a credential file — add it to `.gitignore` immediately (see [security.md](./security.md); the current `.gitignore` does not cover it per the readiness review). Never generate a key for a prod service account unless you're moving CI off a human account.

## 9. Verification

With staging deployed:

```bash
curl https://us-central1-<staging-project-id>.cloudfunctions.net/public/license-key
```

Should return JSON like `{"alg":"EdDSA","publicKey":"base64url..."}`. If 404, the function didn't deploy — check `firebase deploy` output. If 500, a secret is missing — `firebase functions:log` will say which.

For prod verification, see [launch-checklist.md](./launch-checklist.md); the smoke tests there are the gate between "deployed" and "accepting traffic".
