# Faangin backend

Accounts, device approval, billing, licenses, and managed Pro inference use Supabase Auth, Postgres, and Edge Functions. Stripe remains the payment provider. The implementation contract is in [CONTRACT.md](docs/CONTRACT.md), and deployment steps are in [DEPLOY.md](docs/DEPLOY.md).

The desktop carries public project metadata and an offline license verification key. Supabase secret/service-role keys, Stripe keys, the license signing key, and the provider key stay in Edge secrets. Application tables are private, protected by RLS, and accessed through service-only RPCs.

## Layout

| Path | Purpose |
| --- | --- |
| `supabase/` | Account/billing services, SQL schema source, and local Postgres tests |
| `gateway/` | HTTP SSE/WebSocket gateway, Supabase authentication and SQL metering adapters |
| `../supabase/functions/` | Deployable `faangin-api`, `stripe-webhook`, `billing-return`, and generated `faangin-gateway` entry points |
| `../supabase/migrations/` | Combined deployable database migrations |
| `client/` | Main-process Supabase REST client and localhost integration fixtures |
| `scripts/` | Secret scan, license key generator, Stripe setup and sandbox smoke |
| `functions/`, `hosting/`, `firestore.*` | Historical Firebase implementation and regression fixtures; excluded from the default launch path |

## Local verification

Use Node 22.13+, Deno, and Postgres tools (`initdb`, `pg_ctl`, `psql`) on PATH. Install dependencies from the repository root:

```sh
npm ci
npm --prefix backend ci
npm --prefix backend/supabase ci
npm --prefix backend/gateway ci
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm --prefix backend run smoke:gateway
```

The default backend suite runs account/billing and gateway fixtures, client transport tests, Edge handler tests, and actual SQL concurrency/privilege tests in disposable local Postgres clusters. It does not require Firebase, Docker, deployed project credentials, payment secrets, or live model calls. The gateway smoke starts the bundled Deno entry point with local upstream fixtures. Deno commands explicitly disable automatic node_modules installation so they cannot replace npm dependencies.

Historical Firebase tests remain available through `legacy:firebase:*` scripts. They are not Supabase deployment evidence.

## Stripe and deployment

`npm run stripe:status` checks the configured sandbox account. `npm run stripe:smoke` exercises the current Supabase service's Checkout parameters directly against Stripe's sandbox and cleans up its throwaway customer and sessions. These commands accept `STRIPE_SECRET_KEY` or the legacy ignored `.env.stripe-sandbox` convention and do not run as part of `npm test`. Sandbox runtime keys are kept in the ignored `.env.stripe-runtime.local` and live ones in `.env.stripe-live-keys.local`; do not copy their values into shell arguments. The approved OAuth CLI path and current key status are described in [Stripe setup](docs/STRIPE-SETUP.md). Use `--secret-out` when configuring a webhook so its one-time signing secret is never printed.

The selected Supabase project is `uxgphdpcgcpgwbwfibkx`; its schema and four Edge Functions are deployed. Production billing has run on the live SIDGROUP LLC Stripe account since November 6, 2026; see [Stripe setup](docs/STRIPE-SETUP.md#production-account). The sandbox evidence here predates that switch: both restricted sandbox keys passed required reads and unpaid smoke, and the sandbox webhook was enabled. A directly signed ignored-event/replay probe passed; [BYOK sandbox completion](docs/PAID-SANDBOX-ACCEPTANCE.md) now has independent Stripe/database/runtime-license proof with no real funds; its exact automatic webhook delivery was directly observed HTTP 200/applied. Post-purchase BYOK duplicate rejection passed; The renewed Pro monthly sandbox Subscribe now has independent payment/delivery/database/Pro-license/duplicate-rejection proof, while one exact hosted Pro completion replay passed unchanged-state checks; other replay/delivery-order negatives, Pro lifecycle and desktop UI/restart acceptance remain open. The team owns faangin.com and can administer its Hostinger DNS; Resend now marks auth.faangin.com Verified with DKIM and both Forge CNAME sending checks passed. The domain-restricted Sending key is connected and Supabase custom SMTP save/reload verification passed. The unused duplicate key was deleted after fresh approval. Actual signup confirmation and recovery mail were delivered to the approved inbox; confirmation signed in, while [device/native acceptance](docs/SMTP-SETUP.md) remains pending: recovery-page UI confirms the password saved, while the device code expired without session exchange. Follow [DEPLOY.md](docs/DEPLOY.md) to inspect the target, configure remaining Auth settings, and complete remote acceptance. Local tests alone do not establish readiness for customers.

The initially exposed Supabase server credentials still require a verified cutover/retirement; this is a critical launch gate. See the [read-only rotation audit](docs/SUPABASE-KEY-ROTATION.md). The shared selector code is deployed, but not configured: default still selects the exposed key. The audit records the remaining named-key cutover and signer/session impact; no rotation was performed.

Current lifecycle checkpoint: the fix is deployed and a guarded nonempty reconciliation plus scheduled signed-Pro cancellation verification passed. The separate owned scheduled database check passed, then the exact sandbox subscription was canceled without proration/new invoice/refund. Owned database state is BYOK active with Pro canceled and zero seats; fresh signed BYOK fallback has passed with Pro-only license fields cleared. Daily cron is OFF.
