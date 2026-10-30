_Last updated: 2026-10-27_

# Stripe Setup — Owner Runbook

This runbook is for the **owner** only. Agents never run anything here against live mode. Everything is in Stripe **test mode** until the launch checklist clears the switch to live. Every secret ends up in `.secret.local` at the repo root, never pasted into chat with Claude.

Prerequisites: Homebrew-installed Stripe CLI (`brew install stripe/stripe-cli/stripe`), the Faangin repo cloned, a working email the Stripe account will own.

## 1. Create the Stripe account

**OWNER:** Go to https://dashboard.stripe.com/register and sign up with the Faangin owner email. Enable 2FA with a hardware key or TOTP app immediately. Do not finish the "Activate your account" (live mode) flow yet; stay in test mode.

**OWNER:** Install the CLI and log in from the terminal:

```bash
stripe login
```

This opens a browser pairing flow; follow it to the end. The CLI stores a restricted key under `~/.config/stripe/`.

## 2. Decisions you must make before creating products

Each decision below is marked **DECISION REQUIRED** and tracked in [decisions.md](./decisions.md). Record the answer there with the date before moving on.

### DECISION REQUIRED — Legal entity + country

- [ ] Picked: ______________

Stripe will ask for the business country, business type (individual / sole proprietor / LLC / corporation), tax ID (EIN/SSN in the US, equivalents elsewhere), and the owner's personal verification docs. The country gates the Apple Developer enrollment too — if you incorporate in a country without a Managed Payments presence, you lose that option.

Practical tradeoff: individual/sole proprietor is fastest and sufficient for launch; LLC adds a liability wall but requires state filing and a separate EIN. Most solo-dev launches go sole-prop first and migrate to an LLC after the first few paying months. Faangin owner is in the US based on the readiness page context; confirm before answering.

### DECISION REQUIRED — Merchant of record

- [ ] Picked: Stripe Managed Payments / plain Stripe / third-party MoR (Paddle, LemonSqueezy)

Stripe Managed Payments (where available) makes Stripe the merchant of record: Stripe collects, remits sales tax/VAT, and handles chargebacks under their own name. Trade-off: higher per-transaction fee (currently 2.9% + 30¢ + a Managed surcharge) in exchange for not having to register for sales tax in every state yourself.

Plain Stripe: lower fees, but you are the MoR. For a US-only soft launch at <$20k/mo this is often fine and the sales-tax exposure is small; if you ever sell to the EU, VAT is a real problem without Managed or a dedicated tax service (Stripe Tax, TaxJar, etc).

Third-party MoR (Paddle, LemonSqueezy) replaces Stripe entirely and would require re-doing the whole webhook/portal layer. Mentioned for completeness; not recommended given the scaffold is Stripe-shaped.

### DECISION REQUIRED — Business Profile fields

- [ ] Statement descriptor: ______________ (max 22 chars, appears on customer card statements; "FAANGIN" works)
- [ ] Shortened descriptor: ______________ (max 10 chars, "FAANGIN" works)
- [ ] Public business name: ______________
- [ ] Support email: ______________
- [ ] Support URL: ______________ (`https://faangin.app/support` is fine if that page exists)
- [ ] Business website: `https://faangin.app`
- [ ] Product description (one sentence Stripe reads during review): "A macOS assistant that helps you practice technical interviews with on-device transcription and AI-powered feedback."

Record these in the dashboard under Settings → Business settings → Public details.

## 3. Create products and prices (test mode)

**OWNER:** From the dashboard, confirm the environment banner says **TEST DATA** before each click.

Create three products at Dashboard → Products → + Add product.

### Product 1: Faangin BYOK

- Name: `Faangin BYOK`
- Description: `One-time purchase. Bring your own OpenAI key. Perpetual on current major version, approximately 12 months of updates.`
- Price: $10.00 USD, **one-time**.
- Recurring: off.
- After saving, click the price row and copy the `price_...` id.

- [ ] `price_...` id: `price_TBD_byok`

### Product 2: Faangin Pro Monthly

- Name: `Faangin Pro Monthly`
- Description: `Monthly subscription. Server-side gpt-transcribe gateway, 20h/mo transcription (5h/day), ≥1500 hands-free requests, ≥500 Fast, ≥25 Smart. Includes BYOK unlock.`
- Price: $14.99 USD, **recurring, monthly**.
- Billing period: 1 month. Usage type: Licensed.
- After saving, copy the `price_...`.

- [ ] `price_...` id: `price_TBD_pro_monthly`

### Product 3: Faangin Pro Yearly

- Name: `Faangin Pro Yearly`
- Description: `Yearly subscription at $12/mo effective. Same allowances as Pro Monthly.`
- Price: $144.00 USD, **recurring, yearly**.
- Billing period: 1 year.
- After saving, copy the `price_...`.

- [ ] `price_...` id: `price_TBD_pro_yearly`

### Record price IDs

**OWNER:** Open `.secret.local` at the repo root (create it if missing). Append:

```bash
# .secret.local — never commit, never paste into chat with Claude
STRIPE_PRICE_BYOK=price_REPLACE_ME_byok
STRIPE_PRICE_PRO_MONTHLY=price_REPLACE_ME_pro_monthly
STRIPE_PRICE_PRO_YEARLY=price_REPLACE_ME_pro_yearly
```

