# faangin-backend

Accounts, device sign-in, licensing, billing and the Pro inference gateway for the Faangin desktop app, all on Firebase. The spec is [docs/CONTRACT.md](docs/CONTRACT.md); the owner runbook is [docs/DEPLOY.md](docs/DEPLOY.md).

Principles: the client never sends a price, model name or Stripe id. Secrets live in Secret Manager. Every Firestore collection is server-only. Decisions are pure functions so tests need no network.

## Layout

| Path | What | Runs on |
|---|---|---|
| `functions/` | Cloud Functions v2 (Node 22): device code sign-in, `issueLicense`, Stripe checkout/portal/webhook, daily reconcile | Firebase Functions, `us-central1` |
| `gateway/` | Pro gateway: `POST /v1/responses` (SSE) and `GET /v1/realtime` (WebSocket) proxied to OpenAI with metering | Cloud Run service `faangin-gateway` |
| `hosting/` | `/activate` (sign in, approve the Mac, buy a plan), `/billing/success`, `/billing/cancel` | Firebase Hosting |
| `client/` | `faangin-cloud.ts`, the drop-in for the Electron main process, with its tests and [README](client/README.md) | copied into the app repo |
| `firestore.rules` | denies every client read and write | Firestore |
| `scripts/` | `dev-secrets.mjs` (fake secrets for the emulator), `gen-license-key.mjs`, `deploy-gateway.sh`, `with-emulator-lock.sh`, `stripe-setup.mjs` (catalog, tax defaults, portal, webhook endpoint; idempotent), `stripe-sandbox-smoke.mjs` (production Checkout parameters against the real sandbox), `stripe-cli-e2e.sh` (Stripe-signed events into the emulated webhook), `check-secrets.sh` | local |
| `docs/` | [CONTRACT.md](docs/CONTRACT.md) (the spec), [DEPLOY.md](docs/DEPLOY.md) (runbook) | |

## Local development

Node 22 or newer. Install in the three folders:

```bash
npm install && npm --prefix functions install && npm --prefix gateway install
```

Run the emulators (Auth, Firestore, Functions, Hosting on `http://localhost:5000/activate`) with fake secrets, no real project:

```bash
node scripts/dev-secrets.mjs && npm run emulators
```

Run everything (functions unit + emulated tests, gateway tests, client tests):

```bash
npm test
```

Individually: `npm --prefix functions test`, `npm --prefix gateway test`, `npm run test:client`. Emulator-backed tests always go through `scripts/with-emulator-lock.sh` because the ports are fixed; `npm --prefix functions run test:emulated` already does.

## Stripe

The sandbox is configured through the API, never by hand: `node scripts/stripe-setup.mjs status|catalog|tax-defaults|portal|webhook --sandbox` reads the owner's sandbox key from the gitignored `.env.stripe-sandbox` (see `.env.stripe-sandbox.example`). `npm run stripe:smoke` sends the exact Checkout parameters production sends and cleans up after itself; `scripts/stripe-cli-e2e.sh` (needs the Stripe CLI) forwards real, Stripe-signed events into the emulated webhook. What the owner still does in the Dashboard (restricted keys, Stripe Tax head office and registrations, emails, terms URL, the webhook endpoint after the first deploy) is step 4 of [docs/DEPLOY.md](docs/DEPLOY.md).

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version: `npx firebase deploy --project faangin-staging --only firestore,hosting,functions` for Firebase, `bash scripts/deploy-gateway.sh faangin-staging` for the gateway. Only the owner logs in and sets secrets.
