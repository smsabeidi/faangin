# Faangin backend contract

One Firebase project per environment (`faangin-staging`, `faangin-prod`), Blaze plan. Everything below is the whole backend. Keep it this small.

| Piece | Where | Runtime |
|---|---|---|
| Accounts | Firebase Auth (Google + email/password) | managed |
| Device sign-in, license, billing | `functions/` Cloud Functions v2, Node 22, region `us-central1` | firebase-functions 7 |
| Data | Cloud Firestore, **every collection server-only** (`firestore.rules` denies all) | managed |
| Pro gateway | `gateway/` one Cloud Run service `faangin-gateway` (HTTP SSE + WebSocket proxy to OpenAI with metering) | Node 22 container |
| Pages | `hosting/` Firebase Hosting: `/activate`, `/billing/success`, `/billing/cancel` | static |
| Desktop client | `client/faangin-cloud.ts` drop-in for the Electron main process | copied into the app repo later |

Principles: the client never sends a price, model name, amount or Stripe id. The server picks everything. Secrets come from Secret Manager (`defineSecret`), never `process.env` in deployed code. Nothing in Firestore is readable by clients. Pure functions for every decision so tests need no network.

## Firestore schema (all server-only)

| Collection | Doc | Fields |
|---|---|---|
| `entitlements` | `{uid}` | see `functions/src/entitlements.ts`. BYOK and Pro are tracked independently: `byok: { status: 'active'\|'revoked', … }` and `pro: { status, subscriptionId, … }` each carry their own status. The top-level `plan`/`status` are the **plan in force**, derived by `fulfill.ts` (Pro while its subscription is active/past_due, else BYOK while owned, else the leftover state for support). `issueLicense` and the gateway read only those two fields. |
| `customers` | `{uid}` | `{ stripeCustomerId, email, createdAt }` |
| `customersByStripe` | `{stripeCustomerId}` | `{ uid }` |
| `stripeEvents` | `{eventId}` | `{ type, receivedAt, processedAt? }` — idempotency record |
| `deviceCodes` | `{userCode}` | `{ deviceCodeHash (sha256 hex), deviceId, deviceName, createdAt, expiresAt, status: 'pending'\|'approved', uid? }` |
| `devices/{uid}/items` | `{deviceId}` | `{ name, firstSeenAt, lastSeenAt, lastLicenseAt }` |
| `usage/{uid}/periods` | `{periodKey}` | `{ audioSeconds, handsfree, fast, smart, spendUsd, graceUsedAt?, days: { 'YYYY-MM-DD': { audioSeconds, spendUsd } }, updatedAt }` — gateway writes with `FieldValue.increment` |
| `flags` | `global` | `{ checkoutOpen: true, proSessionsOpen: true, smartToFast: false, handsfreeOff: false, transcriptionOff: false, blockedUids: [], proSeatCap: 200, automaticTax: false, termsConsent: false }` — kill switches and Checkout options, edited in the console. Read strictly (`parseCheckoutFlags()`): `automaticTax` and `termsConsent` are on only when exactly `true`; `checkoutOpen` is open when absent or exactly `true` and closed for any other value (so the string `"false"` closes it); `proSeatCap` accepts a number or a numeric string, anything else means 200. `automaticTax` is flipped on only after Stripe Tax is active with registrations (otherwise Stripe collects nothing and says nothing); `termsConsent` only after the terms-of-service URL is set in the Dashboard. |
| `stats` | `pro` | `{ activeSeats }` kept by the webhook (transaction) |

All timestamps are Unix milliseconds (numbers). `periodKey` for a monthly Pro subscription is `String(entitlement.pro.currentPeriodStart)`. For a **yearly** Pro subscription (Stripe's period `currentPeriodEnd − currentPeriodStart` is over 35 days) it is the latest monthly anniversary of `currentPeriodStart` at or before now (UTC, same time of day, day of month clamped to the month's length, always counted from the original start), so the printed allowances and the $16 spend backstop renew every month instead of once a year; the first month's key equals `String(currentPeriodStart)`. For anything else the UTC month `YYYY-MM`. Implemented by `periodKey()` / `monthlyAnniversary()` in `gateway/src/meter.ts`.

## Functions

