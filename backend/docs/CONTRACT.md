# Faangin Supabase backend contract

The launch backend uses Supabase Auth, Postgres, and Edge Functions with Stripe billing. The current target project is `uxgphdpcgcpgwbwfibkx`; separate environments should use distinct projects, Stripe keys, and license signing keys. The Firebase implementation is retained only as historical source and fixtures.

| Piece | Source | Runtime |
| --- | --- | --- |
| Account identity | Supabase Auth | Managed Auth REST API |
| Device approval, licensing, billing | `backend/supabase/`, `supabase/functions/faangin-api/` | Deno Edge Function |
| Signed Stripe delivery | `supabase/functions/stripe-webhook/` | Separate public Edge endpoint with raw-body signature verification |
| Billing return messages | `supabase/functions/billing-return/` | Plain text Edge endpoint |
| Pro answers and transcription | `backend/gateway/`, generated `supabase/functions/faangin-gateway/` | Node-compatible HTTP/WebSocket server on Deno Edge |
| Browser activation | `src/main/licensing/activation-server.ts` | Expiring loopback page owned by Electron main |
| Account tokens and licenses | `backend/client/faangin-cloud.ts`, `src/main/licensing/` | Electron main process only |

## Storage and privilege boundary

Application data lives in the private `faangin` schema. All application tables enable RLS; `anon`, `authenticated`, and `PUBLIC` receive no table access. Narrow `public.faangin_*` RPCs are `SECURITY INVOKER`, use an empty search path, and grant execution only to `service_role`. Browser clients cannot call them or choose their own entitlement, usage, billing owner, or device-cap result. New RPCs must explicitly revoke PostgreSQL's default `PUBLIC` function execution grant.

| Table | Purpose |
| --- | --- |
| `entitlements` | Per-user entitlement JSON plus version for compare-and-swap updates |
| `customers` | Unique Auth user ↔ Stripe customer mapping |
| `device_codes` | Hashed high-entropy device secret, display code, expiry, approval/exchange lease |
| `devices` | Per-account device identity and 30-day activity window |
| `checkout_leases` | Per-user checkout serialization across workers |
| `stripe_events` | Delivery ownership, retry lease, processed outcome |
| `flags`, `stats` | Global operational controls and active Pro seat count |
| `gateway_usage` | Per-user monthly allowance and daily usage counters |
| `gateway_leases` | Global answer/audio admission slots with expiry |
| `reconcile_dispatches` | Private short-lived, single-use scheduler nonce claims and delivery audit |

`auth.users.id` is the account identity. Authorization never depends on user-editable `user_metadata`. BYOK ownership and Pro subscription state remain independent inside the entitlement; the top-level `plan` and `status` describe the effective access. Pro active/past_due wins while valid, otherwise an owned BYOK license is the fallback.

## Device and account protocol

The account base is `${supabaseUrl}/functions/v1/faangin-api`. Public calls use `apikey: <publishable key>`. User calls also use `Authorization: Bearer <Supabase access token>`; opaque publishable and secret keys are not user bearer tokens. The Edge handler validates the user with Auth `/auth/v1/user` before accepting an authenticated operation. Anonymous Auth users are rejected.

| Route | Request | Result |
| --- | --- | --- |
| `deviceCodeStart` | Raw `{deviceId,deviceName}` | `{deviceCode,userCode,verificationUrl,expiresIn,interval}` |
| `deviceCodePoll` | Raw `{deviceCode}` | Pending, expired, or `{status:'approved',tokenHash,uid}` |
| `deviceCodeApprove` | `{data:{userCode}}`, signed-in user | `{result:{ok:true,deviceName}}` |
| `issueLicense` | `{data:{deviceId,deviceName}}`, signed-in user | `{result:{token,plan,status,expiresAt,graceUntil}}` |
| `createCheckoutSession` | `{data:{plan}}`, signed-in user | `{result:{url}}` |
| `createPortalSession` | `{data:{}}`, signed-in user | `{result:{url}}` |
| `reconcile` | Internal POST with HMAC/time/nonce; manual secret-header fallback | `{result:{checked,failed}}` |

Device codes expire after ten minutes; polling interval is five seconds. Only the device secret's SHA-256 hash is stored. A new start replaces that installation's old pending code. Display codes are normalized for approval. A verified account approves a code, after which one poll atomically claims the exchange lease. The backend uses Auth admin `generate_link` to obtain a one-use email token for that same verified account. The desktop exchanges `token_hash` with `/auth/v1/verify`, then verifies `/auth/v1/user` has the approved ID. This creates a desktop session independent of the browser's session; refresh tokens are never transferred from browser to desktop.

The browser page binds only to `127.0.0.1` on an ephemeral port, requires the exact Host and random unexpired lease, sends no-store headers, and uses a nonce CSP. Its tokens stay in memory and it signs out its local browser session after approval. The desktop encrypts its own rotated refresh token with OS-backed storage and namespaces stored credentials to the Supabase origin. Old Firebase credentials are discarded locally. Refresh is serialized; sign-out clears local credentials immediately and attempts server revocation of only the desktop session.

A license binds the user and device. At most three devices active within 30 days may receive licenses. Device admission is atomic. The signed format is unchanged: `v1.<base64url JSON>.<base64url Ed25519 signature>`, with a 30-day expiry and 14-day offline grace. The backend stores base64 PKCS#8 DER in `LICENSE_SIGNING_KEY`; the desktop receives only matching base64 SPKI public keys.

