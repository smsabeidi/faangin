# Deploy runbook

In order, one command per block, from the repo root. **Owner only** marks steps that need the owner's Google, Stripe or OpenAI account; everything else anyone with the repo can run once the owner has done their part. Staging first (`faangin-staging`); production is the same list against `faangin-prod` with the notes at the end.

## 1. Firebase project — owner only

```bash
npx firebase login
```

```bash
npx firebase projects:create faangin-staging
```

Then in the [Firebase console](https://console.firebase.google.com) for `faangin-staging`:

1. Upgrade to **Blaze** and set a budget alert (Google Cloud → Billing → Budgets, e.g. $50/month).
2. **Authentication → Sign-in method**: enable **Google** and **Email/Password**.
3. **Firestore → Create database**, production mode. The location is permanent; use `nam5` (US multi-region) or `us-central1` to sit next to the functions.
4. **Project settings → General**: note the **Web API key**; the desktop app needs it (`client/README.md`).

## 2. First Firebase deploy

```bash
npx firebase deploy --project faangin-staging --only firestore,hosting,functions
```

Functions reference secrets, so this first deploy prompts to create any secret that does not exist yet. Either type the values at the prompts or do step 3 first and deploy again; step 4 ends with a functions deploy anyway.

## 3. Secrets — owner only

Stripe keys come from step 4 (create them there first if you want to skip the prompts).

```bash
npx firebase functions:secrets:set STRIPE_CHECKOUT_KEY --project faangin-staging
```

```bash
npx firebase functions:secrets:set STRIPE_WEBHOOK_KEY --project faangin-staging
```

License signing key: generate, upload, delete the file. The command prints the **public** key on stderr: paste it into `LICENSE_PUBLIC_KEYS` in `client/faangin-cloud.ts` (the app build for this environment).

```bash
node scripts/gen-license-key.mjs > /tmp/license-key.txt
```

```bash
npx firebase functions:secrets:set LICENSE_SIGNING_KEY --project faangin-staging --data-file /tmp/license-key.txt
```

```bash
rm -P /tmp/license-key.txt
```

## 4. Stripe (sandbox for staging)

Run `status` first: it must list the three lookup keys (`faangin_byok_v1`, `faangin_pro_monthly`, `faangin_pro_annual`), print the account name you expect, and show one portal configuration tagged `faangin=v1` (all three were created in the Selmou AI sandbox on 2026-10-28 and 29). If it prints `missing lookup keys` or `(run: portal)`, or names a different account, fix `.env.stripe-sandbox` and run the commands below; every command is idempotent, so re-running is safe. The sandbox secret key lives only in the gitignored `.env.stripe-sandbox` (see `.env.stripe-sandbox.example`) and is used by these scripts, never by the functions.

```bash
node scripts/stripe-setup.mjs status --sandbox
```

```bash
node scripts/stripe-setup.mjs catalog --sandbox
```

```bash
node scripts/stripe-setup.mjs tax-defaults --sandbox
```

```bash
node scripts/stripe-setup.mjs portal --sandbox --return-url https://faangin-staging.web.app/activate
```

Then prove the parameters against the real sandbox (creates and deletes a throwaway customer):

```bash
npm run stripe:smoke
```

### Restricted keys — owner only

**Developers → API keys → Create restricted key**, two of them (the sandbox secret key is never put in Secret Manager):

- `STRIPE_CHECKOUT_KEY`: Checkout Sessions **write**, Customers **write**, Customer portal **write** (sessions and configurations), Prices **read**, Products **read**, Subscriptions **read** (the double-subscription guard). Everything else none.
- `STRIPE_WEBHOOK_KEY`: Checkout Sessions, Subscriptions, Invoices, Charges, Refunds, Disputes **read**. Everything else none.

Set them with step 3's commands.

### Webhook endpoint

After the first functions deploy (step 2), copy the URL `firebase deploy` prints for `stripeWebhook` and create the endpoint with the exact event list and API version the code expects. The signing secret is written to a file, uploaded, and deleted:

```bash
node scripts/stripe-setup.mjs webhook --sandbox --url https://us-central1-faangin-staging.cloudfunctions.net/stripeWebhook --secret-out /tmp/whsec.txt
```

```bash
npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project faangin-staging --data-file /tmp/whsec.txt
```

```bash
rm -P /tmp/whsec.txt
```

Functions pin secret versions at deploy time, so redeploy after setting or changing any secret:

```bash
npx firebase deploy --project faangin-staging --only functions
```

### Stripe Tax — owner only

Until this is done `flags/global.automaticTax` stays `false` and Checkout charges the list price with no tax line. Enabling `automatic_tax` without an active registration makes Stripe collect nothing while looking enabled, so the order matters:

1. **Dashboard → Tax → Settings**: set the head office address (the legal entity's). The Tax status turns `active`.
2. **Tax → Locations → Add registration** for each jurisdiction where the business is registered (or use *Register for me* / Taxually where eligible). Which jurisdictions is a question for the tax advisor. Stripe's threshold monitoring only runs on live-mode transactions, emails only after thresholds are crossed, and does not cover physical-presence obligations such as the home state or country, so Stripe will never prompt for the home-jurisdiction registration: decide it with the advisor before the first live sale. Write the outcome (which registrations were added, or that launching with none was an advisor-backed decision) and the date in the go-live checklist below.
3. Confirm the product tax codes with the advisor: `txcd_10202000` for the Mac app license, `txcd_10103000` for Pro (https://docs.stripe.com/tax/tax-codes). Change them with `catalog` if needed.
4. Set `flags/global.automaticTax: true` in Firestore. Run `npm run stripe:smoke`: it enables tax when registrations exist and prints each session's tax status.
5. Pay one session with a test card from an address inside a registered jurisdiction and check the invoice shows a tax line (sandbox registrations are separate from live ones; repeat in live).

Things to know: while Tax is `pending` (no head office) Stripe refuses to create a session with `automatic_tax` (`stripe_tax_inactive`), and with Tax active but no registration in the buyer's jurisdiction it creates the session and collects nothing, so the flag is flipped only after steps 1 and 2. The flag changes new sessions only: subscriptions created before it keep renewing untaxed until you run the Dashboard's tax migration tool (live mode) and tell those subscribers. After activation, switch on **Settings → Tax → Thresholds** notifications, check the preset tax code matches Pro's `txcd_10103000`, and review **Tax → Locations → Needs attention** monthly in the first year. With tax on and no shipping address, Google Pay is not offered at Checkout; accept that or add shipping collection after testing it in the sandbox. Before choosing the product tax codes, show the advisor the candidates: BYOK `txcd_10202000` (downloadable software, personal use) or `txcd_10202001` (non-recreational); Pro `txcd_10103000` (SaaS, personal use) or `txcd_10103100` (SaaS with electronic download, personal use). The classification is theirs; change it with `catalog` and update `CATALOG`/`tax-defaults` in `scripts/stripe-setup.mjs`. Stripe verifies business tax IDs collected at Checkout by format and zero-rates on that alone; decide the reverse-charge policy with the advisor before turning `automaticTax` on with any VAT/GST registration.

### Dashboard settings — owner only

- **Settings → Business → Public details**: support email, statement descriptor `FAANGIN` (what the card statement shows), terms-of-service and privacy URLs. Once the terms URL is set, `flags/global.termsConsent: true` adds the "I agree" checkbox to Checkout.
- **Settings → Billing → Subscriptions and emails**: Smart Retries on; after the final retry **cancel the subscription** (the webhook then ends access and the buyer can subscribe again; `unpaid` also ends access but leaves a subscription that blocks a new Checkout until its invoice is paid). Send emails for failed payments and for expiring cards.
- **Settings → Emails → Customer emails**: successful payments (receipts) and refunds on. Stripe sends no emails from a sandbox.
- **Settings → Billing → Subscriptions and emails → Manage disputed payments**: set it to cancel the subscription immediately, without prorating. Stripe does not cancel a Pro subscription on a dispute unless this is set, and it never cancels one on a refund or an early fraud warning; the webhook then revokes access but the card would keep being charged, and each renewal is another chargeback. The read-only webhook key cannot cancel, so this setting and the support rule below are the control.
- **Support rule for refunds**: refund a Pro subscriber from the subscription's **Cancel** dialog with "refund the last payment in full" (one action cancels and refunds), never from the Payments page alone. For an early fraud warning on an undisputed charge, refund it (both prices are below the dispute fee). The first revoke of a Pro subscription after a refund, dispute or fraud warning writes an `ERROR` log line "entitlement revoked; confirm the Stripe subscription is canceled" (repeat events for an already revoked plan stay silent; a BYOK-only revoke is a `WARNING` "BYOK license revoked"); create a log-based alert in Google Cloud Logging on `severity=ERROR` and that message so someone checks the subscription the same day. After a correct Cancel + refund the alert still fires once: confirm in the Dashboard that the subscription is canceled and close it.
- **Settings → Payments → Payment methods**: review what is on. The code excludes the delayed bank debits (`us_bank_account`, `sepa_debit`, `bacs_debit`, `acss_debit`, `au_becs_debit`, `nz_bank_account`) on both plans even if they are on here, and still fulfils a BYOK payment only once it is not `unpaid`, so cards, wallets and instant methods are the safe set; a card-only setup is simplest. If bank debits are ever wanted for BYOK, first add a pending-payment marker so a buyer with a debit in flight cannot buy twice.
- **Settings → Business → Public details / Branding / Checkout**: business name, address, support email and phone; icon, logo and colours; show the legal policies, contact information and refund policy on Checkout. After the privacy and terms URLs exist, re-run `node scripts/stripe-setup.mjs portal --sandbox --return-url … --privacy-url … --terms-url …` so the portal shows them.
- **Settings → Billing → Invoices and Invoice template**: invoice numbering prefix, footer and memo; the seller's legal name and address and, once registered, the seller's tax IDs (under the invoice template's Tax section).
- **Settings → Emails**: failed-payment, expiring-card and renewal-reminder emails on (the yearly plan especially), plus the Stripe-hosted link for confirming a payment that needs the buyer's action (3DS), which lands in the Customer Portal. Leave *Send finalized invoices* off (it duplicates the renewal receipt), keep PDF attachments on, turn credit-note emails on, and preview a receipt with *Send test receipt* in Branding.
- **Refunds are credit notes**: refund from the invoice's *More actions → Issue a credit note* with a refund to the original payment method (for a Pro subscriber, from the subscription's Cancel dialog as above), so the invoice, the tax reversal and the buyer's documents line up. A bare refund from the Payments page leaves the invoice untouched.
- **Pausing**: *Pause subscription* stops service (Stripe emits `customer.subscription.paused`, access ends); *Pause payment collection* deliberately keeps the customer entitled.
- **Pricing note**: BYOK's numbered post-payment invoice (`invoice_creation`) is billed separately from Payments; check the current per-invoice fee in the Invoicing pricing page. If a receipt is enough, remove `invoice_creation` in `functions/src/billing/checkout-params.ts`.
- **Settings → Compliance**: complete the PCI questionnaire (SAQ A, hosted Checkout) for the selling entity once the first live key exists, and repeat it yearly.

## 5. Seed the kill switches

In the Firebase console → Firestore, create these two documents by hand (the rules block clients; the console is fine):

- `flags/global`: `{ checkoutOpen: true, proSessionsOpen: true, smartToFast: false, handsfreeOff: false, transcriptionOff: false, blockedUids: [], proSeatCap: 200, automaticTax: false, termsConsent: false }`
- `stats/pro`: `{ activeSeats: 0 }`

## 6. Gateway on Cloud Run

Install and sign in — owner only:

```bash
brew install --cask google-cloud-sdk
```

```bash
gcloud auth login
```

Enable the APIs:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com --project faangin-staging
```

Create the OpenAI key secret — owner only. The command reads the value from stdin: paste the key, press Enter, then Ctrl-D (nothing lands in shell history or a file):

```bash
gcloud secrets create OPENAI_API_KEY --project faangin-staging --replication-policy automatic --data-file=-
```

Let the Cloud Run service account read it (the default compute service account; it already has project access for Firestore and Auth):

```bash
gcloud secrets add-iam-policy-binding OPENAI_API_KEY --project faangin-staging --member "serviceAccount:$(gcloud projects describe faangin-staging --format 'value(projectNumber)')-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor
```

Deploy (builds the container from `gateway/` with Cloud Build and prints the service URL):

```bash
bash scripts/deploy-gateway.sh faangin-staging
```

Put the printed URL into the desktop app as `GATEWAY_BASE`. Rotating the OpenAI key: `gcloud secrets versions add OPENAI_API_KEY --data-file=-` then run the deploy script again (the service binds `latest` at deploy).

## 7. Smoke checks

```bash
curl -s "$(gcloud run services describe faangin-gateway --project faangin-staging --region us-central1 --format 'value(status.url)')/healthz"
```

Expect `ok`. Then a device code without any auth:

```bash
curl -s -X POST https://us-central1-faangin-staging.cloudfunctions.net/deviceCodeStart -H 'content-type: application/json' -d '{"deviceId":"smoke-test-device","deviceName":"Smoke"}'
```

Open the `verificationUrl` from the answer (it is `https://faangin-staging.web.app/activate?code=…`), sign in, approve, and buy the $10 plan with Stripe's test card `4242 4242 4242 4242`. The Stripe webhook log should show every event answered `200`.

## Production notes

- Separate project `faangin-prod`: repeat steps 1 to 7 with `--project faangin-prod` and Stripe in **live mode**. Give the setup script the live key without leaving it in shell history: `read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY` (paste, Enter), then `node scripts/stripe-setup.mjs catalog --live` (a restricted key with Products, Prices, Webhook Endpoints, Customer portal and Tax settings write; same for `tax-defaults`, `portal --return-url https://faangin-prod.web.app/activate` and `webhook --url … --secret-out …`, each of which prints `MODE: live` first; expire that key in the Dashboard only after the go-live checklist's `status --live` item, which needs it too), live restricted keys for the functions, and the live Stripe Tax head office and registrations before the first sale.
- No env file is needed for live mode or the site URL: `functions/src/config.ts` derives both from the Firebase project id. In `faangin-prod` the webhook accepts only live events and every hosted-page URL is `https://faangin-prod.web.app/...`; in any other project (staging, emulator) it accepts only test events and uses that project's own `https://<project>.web.app`. `STRIPE_EXPECT_LIVEMODE=true|false` and `FAANGIN_HOSTING_ORIGIN` still work as overrides (for example a custom domain; put them in `functions/.env.<projectId>`, which Firebase loads at deploy and the repo's `.gitignore` ignores), but forgetting them can no longer put production in test mode or hand out staging links.
- Staging rejects a live event with 400 and production rejects a test event with 400.
- A new license key per environment: run step 3 again for prod and ship the prod public key in the production app build (`LICENSE_PUBLIC_KEYS`, current key first; keep the old one listed for 44 days after a rotation).
- Budget alerts on both projects; the gateway's own backstops (`gateway/src/config.ts`) cap spend per customer.

## Go-live checklist (Stripe, before the first live sale)

Tick each line with the date and who did it.

- [ ] Live restricted keys created (`STRIPE_CHECKOUT_KEY`, `STRIPE_WEBHOOK_KEY`) and uploaded to the `faangin-prod` secrets; no `sk_` key anywhere in Secret Manager.
- [ ] With the setup key loaded as in the production notes (`read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY`), `node scripts/stripe-setup.mjs status --live` prints `MODE: live` and lists the three lookup keys, one tagged portal configuration and the live webhook endpoint. Then expire the setup key.
- [ ] Stripe Tax: head office set, status `active`. Registrations recorded here: ______ (or: launching with none is an advisor-backed decision made on ______). `flags/global.automaticTax` set to match.
- [ ] Terms of service and privacy URLs set, then `flags/global.termsConsent: true`.
- [ ] Dashboard: disputed payments cancel the subscription, failed payments cancel after the final retry, receipts and refund emails on, statement descriptor and invoice business details set.
- [ ] Log-based alert on the "entitlement revoked" error exists and goes to a person.
- [ ] One real card purchase of each plan (then refund it from the subscription's Cancel dialog) shows `applied` for every webhook event and a correct invoice.
- [ ] The sandbox restricted keys were exercised before the live ones were made: load the `rk_test_…` checkout key with `read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY` and run `npm run stripe:smoke` (it covers customers, prices, Checkout create/list/expire and the portal; Tax is not readable with this key and is skipped), then buy a Pro test subscription on staging with the deployed functions (covers `subscriptions.list` and the webhook key's reads) and read both keys' request logs in Workbench for 403 responses.
- [ ] An Advanced access policy (Developers → API keys → Manage access policy) is attached to `STRIPE_CHECKOUT_KEY` and `STRIPE_WEBHOOK_KEY`: allow Google Cloud ASNs and the US, block anonymous VPNs, proxies and Tor. Try it on the staging keys first and check the request logs after the first live traffic.
- [ ] Business details on Checkout, invoices and the portal are the real ones (Public details, Branding, Checkout legal links, invoice template, seller tax IDs).
- [ ] The PCI questionnaire (SAQ A) is complete.

## Rotating Stripe secrets

Firebase pins a secret's version at deploy, so the order is always: change the secret, then redeploy functions inside the overlap.

- **Webhook signing secret**: in Stripe, roll the endpoint's secret with a 24-hour expiry; `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET` with the new value; `firebase deploy --only functions`; then destroy the old secret version.
- **Restricted keys** (`STRIPE_CHECKOUT_KEY`, `STRIPE_WEBHOOK_KEY`): roll with the grace period (up to 7 days), set the secret, redeploy. Never choose "expire now": fulfilment fails until the redeploy finishes.
- The owner's setup key (`.env.stripe-sandbox`, or a live key used once for `stripe-setup.mjs`) is never in Secret Manager; expire it when the setup work is done.

## Known gaps (accepted for launch)

- **No time bound on `past_due`.** A failed renewal keeps Pro and starts a new period's allowance for as long as Stripe keeps retrying; the Dashboard setting "cancel after the final retry" in the go-live checklist is what ends it.
- **Reconcile only re-reads Pro subscriptions that are active or past_due.** If a subscription sat `unpaid` or `paused` (only reachable when the Dashboard keeps unpaid subscriptions or support pauses one), was then paid or resumed, and every Stripe retry of the recovery events was missed, the entitlement stays canceled until another event arrives. Fix by resending the latest `customer.subscription.updated` for that subscription from Workbench (15 days) or the CLI (30 days).
- **Delayed bank debits are excluded**, so there is no pending-payment state to track; see the Payment methods note before changing that.
- **A BYOK buyer who pays twice** (card, then a second Checkout opened before the first webhook landed) is possible only inside a few seconds; the expiry of older open sessions and the "already purchased" check make it unlikely, and support refunds the duplicate.