Replace the `REPLACE_ME` values with the real ones from the dashboard. Save. **Do not paste these into chat with Claude** — Stripe test-mode prices are low-value but we practice the discipline now so prod never leaks.

## 4. Configure Customer Portal

**OWNER:** Dashboard → Settings → Billing → Customer portal.

- Business information: match the Business Profile above.
- Features to enable:
  - Customer update: email + billing address.
  - Payment method: update + remove.
  - Invoice history: on.
  - Subscription cancel: on, **"Immediate" cancellation**. ("At period end" is also acceptable; cancel-at-period-end is more revenue-preserving and the webhook handler covers both.) Mark the choice here:
    - [ ] Immediate / At period end: ______________
  - Subscription cancellation reasons: on, with these reasons: Too expensive, Missing a feature, Switched to another product, Not using it enough, Other.
  - Pause subscription: **off** (not supported by the scaffold's webhook handler at launch).
  - Switch plans: on. Allow switching between Pro Monthly and Pro Yearly. **Do not** list BYOK as a portal-switchable plan; it's one-time.
- Save. Copy the "default redirect URL" field: `https://faangin.app/account?portal=return`.

## 5. Set up the webhook endpoint (test mode)

### Local dev loop

For local development the webhook forwards to the Firebase emulator. In a dedicated terminal:

```bash
stripe listen \
  --forward-to localhost:5001/<project-id>/us-central1/stripeWebhook
```

Replace `<project-id>` with the staging Firebase project id from [firebase-setup.md](./firebase-setup.md).

The CLI prints a webhook signing secret on first run — a `whsec_...` value scoped to this session.

**OWNER:** Copy that `whsec_...` into `.secret.local`:

```bash
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME_from_stripe_listen
```

This secret is **per `stripe listen` session**; it will rotate every time you restart the CLI. That's expected for local dev. The live endpoint (step 6) gets its own fixed secret.

### Hosted test endpoint (before live mode)

**OWNER:** Dashboard → Developers → Webhooks → + Add endpoint, in **test mode**.

- URL: `https://us-central1-<project-id>.cloudfunctions.net/stripeWebhook` (the deployed Cloud Function URL — only exists after you deploy functions once).
- Events to listen for (match `HANDLED_STRIPE_EVENTS` in the scaffold exactly):
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `charge.refunded`
  - `charge.dispute.created`
  - `invoice.payment_failed`
  - `invoice.payment_succeeded`
- Save, open the endpoint, click "Reveal signing secret", copy it.

**OWNER:** This signing secret goes into Firebase Secret Manager (not `.secret.local`), via the Firebase runbook. Keep it out of chat with Claude.

## 6. Live mode (do NOT do this until launch checklist clears)

This is the one-way door. Live mode means real cards, real chargebacks, real refund disputes. Repeat steps 3–5 in live mode only after:

- Business Profile is fully verified in Stripe (government ID, bank account, tax ID — Stripe will not let you activate without these).
- [launch-checklist.md](./launch-checklist.md) all green.
- Prod Firebase project exists and the Cloud Function is deployed.

The live-mode webhook signing secret and live `price_...` ids go into Firebase Secret Manager with the suffix `_PROD`, never into `.secret.local`.

## Verification — "how to prove it works"

With the Firebase emulator running (see [local-dev.md](./local-dev.md)) and `stripe listen` forwarding to it, trigger each `HANDLED_STRIPE_EVENTS` type in a separate terminal and watch the function logs. The scaffold's handler is idempotent via `stripeEvents/{eventId}`, so a repeated trigger with the same `evt_...` should log "already processed, skipping".

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger charge.refunded
stripe trigger charge.dispute.created
stripe trigger invoice.payment_failed
stripe trigger invoice.payment_succeeded
```

For `checkout.session.completed`, the trigger generates a session without the Faangin-specific metadata (`uid`, `price_id`). The handler should log a warning and no-op; this is expected. To exercise the happy path, drive a real test-mode checkout through the app (card `4242 4242 4242 4242`, any future expiry, any CVC) and watch the webhook arrive with real metadata.

Each trigger should:

1. Return `200` from the function.
2. Write a doc to `stripeEvents/{evt_...}`.
3. Update `entitlements/{uid}` if the event carries a `uid` (via metadata or Stripe customer lookup).
4. For revocation events (`charge.refunded`, `charge.dispute.created`), move all `activeJtis` for that uid into `revokedJtis`.

If step 1 fails with a `400`, the signing secret in `.secret.local` is stale — restart `stripe listen` and copy the new `whsec_` value.

## Summary of secrets this runbook produces

| Secret | Scope | Where it lives |
|---|---|---|
| `STRIPE_PRICE_BYOK` | test + prod values | `.secret.local` (test), Secret Manager (prod) |
| `STRIPE_PRICE_PRO_MONTHLY` | test + prod values | same |
| `STRIPE_PRICE_PRO_YEARLY` | test + prod values | same |
| `STRIPE_SECRET_KEY` | test + prod | `.secret.local` (test), Secret Manager (prod). Pull from Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | per-env | `.secret.local` for `stripe listen`; Secret Manager for hosted endpoints |
| `STRIPE_PUBLISHABLE_KEY` | test + prod | Not actually used by Faangin (we don't do client-side Checkout.js); record it anyway for the hosted pricing page |

**Every value above is pasted into `.secret.local` or Secret Manager by the owner, never into a chat window.**