CORS allows the loopback activation origin. All four Edge Functions are deployed with platform JWT verification disabled because each endpoint enforces its own appropriate boundary: explicit Auth lookup, Stripe signature, internal reconciliation secret, or public return message. Disabling platform verification does not bypass those application checks.

## Checkout, fulfillment, and reconciliation

The client submits only `byok`, `pro_monthly`, or `pro_annual`. Prices and models are server-selected. Lookup keys are `faangin_byok_v1`, `faangin_pro_monthly`, and `faangin_pro_annual`. Catalog setup currently defines USD $10 one-time, $14.99/month, and $144/year, tax exclusive. Actual Stripe catalog values are the source for Checkout amounts.

Checkout holds a per-user five-minute database lease across entitlement checks, customer mapping, subscription inspection, earlier open-session expiry, and session creation. Concurrent checkout attempts fail with a retryable message. Existing live or held subscriptions block another Pro subscription. A paid BYOK Checkout blocks repurchase before webhook fulfillment; replaying its webhook cannot restore a refunded license. Listing follows all pages, and failure to expire an earlier session prevents creation of a new payable session.

The customer email is set only from a verified Auth email. Session and payment/subscription metadata contain the server's user ID and plan. Checkout always uses the mapped customer. BYOK creates an invoice. Customer updates save billing name/address. Sessions expire in 45 minutes; delayed bank debits are excluded. Automatic Tax and terms consent turn on only when their operational flags are true. Return URLs point to the current project's `billing-return` function. That endpoint instructs the buyer to return to the app; the app refreshes its license while payment confirmation finishes.

The portal configuration must be active and tagged `metadata.faangin=v1`. It permits cancel at period end, payment-method and customer-detail updates, and invoice history. Plan switching is disabled so switching cannot reset metered allowances. The arbitrary Dashboard default is never a fallback.

`stripe-webhook` verifies the exact raw body with Stripe's signature and rejects the wrong event mode. `STRIPE_EXPECT_LIVEMODE` must be explicitly true for a live environment; the safe default is false. An event claim is fenced by an owner lease. Fulfillment atomically compares the entitlement version, updates the entitlement and seat count, and marks the event processed. Active delivery contention returns a retryable failure. Stale claims may be recovered; a late worker cannot commit after losing ownership. Customer mapping takes precedence over metadata when resolving an account.

Supported events cover paid BYOK Checkout, current subscription state, invoice paid/failed, full refunds, disputes, and early fraud warnings. Subscription events retrieve current Stripe state to resist out-of-order delivery. Old canceled subscriptions cannot cancel newer subscriptions. Full refunds/disputes revoke the matching plan; partial refunds do not. BYOK remains owned when a Pro subscription ends. Entitlement revocation does not itself cancel future Stripe charges; operational payment settings and support must handle cancellation.

The protected `reconcile` route re-reads eligible Pro subscriptions and applies the same entitlement logic. Scheduled calls carry a 60-second HMAC and a single-use nonce backed by a private dispatch row. The Vault-held shared credential never enters pg_net's queue. A direct secret-header fallback remains for deliberate server-side operations. The daily 03:15 UTC job is installed but remains disabled pending a successful Stripe-backed run. Reconciliation failures are reported and logged without returning secret/provider payloads. The user instructed that pg_net remain unchanged.

## Pro gateway and interview continuity

The gateway base is `${supabaseUrl}/functions/v1/faangin-gateway`. Public routing preserves `/v1/responses`, `/v1/realtime?intent=transcription`, and `/healthz` below that base. User operations validate Auth, require effective Pro access, check operational flags, and read service-only SQL RPCs. The provider key remains server-side. The desktop transport replaces provider credentials with the account token and public apikey and refuses reuse after sign-out.

Answers use SSE. The client names Fast, Smart, or handsfree; the gateway chooses the configured provider model, strips unsupported fields, sets `store:false`, validates selected text/images, and caps output. Admission atomically claims a global slot and increments the allowance before forwarding. At most two answers per user run at once. Smart can fall back to Fast at its limit; handsfree exhaustion returns a safe skipped stream. Counters and leases span workers and billing-period changes.

Monthly allowances are 20 audio hours (5 hours per UTC day), 1,500 handsfree answers, 500 Fast answers, and 25 Smart answers. The first 14 days use 30% caps. Estimated spend backstops are $16/month and $11/day. Annual subscriptions renew allowances on monthly anniversaries of their original billing start. Completed answers use reported usage; interrupted requests use conservative estimates, including an image reserve, and may reach the spend backstop earlier.

Transcription accepts PCM16 mono 24 kHz and at most two audio sockets per user. Usage is charged for forwarded audio, flushed every ten seconds and on close. Lease renewal cannot resurrect an expired/released slot. The once-per-period 30-minute audio grace deadline is shared across channels and reconnects. Failure to persist metering closes audio. Allowance-period rollover closes the socket before more audio is admitted.

Supabase Edge lifetime limits require periodic transcription reconnection. The server signals expiry before its deadline; the desktop rotates managed sessions proactively, refreshes account access before reconnecting, drains old output, and buffers only audio never admitted to an upstream session. The buffer is bounded and stale callbacks are discarded. Fixture reconnection tests do not establish representative long-call or physical-audio quality.

## Verification boundary

Default backend verification covers pure services, localhost HTTP/WebSocket client/gateway transport, signed webhook handlers, and real disposable Postgres transactions and grants. No test suite alone proves remote Auth configuration, email deliverability, Stripe endpoint delivery, provider quota, real audio routing, long-call performance, or a signed/notarized installer. The deployment acceptance steps are in [DEPLOY.md](DEPLOY.md).
