_Last updated: 2026-10-27_

# Faangin Billing — Engineering Docs

This directory is the "how to turn billing on" layer for Faangin's paid plans. The code lives in `functions/` and `src/` (scaffolded by sibling agents); these docs tell a solo developer what to type, in what order, with which decisions already made.

## Who is this for

The **owner** (one person) runs every live-mode CLI command and types every secret. Agents can read these docs, run things locally against the Firebase emulator, and prepare drafts, but they never touch Stripe live mode, Firebase prod, or Google Cloud KMS. Steps are tagged `**OWNER:**` or `**AUTO:**` so this boundary is obvious.

## What Faangin sells

Three SKUs, decided and locked:

- **BYOK** — $10 one-time. User brings their own OpenAI key. Perpetual on the current major version, roughly 12 months of updates.
- **Pro Monthly** — $14.99/mo. Server-side gpt-transcribe gateway with printed allowances (20h transcription/mo at 5h/day, ≥1500 hands-free "requests", ≥500 Fast, ≥25 Smart) plus $16/mo and $8/UTC-day backstops. Device license tokens live 30 days with a 14-day grace window.
- **Pro Yearly** — $144/yr ($12/mo effective).

## Reading order

Read [architecture.md](./architecture.md) first — it's the mental model everything else assumes. Then pick the runbook you need:

- [stripe-setup.md](./stripe-setup.md) — one-time account, products, prices, webhook, Customer Portal.
- [firebase-setup.md](./firebase-setup.md) — projects, Auth, Firestore, Functions deploy, Secret Manager, KMS.
- [local-dev.md](./local-dev.md) — running the whole stack against emulators with zero live-service exposure.
- [security.md](./security.md) — key management, device cap, replay, chargeback, accepted risks.

Operational docs:

- [decisions.md](./decisions.md) — open and settled product/billing decisions, with what each one blocks.
- [launch-checklist.md](./launch-checklist.md) — the gate between "scaffolded" and "charging real cards".

## Conventions

- Dates are ISO (2026-10-27).
- Secrets go in `.secret.local` at the repo root (gitignored — see [security.md](./security.md); this is currently NOT in `.gitignore` and must be fixed before launch).
- Placeholders use obvious markers: `sk_test_REPLACE_ME`, `price_TBD_byok`, `whsec_REPLACE_ME`.
- All CLI commands assume macOS with Homebrew-installed `stripe`, `firebase`, and `gcloud`.

## What's intentionally out of scope here

The **Pro gpt-transcribe gateway** on Cloud Run is a separate deployable. Its hand-off surface (short-lived JWT from `/mintGatewayToken`) is sketched in [architecture.md](./architecture.md) but its own setup lives in its own repo. Mobile billing (StoreKit, Play Billing) is not part of launch; everything here is desktop web-checkout.