Callable protocol (`onCall`): the client POSTs `{ data }` with `Authorization: Bearer <Firebase ID token>`; errors use `HttpsError` codes. HTTP functions (`onRequest`) take JSON bodies and answer JSON. CORS: allow all origins on the two device-code HTTP functions and the callables (the desktop app has no origin).

### `deviceCodeStart` — `onRequest`, POST
- in `{ deviceId: /^[A-Za-z0-9_-]{8,64}$/, deviceName: string ≤ 64 }`
- out `{ deviceCode, userCode, verificationUrl, expiresIn: 600, interval: 5 }`
- `userCode`: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the response and `verificationUrl` (`${HOSTING_ORIGIN}/activate?code=…`) carry the display form `ABCD-EFGH` so the Mac and the page show the same string; the doc id is the raw 8 chars and `deviceCodeApprove` normalizes case, spaces and dashes. `deviceCode`: 32 random bytes base64url; only its sha256 hex is stored. One pending code per `deviceId` (a new start replaces the old).

### `deviceCodeApprove` — `onCall`, auth required
- in `{ userCode }` (normalize: uppercase, strip spaces and dashes)
- out `{ ok: true, deviceName }`
- `not-found` when unknown or expired; `failed-precondition` when already approved. Sets `status: 'approved', uid`.

### `deviceCodePoll` — `onRequest`, POST
- in `{ deviceCode }`
- out `{ status: 'pending' }` | `{ status: 'approved', customToken, uid }` | `{ status: 'expired' }`
- On approved: `auth.createCustomToken(uid)`, then delete the doc (single use). Lookup is by `deviceCodeHash` (query), never by user code.

### `issueLicense` — `onCall`, auth required, secret `LICENSE_SIGNING_KEY`
- in `{ deviceId, deviceName }`
- out `{ token, plan, status, expiresAt, graceUntil }`
- `failed-precondition` when `entitledPlan(entitlement) === 'none'`. Device cap: upsert `devices/{uid}/items/{deviceId}`; count devices with `lastSeenAt` in the last 30 days; a **new** device beyond `DEVICE_LIMIT` (3) gets `resource-exhausted`.
- Token: `v1.<base64url(payload JSON)>.<base64url(Ed25519 signature over the payload bytes)>`. Payload `{ v: 1, uid, plan: 'byok'|'pro', status, iat, exp (iat + 30 d), grace (exp + 14 d), deviceId, periodEnd?, rampUntil?, cancelAtPeriodEnd? }`. Key: `LICENSE_SIGNING_KEY` is base64 PKCS#8 DER; the matching public key (base64 SPKI DER) ships in the app. Signing and verifying live in `functions/src/license/sign.ts` as pure functions.

