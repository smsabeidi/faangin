# Stripe billing setup

## Production account

Production billing runs on **SIDGROUP LLC**, `acct_1SvNnP8BbXRWcVQW`, in live mode. It moved from the sandbox on November 6, 2026, with no real subscribers to migrate. The same Stripe account also serves LeaveStream, so avoid account-wide changes: do not run `stripe-setup.mjs tax-defaults` there, and note that its leavestream.com webhook also receives Faangin checkout and subscription events.

| Object | Value |
| --- | --- |
| Monthly price | `faangin_pro_monthly_v2`, USD 49.99 |
| Annual price | `faangin_pro_annual_v2`, USD 359.88 |
| Customer portal | `bpc_1UYZSc8BbXRWcVQWPv9gco9O`, tagged `faangin=v1`; also the account default |
| Webhook | `we_1UYZSd8BbXRWcVQWfIXGAQi3`, 14 events, API version `2026-09-30.endive` |
| Checkout key | Restricted, `Faangin Supabase live checkout` |
| Webhook key | Restricted, `Faangin Supabase live webhook` |

The Edge runtime refuses `sk_` keys. It requires two different `rk_live_` keys plus `STRIPE_EXPECT_LIVEMODE=true`, otherwise billing reports unconfigured. Stripe has no API for creating restricted keys and asks for a two-factor code for each one, but a link in the form `https://dashboard.stripe.com/apikeys/create?name=<name>&permissions[]=rak_<permission>` pre-fills the page. The checkout key uses `checkout_session_write`, `customer_write`, `customer_portal_write`, `plan_read`, `product_read`, and `subscription_read`. The webhook key uses `checkout_session_read`, `subscription_read`, `invoice_read`, `charge_read`, and `dispute_read`.

The live values are in the ignored owner-only files `backend/.env.stripe-live-keys.local` and `backend/.env.stripe-live-webhook.local`. To upload them, put a scoped `SUPABASE_ACCESS_TOKEN` in the environment and pass only those two files:

```sh
node backend/scripts/upload-supabase-secrets.mjs --env-file backend/.env.stripe-live-keys.local --env-file backend/.env.stripe-live-webhook.local
```

Never add `backend/.env.supabase.local` to that command. It would also push its own `LICENSE_SIGNING_KEY`, `OPENAI_API_KEY`, and `STRIPE_EXPECT_LIVEMODE=false`.

Before the switch, an unpaid live Checkout and portal session passed with the restricted keys, using production's parameters. After it, production secret digests matched, a signed live event returned 200/ignored, and both the old sandbox secret and test-mode events returned 400. No real card payment is recorded here yet.

Stripe Tax is still pending on this account, with no head office or registrations, so `automaticTax` must stay false until that is finished or Stripe refuses Checkout. `termsConsent` needs a terms URL in the account's public details first.

Stored Stripe IDs belong to one account. An ID from another account fails with `No such customer`, the app shows only a generic retry, and `faangin_customer_bind` never overwrites a row. Before any future account move, close Checkout and repoint or clear `faangin.customers`. The one test account was repointed to a live customer, but its entitlement still holds its old sandbox `pro.subscriptionId`. Reconcile counts that as a failure on every run, so clear it before enabling the daily job.

To roll back, close Checkout first, because any Stripe test card grants Pro on sandbox keys. Then upload `backend/.env.stripe-runtime.local` and `backend/.env.stripe-webhook.supabase.local` with `STRIPE_EXPECT_LIVEMODE=false`. Customers created on the live account would then need the same repointing.

## Sandbox credentials and acceptance

The test account is **Selmou AI sandbox**, `acct_1UVc6oRrWEBZT5Mj`, in test mode. Its Faangin prices and tagged customer portal are configured. Both restricted sandbox keys and the webhook signing secret are saved in ignored owner-only files; they were the production Edge secrets until the November 6 switch. The checkout key's unpaid Checkout/portal smoke passed with cleanup. The webhook read key passed actual reads for Checkout, subscriptions, invoices, invoice payments, charges, refunds, and disputes; Customers correctly returned 403.

The intended webhook `we_1UWkoIRrWEBZT5MjQJKUecL3` is enabled with the exact Supabase URL, pinned API version, and 14 configured event types. Invalid signatures return 400. A signed disposable unhandled readiness event returned 200/ignored, replay returned 200/duplicate, and its database record was processed once; that exact fixture was cleaned. That early readiness probe was separate from the later BYOK paid-simulation evidence described below.

