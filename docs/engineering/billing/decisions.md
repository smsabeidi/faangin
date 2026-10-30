_Last updated: 2026-10-27_

# Billing Decisions Tracker

Live list of product and billing decisions. Each row has a status, the owner's answer when decided, the date it was decided, what the decision impacts, and the one-sentence "what this blocks" column that explains why it matters now.

Status values: **OPEN** (needs an answer), **DECIDED** (locked in on the date shown), **BLOCKED-ON** (waiting on an upstream decision — the cell names it).

## Open and decided decisions

| Decision | Status | Owner answer | Date | Impact | What this blocks |
|---|---|---|---|---|---|
| Legal entity + country | OPEN | — | — | Shapes Stripe business profile, Apple Developer enrollment, which jurisdictions can purchase, sales-tax exposure. | Blocks both Stripe account activation and Apple Developer enrollment — nothing goes live without this. |
| Merchant of record (Stripe Managed vs plain Stripe) | OPEN | — | — | Determines per-transaction fees, who holds sales-tax/VAT liability, what the chargeback dispute surface looks like. | Blocks the Stripe account activation path and the "do we need Stripe Tax" sub-decision; also sets expectations for international pricing. |
| BYOK license-with-yearly behavior (does Pro Yearly include a BYOK unlock?) | OPEN | — | — | Changes the Pro Yearly value prop and the `byokUnlock` field semantics (whether it's set on Pro Yearly purchase too). | Blocks final pricing-page copy, the webhook handler for `pro_yearly` checkouts, and the "what happens after Pro cancellation" story. |
| $10 upgrade credit from BYOK → Pro at any time? | OPEN | — | — | Adds a one-time proration path at Checkout: if `entitlements.byokUnlock = true`, the first month/year of Pro gets a $10 discount via a Stripe coupon. | Blocks pricing copy, Checkout session creation code, and support policy ("I just bought BYOK yesterday, can I upgrade?"). |
| Refund window | OPEN | — | — | Determines our refund policy page and what the Customer Portal's cancellation flow offers. Readiness page proposes no Pro trial, card required, narrow (e.g. 7-day) refund window. | Blocks the refund policy page going live, which is a launch-checklist item; also shapes chargeback exposure. |
| Plan name (proposed: "Pro · everything included") | OPEN | — | — | Marketing + Stripe product name. Changing it later means renaming the Stripe product (safe but visible to users on invoices). | Blocks pricing page copy and Stripe product creation naming. |
| BYOK update window length (readiness page: ~12 months) | OPEN | — | — | Determines how long BYOK users receive updates on the current major and when the "upgrade for continued updates" nudge appears in-app. | Blocks the BYOK terms copy on the pricing page, which legal/billing must agree on before launch. |
| Posture A (practice/meeting assistant positioning) | DECIDED | Posture A | 2026-10-26 | Locks the product framing (practice + meeting assistant, not generic AI chat). Everything in architecture + pricing follows from this. | Resolved — unblocks pricing-page copy, website launch, Apple review submission. |
| Pro Option 1 pricing ($14.99 / $144, gpt-transcribe, printed allowances) | DECIDED | Option 1 | 2026-10-27 | Locks the Pro SKU shape: $14.99/mo, $144/yr, server-side gpt-transcribe gateway, 20h/mo transcription, 5h/day, ≥1500 requests, ≥500 Fast, ≥25 Smart; $16/mo and $8/UTC-day backstops. | Resolved — unblocks Stripe product/price creation, gateway allowance accounting, pricing page copy. |
| Both BYOK and Pro at launch (not phased) | DECIDED | Both at launch | 2026-10-27 | Both SKUs ship on day one; the pricing page shows both; the Checkout flow handles both; both webhooks are wired. | Resolved — unblocks the launch checklist as a single-SKU launch (no phased rollout). |

## Open decisions in triage order

The order below is the suggested order to resolve, since several decisions depend on earlier ones:

1. **Legal entity + country** — until this is set, Stripe can't activate and Apple can't enroll. If the owner is in the US and already an individual taxpayer, "individual / sole proprietor / US" is the fast path; LLC can follow later.
2. **Merchant of record** — depends on 1. Managed Payments availability varies by country.
3. **Refund window** — needs 1 (consumer protection law varies by jurisdiction) and shapes the Customer Portal config.
4. **Plan name** — low-stakes but needed before Stripe products are created and before the pricing page ships.
5. **BYOK license-with-yearly behavior** — needs 4 (we need to know what "Pro" offers before deciding whether it bundles BYOK).
6. **$10 upgrade credit from BYOK → Pro** — needs 5 and shapes Checkout code.
7. **BYOK update window length** — needs 5 (if Pro Yearly includes BYOK unlock, the BYOK update window matters less for Pro-converted users).

## How to update this file

When an item moves from OPEN to DECIDED: change the Status cell, fill in Owner answer, set the Date to today (ISO), and update the matching sections of [stripe-setup.md](./stripe-setup.md), [launch-checklist.md](./launch-checklist.md), and any pricing-page copy. If a decision changes after it was DECIDED, append a new row with "**v2**" in the Decision column rather than editing the old row — the audit trail matters.

Launch-checklist items with 🔒 reference this file; unlock them by resolving the referenced decision here.
