# Accounts and licensing in the app

The desktop app signs in to a Faangin account, verifies a license for this device, opens Checkout and the Customer Portal, and routes paid Pro chat and transcription through the managed gateway. The target backend is Supabase Auth, Postgres, and Edge Functions; desktop account code is described in [`backend/client/`](../../backend/client/README.md). When an accounts backend is configured, assistance and live capture require a verified active or grace license. BYOK uses the customer's saved provider key; Pro uses the Supabase access token and needs no customer OpenAI key. Backend-free development builds retain the local BYOK workflow when explicitly configured without a cloud backend.

## What the user sees

Settings → **Plan & account** shows one of these states.

| State | Meaning | Offered |
| --- | --- | --- |
| Unavailable | This build has no accounts backend configured | Nothing; the app works as before |
| Signed out | No session | Sign in (opens the activation page, shows a code) |
| No plan | Signed in, nothing bought, or the purchase ended | Buy BYOK, Pro monthly or Pro yearly; Check again |
| Active | A license verifies. Pro shows its renewal or end date; BYOK shows Licensed | Manage billing; Add Pro (BYOK holders) |
| Active, payment failed | Stripe is retrying a card; access continues | Manage billing |
| Needs a check (grace) | Past the 30-day license but inside the 14-day grace window | Check again |
| License expired (locked) | A stored license no longer verifies | Check again |

Buying opens Stripe Checkout in the browser. Returning to the app rechecks the license at most once every ten seconds. Up to twelve background checks, five seconds apart, also reconcile a delayed webhook while the app stays open. A BYOK license does not prematurely confirm a pending Pro upgrade. Returning from Manage billing refreshes cancellation and payment status; Manage billing remains available without an active license so a held subscription can be recovered.

## How it works

| Piece | File |
| --- | --- |
| Supabase REST client (copy of `backend/client/faangin-cloud.ts`) | `src/main/faangin-cloud.ts` |
| Public Supabase build configuration and Stripe link allowlist | `src/main/licensing/config.ts` |
| Orchestration: sign-in, refresh, Checkout, portal, state | `src/main/licensing/service.ts` |
| Pure state derivation | `src/main/licensing/state.ts` |
| Account and provider admission policy | `src/shared/account-access.ts` |
| Encrypted origin-scoped Supabase refresh token, license file | `src/main/licensing/account-store.ts` |
| Stable device id for the 3-device cap | `src/main/licensing/device-identity.ts` |
| IPC (`faangin:billing-*`), focus hook, shutdown | `src/main/index.ts` (`setupLicensing`) |
| Temporary loopback browser activation page | `src/main/licensing/activation-server.ts` |
| UI | `src/renderer/src/billing/`, section in `Settings.tsx` |

The license is verified offline on every launch against the configured environment's `licensePublicKeys` (falling back to `LICENSE_PUBLIC_KEYS` for an explicitly configured source build), and re-requested in the background at launch and once a day. A license that is offline-valid keeps working; a failed background check stays silent while it does. A stored license for another device or account is not accepted.

## Safeguards

- The refresh token is a credential: it is written only when the OS can encrypt it (the same rule as the saved OpenAI key), as an owner-only file. The license token is signed, not secret.
- Activation is served by the main process on one expiring loopback lease. Browser credentials go directly to Supabase, and its refresh token is never transferred to desktop. Server-provided billing links are limited to Stripe's `checkout.stripe.com` and `billing.stripe.com`.
- Packaged builds ignore the `FAANGIN_*` environment overrides and never talk to a local emulator.
- A rejected sign-in (disabled account, revoked token) removes the session and license; a network failure never does.
- Canceling sign-in or signing out discards late code creation and token exchanges, including work already in flight. Account writes are serialized with sign-out and license refresh.
- Pro transport creation refreshes the account ID token before requests, keeps tokens out of renderer state, and refuses to reuse the transport after sign-out. HTTP and WebSocket requests replace provider credentials with the account token.
- Signing out removes the local session and license and attempts to revoke that desktop session only. The device keeps its slot on the server until it has been unused for 30 days.

## Release configuration and remaining acceptance

The build defaults to `config/cloud.supabase.json`. Set `FAANGIN_CLOUD_CONFIG_FILE` to another public JSON file when building a different environment. `electron.vite.config.ts` embeds its `supabaseUrl`, `publishableKey`, `gatewayBase`, and `licensePublicKeys`. These are public Supabase metadata and signing verification keys; never include a Stripe key, OpenAI key, refresh token, or license private key. Packaged apps ignore runtime environment overrides.

`npm run check:launch` validates the release configuration; `npm run verify:launch` runs the launch verification suites. An ordinary build uses the selected project metadata; it does not certify deployed services or a commercial release. See the [backend deployment runbook](../../backend/docs/DEPLOY.md) for the environment that must exist first.

Unpackaged development runs can use `FAANGIN_SUPABASE_URL`, `FAANGIN_SUPABASE_PUBLISHABLE_KEY`, `FAANGIN_GATEWAY_BASE`, and comma-separated `FAANGIN_LICENSE_PUBLIC_KEYS`. Backend loopback HTTP is accepted only for local development. The separate browser activation lease always uses loopback, including packaged apps.

Automated coverage includes scripted account lifecycle and actual localhost HTTP/WebSocket client transports. It verifies cancellation, account revocation, offline licenses, checkout reconciliation, and Pro access admission. It does not certify an actual deployed signup → payment → webhook → interview journey, hardware audio, or model quality. Those launch checks still require the configured deployment and real device acceptance. Device removal and a Pro usage view remain undelivered.