### `createCheckoutSession` — `onCall`, auth required, secret `STRIPE_CHECKOUT_KEY`
- in `{ plan: 'byok' | 'pro_monthly' | 'pro_annual' }`
- out `{ url }`
- Pro plans need `flags/global.checkoutOpen` and `stats/pro.activeSeats < proSeatCap`; BYOK is never gated. `failed-precondition` when the user already has that plan: BYOK already bought, or Pro active/past_due in Firestore **or** any live subscription on the Stripe customer (an `unpaid` or `paused` one gives no access but still blocks, with the message "Your Pro subscription is on hold. Use Manage billing to pay the open invoice, or contact support." instead of "Pro is already active"; `liveSubscriptionState()`) (`stripe.subscriptions.list` checked before creating a subscription session, so two Pro subscriptions can never be billed). BYOK and Pro are not exclusive of each other. Customer: reuse `customers/{uid}` else `stripe.customers.create({ email, metadata: { uid } })` and store both `customers` and `customersByStripe`. The email goes on the customer only when the Firebase token has `email_verified` (Checkout prefills and locks a customer's email, so an unverified, possibly mistyped address would get every receipt; without one Checkout asks the buyer). Creation carries an `Idempotency-Key` derived from a hash of the uid, the verified email and the current minute (`customerIdempotencyKey()`), so two concurrent first checkouts share one customer while a transient Stripe 5xx, which Stripe replays under a key for 24 hours, can only affect that minute. Before creating the session, every earlier `open` Checkout Session of the customer is expired, so a buyer can never pay two at once. Session: built by the pure `checkoutSessionParams()` in `functions/src/billing/checkout-params.ts` (the emulated tests and `scripts/stripe-sandbox-smoke.mjs` send the same object): `mode: 'payment'` for BYOK, `'subscription'` for Pro; price from `stripe.prices.list({ lookup_keys: [...] })`; `client_reference_id: uid`; `metadata: { uid, plan }` on the session and on the payment intent (BYOK, with `description`) or the subscription (Pro, `subscription_data.metadata` and `description: 'Faangin Pro'`); `customer_update: { name: 'auto', address: 'auto' }` so the name and billing address entered at Checkout land on the Customer for invoices and tax; BYOK adds `invoice_creation: { enabled: true, invoice_data: { description, metadata } }` so the one-time purchase gets a numbered invoice and PDF; `integration_identifier: 'faangin_activate_<8 letters>'` tags the flow in the Dashboard; `success_url: ${HOSTING_ORIGIN}/billing/success?session_id={CHECKOUT_SESSION_ID}`; `cancel_url: ${HOSTING_ORIGIN}/billing/cancel`; `allow_promotion_codes: false`; `expires_at` = now + 45 minutes (Stripe allows 30 minutes to 24 hours); `excluded_payment_method_types` = the delayed bank debits `us_bank_account, sepa_debit, bacs_debit, acss_debit, au_becs_debit, nz_bank_account` on both plans (Pro starts at Checkout, so a debit that settles or fails days later would grant access before the money arrives; for BYOK a pending debit leaves the buyer without a license for days and invites a second purchase). Never `payment_method_types` (Stripe picks eligible methods from the Dashboard). The Pro seat cap is soft: it is checked when a session is created, so it can be exceeded by the sessions open at once (at most 45 minutes of them). With `flags/global.automaticTax`: `automatic_tax: { enabled: true }` and `tax_id_collection: { enabled: true }` (business buyers can add a VAT/GST id). With `flags/global.termsConsent`: `consent_collection: { terms_of_service: 'required' }`.

### `createPortalSession` — `onCall`, auth required, secret `STRIPE_CHECKOUT_KEY`
- out `{ url }`; `return_url: ${HOSTING_ORIGIN}/activate`. `failed-precondition` when there is no customer, or when no Customer Portal configuration tagged `metadata.faangin == 'v1'` exists (created by `node scripts/stripe-setup.mjs portal`; chosen by the pure `pickPortalConfiguration()`, remembered per instance for 10 minutes once found; an error is logged). The Dashboard default configuration is never used as a fallback: it may allow plan switching. That configuration allows cancel at period end (with a reason), payment-method update, invoice history and email/name/address/tax-id edits, and **not** plan switching: a monthly↔annual switch would start a new billing period and reset the metered allowances for a prorated few dollars; switching is a support action.

### `stripeWebhook` — `onRequest`, secrets `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_KEY`
1. `stripe.webhooks.constructEvent(req.rawBody, sig, secret)` → 400 on failure.
2. Live-mode check: `event.livemode` must equal `expectLivemode()` (`functions/src/config.ts`): the `STRIPE_EXPECT_LIVEMODE` env when it is exactly `true` or `false`, otherwise `true` only in the Firebase project `faangin-prod`. Production therefore rejects test events, and every other project (staging, emulator, unknown) rejects live ones, even if no env file was deployed → 400 otherwise. Hosted-page URLs come from `hostingOrigin()`: `FAANGIN_HOSTING_ORIGIN` when set, otherwise `https://<project id>.web.app`; the project id is read from `FIREBASE_CONFIG` (set in deployed functions and the emulator), never from a default that names another environment.
3. Idempotency: transaction creating `stripeEvents/{event.id}`; if it exists and is processed, answer 200 immediately; if it was claimed under 10 minutes ago and is not processed, another delivery is in flight: answer 500 so Stripe retries (a 200 would end the retries even if that delivery then dies). A stale unprocessed claim (crash, timeout, deploy) is re-taken so Stripe's retry gets applied. The function timeout is 120 s, below that window.
4. Resolve `uid`: `customersByStripe/{customer}` (the Stripe customer is the ownership boundary; for charge events the charge is retrieved to find the customer), falling back to the `metadata.uid` our own sessions and subscriptions carry; a disagreement between the two is logged as an error. Unknown → log and 200 (nothing to do).
5. `next = applyStripeEvent(current, normalized, now)` from `fulfill.ts`; write `entitlements/{uid}`; keep `stats/pro.activeSeats` right (transaction); mark the event processed. 500 on any thrown error so Stripe retries.

Events and their effect (`fulfill.ts` is pure and unit-tested):

| Event | Effect |
|---|---|
| `checkout.session.completed` or `checkout.session.async_payment_succeeded`, `mode: payment`, `payment_status` not `unpaid`, `metadata.plan: byok` | `plan: byok, status: active, byok: { purchasedAt, paymentIntentId, checkoutSessionId }`. A delayed payment method (bank debit) completes the session while still `unpaid`: nothing is granted until `async_payment_succeeded`. |
| `checkout.session.async_payment_failed` | logged only; nothing was granted |
| `invoice.finalization_failed` | logged at `ERROR` (invoice, customer, error code): with Stripe Tax on, a renewal that cannot be finalized is not collected while the subscription stays `active`; no entitlement change |
| `checkout.session.completed`, `mode: subscription` | fetch the subscription with `STRIPE_WEBHOOK_KEY`, then treat as below |
| `invoice.paid` with a subscription | fetch the subscription and treat as below (heals a missed or out-of-order subscription event) |
| `customer.subscription.created` / `updated` / `deleted` / `paused` / `resumed` | The payload only triggers: delivery order is not guaranteed, so the current subscription is retrieved with `STRIPE_WEBHOOK_KEY` and applied (a late `active` event cannot revive a canceled subscription); the payload is used only if Stripe says the subscription no longer exists, and any other retrieve failure answers 500 so Stripe retries. `pro.status` map: `active`,`trialing` → `active`; `past_due` → `past_due` (Stripe is still retrying, access continues); `unpaid`,`paused`,`canceled`,`incomplete_expired` → `canceled` (Stripe stopped collecting: access ends until an invoice is paid and an active event arrives); `incomplete` → no change. A `canceled`/`incomplete_expired` event for a subscription id other than the stored one is ignored (an old subscription can never cancel a newer one); an active/past_due event for a new id replaces the stored subscription. Period from `items.data[0].current_period_start/end` (API 2025-03-31+), fallback `current_period_start/end` (seconds → ms). `startedAt` kept from the first sighting; `rampUntil = startedAt + 14 d`; `cancelAtPeriodEnd` copied. |
| `invoice.payment_failed` (has subscription) | `status: past_due` |
| `charge.refunded` with `refunded: true` (full) | `revoked, reason: 'refund'` on whichever plan the charge paid (BYOK when the payment intent matches `byok.paymentIntentId`, else Pro); partial refunds ignored |
| `charge.dispute.created` | `revoked, reason: 'dispute'` on the plan the charge paid |
| `radar.early_fraud_warning.created` | Pro only: `pro.status: revoked, reason: 'fraud_warning'` |

### `reconcileEntitlements` — `onSchedule('every 24 hours')`, secret `STRIPE_WEBHOOK_KEY`
For every `entitlements` doc with `plan == 'pro'` and status `active` or `past_due`: retrieve the subscription and re-apply through `fulfill.ts`. A missed webhook is never permanent.

Stripe client: `functions/src/billing/stripe-client.ts` exports `makeStripe(key)`; when `STRIPE_API_BASE` is set (tests only) it points the SDK at that host (`host`, `port`, `protocol: 'http'`). Tests run a tiny fake Stripe HTTP server on port 4242 (`functions/test/fake-stripe.ts`) that answers `POST /v1/customers`, `GET /v1/prices`, `POST /v1/checkout/sessions`, `POST /v1/billing_portal/sessions`, `GET /v1/subscriptions/:id`, and sign webhook bodies with `stripe.webhooks.generateTestHeaderString`.

## Gateway (Cloud Run)

Env: `OPENAI_API_KEY` (Secret Manager → env) and `PORT`. Application Default Credentials give Firestore, Auth and the project id (nothing else to set on Cloud Run). Constants in `gateway/src/config.ts`. All dependencies injected through `createGateway({ verifyIdToken, loadEntitlement, loadFlags, store, openaiBase, openaiWsBase, openaiKey, now, log })` so tests use fakes and an in-memory store; `server.ts` wires the Firebase implementations.

Auth on every route: `Authorization: Bearer <Firebase ID token>` → 401 otherwise. `entitledPlan !== 'pro'` → 402 `{ error: { code: 'no_pro', message } }`. `blockedUids` contains uid → 403. `proSessionsOpen` false → 503 `{ error: { code: 'pro_paused' } }`. Entitlement and flags cached 30 s per uid.

### `POST /v1/responses` (SSE)
Client sends its usual Responses body with `model` set to a **mode**: `fast` | `smart` | `handsfree` (anything else → 400 `invalid_mode`). Gateway builds the upstream body from an allowlist only: `input`, `instructions`, `max_output_tokens` (capped per mode), `reasoning`, `text`, `truncation`, `prompt_cache_key`; sets `model` from `MODELS[mode]`, `stream: true`, `store: false`. Everything else is dropped (tools, previous_response_id, metadata…).

Metering, in order: concurrency (> 2 in flight → 429 `concurrency`); `smart` when `smart` count ≥ 25 or `flags.smartToFast` → silently run as `fast` and add response header `x-faangin-mode: fast`; `fast` ≥ 500 → 429 `{ error: { code: 'allowance_exhausted', allowance: 'fast' } }`; `handsfree` ≥ 1500 or `flags.handsfreeOff` → 200 with a synthetic SSE stream whose `response.completed` has empty `output` and zero usage (a "skipped", never an error); backstop (`spendUsd` ≥ $16 month or ≥ $11 UTC day) → 429 `backstop`. Ramp: while `now < rampUntil` every count cap is 30 % of the printed one. Increment the mode counter **before** forwarding (a cancelled request still counts). Pipe upstream bytes through verbatim; parse `response.completed` for `usage` and add estimated cost (`PRICES`) to `spendUsd` and `days[today].spendUsd`; a stream that ends without usage settles at the cap estimate. Upstream non-2xx → same status with upstream JSON body. 

### `GET /v1/realtime?intent=transcription` (WebSocket)
Upgrade with the same `Authorization` header. Up to 2 sockets per uid (one per audio channel); more → close 1008. `flags.transcriptionOff` → close 1013. Upstream: `${OPENAI_WS_BASE}/v1/realtime?intent=transcription` with the server key.

Client → upstream allowlist: `session.update` (force `session.audio.input.transcription.model = MODELS.transcribe` and `session.audio.input.format = { type: 'audio/pcm', rate: 24000 }`, the only format the metering math is right for; keep `languages`, `prompt` ≤ 2 500 chars, `delay`, `turn_detection`), `input_audio_buffer.append` (count bytes: base64 length × 3/4 ÷ 48 000 = seconds), `input_audio_buffer.commit`, `input_audio_buffer.clear`. Everything else dropped. Client messages over 1 MiB close the socket (1009).

Audio metering: seconds are charged on every forwarded `append` (so server VAD, never-committing clients and clear-after-commit are all metered). All of a uid's sockets share one in-memory usage copy. Limits: `audioSeconds` ≥ 20 h/period, `days[today].audioSeconds` ≥ 5 h, backstop. When a limit is first hit in a period (`graceUsedAt` unset) a 30-minute wall-clock grace window opens at `graceUsedAt`, shared by all the uid's sockets and reconnects; it cannot be extended. Past that the socket is **muted**: appends are dropped, each `commit` is answered with a synthetic `{ type: 'input_audio_buffer.committed', event_id, item_id: 'faangin_muted_<n>', previous_item_id: null }`, `clear` is acknowledged with `input_audio_buffer.cleared`. Never send `error` events to the client; log upstream errors instead. Upstream close → close client 1011. Close after 30 min with under 1 s of audio. Flush usage to the store every 10 s and on close.

### `GET /healthz` → `200 ok`

## Desktop client (`client/faangin-cloud.ts`)
Self-contained, no dependencies beyond Node (`crypto`, `fetch`) and `ws`. Exports: `startDeviceSignIn(functionsBase, device)`, `pollDeviceSignIn(functionsBase, deviceCode)`, `exchangeCustomToken(apiKey, customToken)` and `refreshIdToken(apiKey, refreshToken)` (Identity Toolkit / Secure Token REST), `callFunction(functionsBase, name, data, idToken)`, `fetchLicense(...)`, `verifyLicense(token, publicKeyBase64, nowMs)` → payload | null (valid through `grace`), and `proTransport(getIdToken, gatewayBase)` → the app's `InferenceTransport` (`fetch` rewrites `https://api.openai.com/v1/...` to the gateway and swaps `Authorization`; `createWebSocket` likewise). `LICENSE_PUBLIC_KEYS` holds current and next public keys.

## Pages (`hosting/`)
`activate.html`: Firebase Auth compat SDK from the CDN, config from the reserved URL `/__/firebase/init.js`; sign in with Google or email/password; shows the code from `?code=` for the buyer to compare with the Mac; calls `deviceCodeApprove`; then shows plan buttons (`createCheckoutSession`) and "Manage billing" (`createPortalSession`). `billing-success.html`, `billing-cancel.html`: plain pages linking back to `/activate`.

## Stripe account setup (`scripts/stripe-setup.mjs`)
One idempotent script configures a Stripe environment through the API; it creates what is missing, updates drift, deletes nothing and prints no API keys (the first line is `MODE: test` or `MODE: live`, from the key prefix; `--live` refuses a test key). The webhook signing secret goes to `--secret-out FILE`, reserved before the endpoint is created; without that flag it is printed once. `node scripts/stripe-setup.mjs <command> --sandbox` reads `STRIPE_SANDBOX_SECRET_KEY` from the gitignored `.env.stripe-sandbox` (format in `.env.stripe-sandbox.example`); live runs pass `STRIPE_SECRET_KEY=rk_live_… … --live`.

| Command | Creates / checks |
|---|---|
| `status` | account, Stripe Tax status and registrations, catalog table, portal configurations, webhook endpoints |
| `catalog` | product `Faangin BYOK license` (`tax_code txcd_10202000`, downloadable software, personal use; `statement_descriptor FAANGIN BYOK`) with price `faangin_byok_v1` $10 one-time, and product `Faangin Pro` (`txcd_10103000`, SaaS, personal use; `FAANGIN PRO`) with `faangin_pro_monthly` $14.99/month and `faangin_pro_annual` $144/year. All USD, `tax_behavior: exclusive` (tax is added on top; this cannot be changed on a price once set, so a drifted price is replaced and the lookup key moved). Products are found by `metadata.faangin_key`. |
| `tax-defaults` | account defaults `tax_behavior: exclusive`, `tax_code: txcd_10103000`. The head office and registrations stay owner steps in the Dashboard. |
| `portal` | the Customer Portal configuration tagged `metadata.faangin=v1` (features above) |
| `webhook --url … [--secret-out FILE] [--disabled]` | the endpoint for `stripeWebhook`, pinned to the SDK's API version, subscribed to exactly the events in the table above |

`scripts/stripe-sandbox-smoke.mjs --sandbox` (after `npm --prefix functions run build`) creates a throwaway customer, one Checkout Session per plan with the production parameters and a portal session against the real sandbox, prints the URLs, then expires and deletes everything (`--keep` to pay one with a test card). `scripts/check-secrets.sh` (first step of `npm test`) fails when a Stripe key, webhook secret or private key is in a tracked file.

## Secrets
| Name | Used by | Set with |
|---|---|---|
| `STRIPE_CHECKOUT_KEY` (restricted: write Checkout Sessions, Customers, Customer portal (sessions and configurations); read Prices, Products, Subscriptions) | createCheckoutSession, createPortalSession | `firebase functions:secrets:set STRIPE_CHECKOUT_KEY --project faangin-staging` |
| `STRIPE_WEBHOOK_KEY` | stripeWebhook, reconcileEntitlements | same |
| `STRIPE_WEBHOOK_SECRET` | stripeWebhook | same (after adding the endpoint in Stripe) |
| `LICENSE_SIGNING_KEY` | issueLicense | `node scripts/gen-license-key.mjs` then `--data-file` |
| `OPENAI_API_KEY` | gateway | Secret Manager, mounted as env on Cloud Run |

Emulator: `functions/.secret.local` from `scripts/dev-secrets.mjs` (gitignored).
