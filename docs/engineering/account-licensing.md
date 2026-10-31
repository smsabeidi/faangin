# Accounts and licensing in the app

The desktop app can sign in to a Faangin account, hold a signed license for this Mac, and open Checkout and the Customer Portal. The backend it talks to is [`backend/`](../../backend/README.md); this page covers the app side. Nothing in the app is gated on the license yet.

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

Buying opens Stripe Checkout in the browser. When the app regains focus it re-checks the license (at most once every ten seconds), so the plan appears without a manual refresh.

## How it works

| Piece | File |
| --- | --- |
| Backend client (copy of `backend/client/faangin-cloud.ts`) | `src/main/faangin-cloud.ts` |
| Build and environment configuration, link allowlist | `src/main/licensing/config.ts` |
| Orchestration: sign-in, refresh, Checkout, portal, state | `src/main/licensing/service.ts` |
| Pure state derivation | `src/main/licensing/state.ts` |
| Encrypted refresh token, license file | `src/main/licensing/account-store.ts` |
| Stable device id for the 3-device cap | `src/main/licensing/device-identity.ts` |
| IPC (`faangin:billing-*`), focus hook, shutdown | `src/main/index.ts` (`setupLicensing`) |
| UI | `src/renderer/src/billing/`, section in `Settings.tsx` |

The license is verified offline on every launch against the keys in `LICENSE_PUBLIC_KEYS`, and re-requested in the background at launch and once a day. A license that is offline-valid keeps working; a failed background check stays silent while it does. A stored license for another device or account is not accepted.

## Safeguards

- The refresh token is a credential: it is written only when the OS can encrypt it (the same rule as the saved OpenAI key), as an owner-only file. The license token is signed, not secret.
- Links from the server are opened only if they are the activation page on the configured hosting origin, or Stripe's `checkout.stripe.com` and `billing.stripe.com`. Anything else is refused.
- Packaged builds ignore the `FAANGIN_*` environment overrides and never talk to a local emulator.
- A rejected sign-in (disabled account, revoked token) removes the session and license; a network failure never does.
- Signing out removes the local session and license only. The device keeps its slot on the server until it has been unused for 30 days.

## Before this is usable

- Deploy a backend, then fill `BUILD_CLOUD_CONFIG` and `LICENSE_PUBLIC_KEYS` for that environment ([deploy runbook](../../backend/docs/DEPLOY.md)). Until then the panel reads "Unavailable".
- Not done: gating features on the license (which needs a decision on what an unlicensed user gets), Pro mode through the gateway (`proTransport`), removing a device from the app, and a usage view for Pro allowances.
- Not exercised: the full flow against the Firebase emulators or a deployed project. The service is covered by unit tests with a scripted backend.