Both keys have already been created after fresh approval; do not create duplicates. For future rotation in [Stripe API keys](https://dashboard.stripe.com/test/apikeys), select **Selmou AI sandbox**, choose **Create restricted key**, and start with all permissions **None**:

| Permission | `Faangin Supabase sandbox checkout` | `Faangin Supabase sandbox webhook` |
| --- | --- | --- |
| Checkout Sessions | Write | Read |
| Customers | Write | None |
| Customer portal (sessions and configurations) | Write | None |
| Prices | Read | None |
| Products | Read | None |
| Subscriptions | Read | Read |
| Invoices | None | Read |
| Charges and Refunds | None | Read |
| Payment Disputes | None | Read |
| Every other permission | None | None |

The current Stripe UI groups Charges and Refunds into one permission and labels disputes Payment Disputes. Those groups plus Checkout Sessions, Invoices, and Subscriptions are the exact five read selections. Create only restricted **test** keys, beginning with `rk_test_`. The CLI's approved OAuth login is used for setup; it is not an Edge runtime key. No live key or live payment is needed for this step.

For a fresh checkout, prepare the ignored local destination from the repository root. Preserve any existing file:

```sh
cp -n backend/.env.stripe-runtime.example backend/.env.stripe-runtime.local
chmod 600 backend/.env.stripe-runtime.local
```

The current file already contains both `STRIPE_CHECKOUT_KEY` and `STRIPE_WEBHOOK_KEY`; preserve them. Future replacements retain those environment names, one value per line. Do not paste keys into chat, public build JSON, screenshots, or a tracked file. The template contains placeholders only.

After any replacement, verify key types/permissions and use the allowlist uploader for the selected Supabase project's Edge secrets. The current upload and endpoint activation are complete. Catalog/portal and unpaid smoke passed. The later actual app-created BYOK sandbox simulation now has independent Stripe completion, exact processed/applied database binding, and runtime signed-license proof. No real card/funds were used. Automatic delivery of the exact BYOK completion event was directly observed as Delivered/HTTP 200/applied in Stripe Workbench; post-purchase BYOK duplicate rejection passed without a new Checkout; one exact hosted Pro completion replay also passed unchanged-state checks; other replay/delivery-order negatives, Pro lifecycle, and desktop UI/restart remain open; daily reconciliation stays off.

## Account setup through the approved CLI

The current setup scripts can reuse the approved OAuth session without extracting its stored tokens:

```sh
cd backend
node scripts/stripe-setup.mjs status --cli --expected-account acct_1UVc6oRrWEBZT5Mj
node --experimental-strip-types scripts/stripe-sandbox-smoke.mjs --cli --expected-account acct_1UVc6oRrWEBZT5Mj
```

The CLI path rejects a different account and live mode. Smoke creates unpaid sessions and a temporary customer, then expires/deletes them; temporary Checkout and portal URLs are withheld from output. This CLI OAuth invocation verifies the catalog and parameters; it does not verify restricted-key permissions or completed payment. The separate restricted-key checks described above have passed. Follow [the paid-sandbox acceptance plan](PAID-SANDBOX-ACCEPTANCE.md) for the remaining payment journey.

## Confirmation and recovery email

Signup also needs a transactional SMTP provider and an approved sender. The team owns faangin.com and its Hostinger DNS editor is accessible. The selected sender is Faangin <noreply@auth.faangin.com> on a dedicated auth.faangin.com subdomain. Public DNS confirms its DKIM TXT record (value omitted) and Resend rsend.auth/send.auth CNAMEs; SPF/MX resolve through CNAME, while _dmarc.auth is absent. Resend shows auth.faangin.com as Verified; DKIM and both Forge CNAME sending checks passed, with sending enabled and receiving disabled. After fresh approval, a Faangin Auth Sending-access key restricted to auth.faangin.com was stored only in ignored owner-only backend/.env.smtp.local and connected to Supabase Auth SMTP. Save was accepted; reload showed custom SMTP enabled, smtp.resend.com, port 465, Faangin, noreply@auth.faangin.com, and no unsaved changes. The unused duplicate key from the browser timeout/state race was deleted after fresh user approval; Resend confirmed deletion and only the captured/current Faangin Auth key remains. A certificate-verified TLS SMTP probe authenticated with status 235 while sending zero messages. After separate test approval, actual signup confirmation and password-recovery mail reached the connected founders@selmou.com INBOX at November 2 16:25:02 UTC (UID 51) and 16:28:44 UTC (UID 52). Both links matched the exact Supabase verification host, expected kind, and real callback lease. Signup confirmation signed in and cleared the fragment; recovery opened the new-password form and cleared the fragment. Independent browser observation now confirms the recovery page reports the password saved and instructs returning to Faangin for a new sign-in code. The current sign-in/device code is expired and no desktop session was exchanged. Use Different Account cleared the browser recovery session and returned to the email field; the activation tab was then closed. The standalone helper was stopped with exit 0 after its last poll reported expired. Obsolete password/activation URL/device code/user code fields were scrubbed from the protected email fixture, which now records password-reset-verified-device-expired and retains the exact owned-cleanup identity fields. No desktop session was exchanged. Source callback integration was exercised; ScreenCaptureKit failure prevented full native UI capture. The email fixture remains protected for later owned cleanup when management access is renewed. No tracking subdomain is configured; the unsaved creation form was left without submitting. Follow [the current SMTP handoff](SMTP-SETUP.md). Supply the chosen provider's SMTP host/port, username and password or SMTP API credential, and the approved sender address/display name securely in the project's Auth SMTP settings. Verify any provider-required sending-domain DNS records. SMTP credentials belong in the provider/Supabase settings, not this Stripe env file or chat.

Actual fresh signup confirmation and recovery mail have now been delivered through the configured SMTP path. Recovery-page UI independently confirms password saved. Complete a fresh device-session acceptance; the separate Stripe SQL fixture still bypasses mail and does not establish paid fulfillment.

Current lifecycle checkpoint: the fix is deployed and a guarded nonempty reconciliation plus scheduled signed-Pro cancellation verification passed. The separate owned scheduled database check passed, then the exact sandbox subscription was canceled without proration/new invoice/refund. Owned database state is BYOK active with Pro canceled and zero seats; fresh signed BYOK fallback has passed with Pro-only license fields cleared. Daily cron is OFF.
