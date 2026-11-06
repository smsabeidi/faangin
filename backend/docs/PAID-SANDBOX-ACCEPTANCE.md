# Paid sandbox fulfillment acceptance — BYOK + Pro monthly verified

Historical record of the Selmou AI sandbox. Production moved to the live SIDGROUP LLC account on November 6, 2026; see [Stripe setup](STRIPE-SETUP.md#production-account).

Updated November 3, 2026. **Core sandbox payment, Pro cancellation and signed BYOK fallback verified.** November 3 latest lifecycle checkpoint: the independent owned scheduled-state query passed (scheduled Pro cancellation=true, original BYOK retained, one seat, daily job OFF), and request 2 reconciliation remains HTTP 200/checked 1/failed 0. The reviewed sandbox finish helper then canceled the exact test subscription once with invoice_now=false/prorate=false; it exited 0, found no other held subscription, created no invoice and issued no refund. Independent owned Dashboard fallback checks now show effective BYOK active, the same Pro subscription canceled, original BYOK/Checkout binding retained, ZERO active Pro seats, and daily job OFF. The subscription is canceled/nonrenewing. The fresh fallback verifier exited 0 against the deployed API: signature/UID/device/active BYOK validity matched shipped Ed25519 keys and Pro-only license fields were cleared. The exact cancellation event is independently processed/applied. The original BYOK remains active, the sole test Pro subscription is canceled/nonrenewing, there are no held subscriptions or new invoices, active Pro seats are ZERO, and daily cron stays OFF. No real funds moved. The final runtime receipt is backend/.env.supabase-byok-fallback-runtime.local.json; its DB flag remains false because the independent earlier database receipt records that separate true proof. Current safe receipts: backend/.env.supabase-reconcile-paid.local.json (request 2 and exact scheduled-state database proof), backend/.env.supabase-pro-finish-sandbox.local.json (guarded cancellation), and backend/.env.supabase-byok-fallback-db.local.json (owned fallback database proof). No cancellation-event HTTP delivery observation is added by these receipts. The cancellation fix/shared-selector deployment is active. Exposed-key retirement, annual billing, full native/interview acceptance, signed distribution and live-billing readiness remain open.

Current credential cutover: the owner has now explicitly approved the batch to create faangin_server_20261103 with backend service-role DB/Auth Admin privileges, switch/verify consumers, and retire exposed default plus legacy API keys and the previous HS256 signer only. This resolves the earlier automatic-review rejection for missing explicit scope approval. Replacement creation is still unconfirmed after the click timeout. The concrete blocker is now identified: computer control reports the Mac locked and automatic unlock failed, explaining the Chrome/CDP timeouts. The owner has been asked to unlock the Mac; that action is pending and does not request new rotation permission. The selector remains unset, the prepared cutover helper has not executed, and no retirement is claimed. Current ECC issuance remains untouched.

This acceptance targets Supabase `uxgphdpcgcpgwbwfibkx` and **Selmou AI sandbox** `acct_1UVc6oRrWEBZT5Mj`. Checkout submissions used public sandbox test data only: no real card or real funds. See [Stripe testing](https://docs.stripe.com/testing) and [Sandboxes](https://docs.stripe.com/sandboxes).

| Hosted observation | Verified scope |
| --- | --- |
| Current Pro pricing | Deployed account API v10 created owned unpaid sandbox Checkout sessions for USD 49.99/month and USD 359.88/year. Stripe verified the exact line items and recurring intervals. Both sessions were expired unpaid. Webhook v9 accepts both generations of Pro prices. |
| BYOK USD 10 | Complete/paid Checkout, succeeded intent, captured/unrefunded charge, paid invoice, exact automatic HTTP 200/applied delivery, exact-owned database binding/event, and runtime active BYOK Ed25519 license against shipped keys |
| Original Pro monthly USD 14.99 | Complete/paid Checkout, captured charge/paid invoice, exact active subscription/period, original BYOK retained, automatic HTTP 200/applied completion at 21:44:32 UTC, exact-owned database application, and runtime active Pro license |
| Duplicate purchases | Completed-purchase BYOK and active-Pro attempts returned HTTP 400/FAILED_PRECONDITION with unchanged Checkout IDs and no extra session |
| Immediate cancellation / DB fallback | Exact test subscription canceled with no invoice/proration/refund; original BYOK active, same Pro canceled, zero seats, daily OFF; fresh signed fallback verified with Pro-only fields cleared |
| Scheduled cancellation | Deployed fix + one nonempty reconciliation (HTTP 200/checked 1/failed 0) + active signed Pro cancelAtPeriodEnd=true with unchanged period/ramp; exact-owned scheduled DB-row check passed before immediate cancellation |
| One Pro completion replay | Exact guarded resend Delivered at 21:51:54 UTC with HTTP 200/received=true/duplicate=true; owned entitlement version/hash, one seat, one device and original processed timestamp unchanged |

Safe ignored mode-0600 receipts retain each observation separately: `backend/.env.supabase-paid-runtime.local.json`, `backend/.env.supabase-db-paid-receipt.local.json`, `backend/.env.supabase-stripe-delivery.local.json`, `backend/.env.supabase-pro-paid-runtime.local.json`, `backend/.env.supabase-db-pro-paid-receipt.local.json`, `backend/.env.supabase-stripe-pro-delivery.local.json`, and `backend/.env.supabase-pro-replay-verified.local.json`. Runtime receipts preceded independent SQL/Workbench checks, so their earlier DB/HTTP false flags remain intact while later separate receipts record those proofs. No raw payload, secret URL, token or card data is required in these receipts.

Earlier unpaid Checkouts remain history. The latest BYOK and monthly Pro simulations completed; the private handoff contains a paid notice without a URL. The original billing harness phase remains checkout-ready because its management-backed status command was not run; that stale phase does not override the independent evidence or permit another renewal.

The historical cancel_at-only normalization bug is fixed in deployed code. Replaying its processed event was correctly a duplicate, so the repaired state was obtained through one guarded nonempty reconciliation instead. Deployment and scheduled signed-runtime receipts are backend/.env.supabase-cancellation-deploy.local.json and backend/.env.supabase-pro-scheduled-runtime.local.json. The prior local validation passed 50 actual Supabase and 42 historical fulfillment tests, both account-backend typechecks/all four Edge checks, plus independent focused 8+8 reviews. Exact-owned scheduled-row verification, immediate sandbox cancellation and database BYOK fallback have now passed; fresh signed fallback has passed and daily scheduling stays OFF.

Core immediate cancellation and signed BYOK fallback passed. Remaining gates include future subscription renewal/annual billing, payment failure/recovery and refund/revocation, other replay/delivery-order negatives, runtime three-device cap, exact 14-day ramp duration, desktop/native UI/restart, and a representative managed interview. The future ramp bound was checked, but exact duration/device-cap behavior is not certified. No new provider inference was run in the paid flow.

Two owned Auth fixtures remain for later cleanup. Public confirmation/recovery delivery and recovery-page password save are verified; the email device code expired without desktop exchange and its helper is stopped. The old management PAT is invalid; the approved deployment-scoped replacement is now active. Approved deployment access is now active: a new 24-hour token for only the Faangin project was created after fresh approval and saved only in ignored mode-0600 backend/.env.supabase.local. Its exact capabilities are Project Settings Read, Edge Functions Read/Write and Edge Function Secrets Read/Write; all others are None, including database, Auth, API keys, account-wide access and billing. No token value was printed. The earlier token remains invalid. This replacement restores the scoped deployment path, not Auth/database/API-key management or SQL cleanup privileges. The replacement token grants deployment/project-read access only; Dashboard SELECT proof does not add Auth/database management or cleanup privileges.

## What the existing tools prove

| Tool | Evidence and limit |
| --- | --- |
| `scripts/stripe-sandbox-smoke.mjs` | Creates/expires unpaid Checkout sessions and a portal session, then deletes its temporary customer. It checks parameters and key permissions, without paid fulfillment. |
| `scripts/supabase-smoke.mjs` | Exercises a tagged confirmed Auth fixture, device exchange, license signatures, and optional inference/audio. It seeds fixture entitlements directly and creates no Stripe payment, so it cannot certify payment-to-license behavior. |
| `scripts/supabase-billing-acceptance.mjs` | Harness for confirmed SQL Auth fixtures, app-created sandbox Checkout, guarded renewal, read-only paid status, optional confirmed license/device verification, and settled owned cleanup. Fourteen focused mocked tests passed, including the expected Customers SDK 403 and exact-customer read through the account-guarded test CLI. Actual prepare/renewals kept the same owned fixture/customer. The latest Checkout is now complete/paid in the sandbox. The harness management-backed status command was not used; separate Stripe, Dashboard SQL, and runtime signed-license receipts establish BYOK fulfillment. |
| `scripts/stripe-cli-e2e.sh` | Historical Firebase emulator workflow. It forwards CLI events to a local Firebase URL and uses a non-UUID fixture UID; it is not the deployed Supabase acceptance path. |
| Official `stripe trigger` / `stripe fixtures` | Execute API requests that create sandbox resources. The stock Checkout fixture creates its own product, price, and payment rather than the app's mapped customer/catalog. Use those for isolated webhook diagnostics, not as the paid app journey. |

The fixture distinction follows the [official CLI command reference](https://docs.stripe.com/cli/trigger) and [Stripe's Checkout fixture source](https://github.com/stripe/stripe-cli/blob/master/pkg/fixtures/triggers/checkout.session.completed.json). No trigger or fixture was executed while preparing this plan.

## 1. Clear the prerequisites

- Confirm `stripe whoami --format json` reports account `acct_1UVc6oRrWEBZT5Mj`, authorized and in `test` mode. Do not switch accounts or add `--live`.
- Both restricted keys are installed with [the reviewed permissions](STRIPE-SETUP.md). Preserve the ignored owner-only file and working checkout key; do not create duplicates.
- `faangin-api/health` now reports billing configured. Invalid signatures return 400; a directly signed unhandled fixture returned 200/ignored and then 200/duplicate, with one processed database row. This establishes signature/idempotency handling for that fixture, not delivery of a paid Stripe event.
- The intended sandbox endpoint `we_1UWkoIRrWEBZT5MjQJKUecL3` is enabled at `https://uxgphdpcgcpgwbwfibkx.supabase.co/functions/v1/stripe-webhook`, with its pinned API version and 14 events confirmed. Its signing secret belongs to that endpoint; a `stripe listen` secret is different and must not replace it.
- Keep daily reconciliation disabled until a successful Stripe-backed run is observed. Leave pg_net unchanged as instructed. A one-use reconciliation readiness dispatch completed with HTTP 200, request ID 1, checked 0, and failed 0. This empty run verifies dispatch/HTTP readiness only; it did not reconcile an actual Stripe account. The daily job stays inactive until paid acceptance and a successful nonempty Stripe-backed reconciliation.

Recheck these boundaries before the next sandbox flow. BYOK Stripe/automatic HTTP 200 delivery/database/runtime-license evidence has passed; replay/delayed-webhook negatives, Pro and other paid flows, and reconciliation remain separate checks.

### Prepared harness commands

Review `node backend/scripts/supabase-billing-acceptance.mjs --help` first. It is not part of the ordinary test command. Fourteen focused mocked tests passed. The retained BYOK run is `71d3ea17b3bf45dba7df101a3a4f58b5`. Earlier unpaid Checkouts expired and remain in history; the latest guarded renewal is now complete/paid. Do not renew this paid run or repeat BYOK purchase. State remains in ignored owner-only `backend/.env.supabase-billing-acceptance.local.json`.

`renew-checkout` does not use the expired management PAT. It refreshes the existing protected Auth fixture session, verifies its server-owned marker, verifies the exact expired/unpaid customer/Checkout history and absence of subscriptions/paid charges, then requests an unpaid replacement through the app. The restricted webhook key intentionally lacks Customers access; the exact customer read uses the already account-guarded test CLI. It does not broaden that key, create another Auth user, complete payment, or write a browser handoff. `prepare`, `status`, `status --verify-license`, and `cleanup` still require renewed approved management access; renewal alone does not restore it.

```sh
# Already completed once. Review existing private state; do not prepare a duplicate.
# For a future fresh run, creates a confirmed disposable Auth user and unpaid app Checkout.
# Requires a renewed scoped management PAT.
node backend/scripts/supabase-billing-acceptance.mjs prepare \
  --sql-auth-fixture --confirm-project uxgphdpcgcpgwbwfibkx --plan byok

# Historical retained-run command only. The current run is PAID; do not execute.
# Renewal is valid only for an expired/unpaid/unverified run, never this paid run.
# No payment, new user, or management PAT is used by renewal itself.
node backend/scripts/supabase-billing-acceptance.mjs renew-checkout \
  --confirm-project uxgphdpcgcpgwbwfibkx \
  --confirm-run 71d3ea17b3bf45dba7df101a3a4f58b5

# Requires renewed management access; reads provider/database state only.
node backend/scripts/supabase-billing-acceptance.mjs status

# Future explicit device/license check after an actual owned sandbox payment:
node backend/scripts/supabase-billing-acceptance.mjs status --verify-license \
  --confirm-project uxgphdpcgcpgwbwfibkx \
  --confirm-run 71d3ea17b3bf45dba7df101a3a4f58b5
```

Only an expired, unpaid, unverified retained fixture may renew. Open/completed/paid sessions, existing subscriptions, foreign ownership, or uncertain provider state are refused. An ambiguous request or timeout fails closed with private pending state retained: **stop and do not retry** until management-backed review identifies the outcome. The latest BYOK Checkout completed after one simulated submission; its handoff now shows paid with no URL. No additional renewal or payment is authorized by this runbook command example.

For future owned unpaid Checkouts, open any handoff privately; the harness withholds its URL and all credentials from output. `--verify-license` registers/touches the disposable device, so it requires the matching project/run confirmations. It does not attempt a second Checkout to test duplicate prevention. Receipt flags leave HTTP delivery, email, desktop UI/restart, and duplicate-purchase checks unverified until separately observed. Cleanup requires matching project/run confirmations, expires only the recorded owned open Checkout, refuses remaining open sessions, live subscriptions, unrefunded paid charges, or active entitlements, and deletes only the marked SQL fixture under the account lock. Stripe customer and audit records are retained; cancellation/refund/customer deletion are manual owned-resource actions. The script never pays, refunds, cancels subscriptions, or deletes a Stripe customer.

## 2. Establish an owned disposable account

Use one clearly tagged acceptance account and device, recording their IDs privately. Prefer the normal signup, email confirmation, and desktop device approval flow once Resend/SMTP is verified. If a confirmed Auth fixture is used before mail is ready, record email delivery as skipped and keep that separate from public-signup acceptance.

Before purchase, the app must show no plan and refuse paid inference. Create Checkout through the app's account panel; this establishes the trusted Auth user ↔ Stripe customer mapping. Do not substitute the standalone smoke's deleted customer, a CLI trigger's new customer, or manually edited entitlement data.

Keep an acceptance receipt containing only run ID, user/device/customer/session/event IDs, plan, HTTP delivery status, database outcome, and pass/fail. Withhold account tokens, full licenses, Checkout/portal session URLs, mail links, key values, and payment details from logs/screenshots.

## 3. Complete and verify BYOK

The owner completes the app-created **sandbox** Checkout using [Stripe's official test card](https://docs.stripe.com/testing#testing-interactively), never a real card. An example is Visa `4242 4242 4242 4242` with a future expiry and any three-digit test CVC. The latest owned BYOK simulation was submitted once and the Stripe/database/runtime-license evidence above passed. No real payment occurred.

Current evidence and remaining observations:

1. Passed: the actual Checkout is complete/paid, test mode, USD 10, and bound to the owned customer/user/plan; the succeeded intent, captured unrefunded charge, paid invoice, and exact completion event were independently read.
2. Passed: Stripe Workbench directly showed the exact completion event’s automatic delivery to the intended endpoint as Delivered at 17:49:12 UTC, HTTP 200, received=true/outcome=applied. Its protected receipt records this independently from the database/license observations.
3. Passed: exact Dashboard SELECTs confirmed the owned payment binding and processed/applied completion event. No SQL entitlement seed was used to make this paid flow pass.
4. Runtime endpoint proof passed: refreshed fixture Auth obtained an active BYOK license, with signature/user/device/time validation against the shipped keys. Desktop refresh/UI and restart persistence remain pending.
5. Passed for the completed purchase: another BYOK call returned HTTP 400/FAILED_PRECONDITION and the owned Checkout IDs stayed unchanged, with no extra payable session. The delayed-webhook race remains locally test-covered rather than an observed hosted paid scenario.

Stripe recommends webhook-based, repeat-safe fulfillment; see [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page).

## 4. Verify delivery replay and Pro upgrade

For the actual successful event only, save the entitlement version and seat count, then use the installed CLI's supported replay command after checking its help:

```sh
stripe events resend --help
# Future acceptance action; replace evt_ACTUAL_ID with the owned sandbox event only:
stripe events resend evt_ACTUAL_ID --webhook-endpoint we_1UWkoIRrWEBZT5MjQJKUecL3
```

The latest exact Pro event has this observed 2xx receipt and unchanged before/after state. For another approved event, observe the actual delivery result, not merely the CLI acknowledgment. The event remains processed once; replay must not change the entitlement version, restore a revoked purchase, or increment active seats again. The exact paid Pro completion event was subsequently resent once: Workbench directly confirmed manual delivery HTTP 200/duplicate=true, and exact-owned before/after SQL snapshots were unchanged. The BYOK event and refund/revocation replay negatives have not been replay-tested by this observation.

On the same BYOK account, Pro monthly Checkout now completed with an active exact subscription, observed period, retained BYOK ownership, actual automatic HTTP 200/applied event delivery, and signed Pro license. Repeat purchase was blocked without an extra Checkout. Active-seat count verification and a small managed answer with usage/lease cleanup remain separate; no new inference was performed. Any future provider call is separately billable even though Stripe payments are simulated. The future ramp bound was checked; exact 14-day duration and runtime three-device cap remain uncertified.

Use a separate disposable account for the annual plan so active-subscription protection is respected. Verify the annual price and period, and the gateway's monthly-anniversary allowance calculation. Do not advance shared clocks or alter another account's subscription to force a boundary.

## 5. Hardened ordering and ownership negatives

The hardened account/webhook functions are deployed. Local account verification passed 99 tests with real disposable Postgres, including 44 reducer and 31 payment-binding cases inside that total; Edge verification passed seven. The concurrent early-refund SQL case passed. These checks use provider fixtures and controlled database races, not actual paid signed Stripe fulfillment. Execute the hosted cases only with owned disposable sandbox resources and a controlled delivery harness; do not disable another workflow's webhook or edit the shared catalog to force a scenario.

| Scenario | Required result |
| --- | --- |
| Full refund or dispute reaches the entitlement before delayed BYOK purchase confirmation, including a concurrent commit | The purchase remains revoked. A persisted payment revocation survives compare-and-swap retry; a fresh event ID or later completion cannot restore access. |
| A completed BYOK payment was already fully refunded/disputed before confirmation runs | Successful charge lookup reports that state and the customer matches the purchase. No active BYOK license is granted. Partial refund remains owned. |
| Refund/dispute/fraud for an old subscription invoice arrives after a newer Pro subscription is active | Invoice-payment lookup binds the old subscription. The newer Pro subscription, seat count, and license remain intact; later updates for the old revoked subscription cannot replace it. |
| New subscription uses a foreign or missing Pro lookup key | It grants no Pro seat/license and cannot displace a legitimate newer Pro subscription. Both the original and v2 monthly and annual Faangin Pro lookup keys grant Pro. |
| An already-recorded Pro subscription changes to an unsupported lookup key | Its Pro access ends, with owned BYOK fallback when applicable. Do not mistake an existing subscription ID for an approved product. |
| Successful charge belongs to another customer, or authoritative charge/invoice reads fail | Ownership mismatch is rejected; incomplete provider reads remain retryable failures. No entitlement is granted from incomplete or foreign payment state. |

The foreign-price cases test lookup keys only. They do not establish reducer enforcement of amount, currency, or cadence; invoice/catalog values are observed separately in the paid Checkout receipt.

## 6. Recovery, cancellation, and cleanup

The actual scheduled-cancellation portal exercise found the hosted flexible-billing cancellation flag bug above. Do not treat its applied event as correct scheduled-cancellation UI/state acceptance. The fix is deployed and nonempty reconciliation plus signed scheduled-cancellation verification passed. The separate exact-owned scheduled query passed; immediate sandbox cancellation and owned database BYOK fallback also passed. Fresh signed BYOK fallback has now passed; the core sandbox upgrade/cancellation/fallback flow is verified, while broader gates below remain open. An already-processed event replay remains a duplicate, rather than a repair mechanism.

Test payment failure/recovery, cancellation, and full refund using only the owned sandbox resources, with each expected state recorded before proceeding. A scheduled end-of-period cancellation keeps Pro until its effective end; it should not be mistaken for immediate BYOK fallback. Once Pro actually ends, the same user's owned BYOK plan must become effective. A full BYOK refund must revoke that purchase; replay of its original completion event must not restore it.

After evidence is captured, cancel owned test subscriptions, expire any owned open Checkout sessions, and allow cancellation/refund webhooks to settle before deleting fixture mappings or Auth rows. Verify no fixture subscription remains billable and the active-seat count returns to its prior value. Cleanup must use the recorded fixture IDs, not a broad account-wide deletion. Revoke local fixture sessions and remove private temporary artifacts.

Finally run the protected reconciliation route once with the correct internal dispatch, verify its Stripe-backed result, and only then consider enabling its daily job. Actual confirmation/recovery delivery has passed; recovery-page UI confirms password saved, and device/native acceptance remains open after code expiry without session exchange. Billing acceptance does not establish real microphone/system-audio quality, sustained production load, or signed release readiness.
