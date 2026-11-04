# Deploy Faangin on Supabase

Run from the repository root unless a command specifies otherwise. The selected project is `uxgphdpcgcpgwbwfibkx`, with public API origin `https://uxgphdpcgcpgwbwfibkx.supabase.co`. The schema and four Edge Functions are deployed; see the current acceptance status in [launch configuration](../../docs/engineering/launch-configuration.md). Firebase deployment and Google billing quota work are superseded.

Critical pending gate: complete the [exposed Supabase key cutover](SUPABASE-KEY-ROTATION.md) before launch. Passing billing does not establish that the initially exposed server credentials have been retired. This review made no rotation changes.

## 1. Establish access to the intended project

Use the Supabase account that owns the target project. Project publishable/secret keys authorize project APIs; they do not authorize management API deployment, migrations, Auth settings, or Edge secret setup. The previously connected CLI/connector account cannot access this project, even though the browser is signed into the correct account.

Reconnect the connector to the owning account, or use a short-lived project-scoped management token. The earlier token is invalid. A freshly approved 24-hour project token now provides Project Settings Read plus Edge Functions/Secrets Read-Write and has successfully deployed the updated account, webhook and gateway. It grants no database, Auth, API-key, account-wide or billing access; those management operations and SQL fixture cleanup are not authorized by this token. Limit scopes to the database/migrations, Auth configuration, Edge Functions/secrets, and read-only settings/logs/advisors needed for this deployment. Store tokens only in an ignored owner-readable local file or credential store. Do not paste private keys into documentation, chat, public build configuration, or command arguments. Rotate private project keys previously shared in chat.

The commands and allowlist uploader below target Supabase CLI v2. Pin the approved CLI version when running this procedure. CLI v3 changed hosted target selection and confirmation for automation. Review those changes before using v3 with this runbook. [Supabase CLI v3 release notes](https://supabase.com/changelog/supabase-cli-v3)

Discover commands against the installed CLI before use:

```sh
supabase --help
supabase db --help
supabase functions deploy --help
supabase secrets set --help
```

Before changing the database, inspect existing tables, migrations, Edge Functions, logs, and security/performance advisors in this exact project. Confirm whether existing users/payments need data migration. Do not assume an empty database or overwrite existing data. Firebase users cannot simply reuse their old tokens in Supabase; account migration requires its own verified mapping if real users exist.

## 2. Verify and deploy the schema

Install and verify as described in [the backend README](../README.md). Account/billing schema source is `backend/supabase/schema-billing.sql`; gateway schema source is `backend/gateway/schema-supabase.sql`. The reviewed combined migration belongs in `supabase/migrations/` and must apply the account schema before gateway functions that reference it.

Create migration files with `supabase migration new`, rather than inventing a timestamped filename. Iterate with SQL query tools against a disposable local database; use one reviewed migration for the final remote change. Inspect the pending SQL before applying it to the selected target. Never use `db reset` against this project.

After applying the migration, verify:

- Every `faangin` table has RLS enabled and no browser-role grants.
- `anon` and `authenticated` cannot execute any `public.faangin_*` RPC or read private tables.
- Service-role account, device, checkout, event, entitlement, and usage operations succeed.
- Answer/audio admission and entitlement version updates serialize across parallel callers.
- Security/performance advisors have been reviewed and actionable application findings resolved.

The migration initializes global flags and the Pro active-seat count. Keep new customer access closed until credentials and deployed acceptance pass. A privileged SQL update can change operational flags, for example:

```sql
update faangin.flags
set document = jsonb_set(document, '{checkoutOpen}', 'false'::jsonb)
where key = 'global';
```

Other controls are `proSessionsOpen`, `smartToFast`, `handsfreeOff`, `transcriptionOff`, `blockedUids`, `proSeatCap`, `automaticTax`, and `termsConsent`. Change only the required fields; preserve the others.

## 3. Configure Auth and mail

Enable email/password signup and require confirmed email. The team owns faangin.com and has verified access to its Hostinger DNS editor (cosmos.dns-parking.com and nova.dns-parking.com). The selected sender is Faangin <noreply@auth.faangin.com>; public DNS now has the DKIM TXT record and rsend.auth/send.auth Resend CNAMEs, with SPF/MX resolving through CNAME. _dmarc.auth is absent. Resend now shows auth.faangin.com as Verified, with DKIM and both Forge CNAME sending checks passed; sending is enabled and receiving disabled. After fresh approval, the Faangin Auth domain-restricted Sending key was saved to ignored mode-0600 backend/.env.smtp.local and connected to Supabase. SMTP save was accepted and verified after reload with custom SMTP enabled and no dirty changes. The unused duplicate key was deleted after fresh approval; only the current Faangin Auth key remains. Certificate-verified SMTP authentication returned 235 without sending a message. Approved actual signup confirmation and recovery mail then reached the connected Hostinger inbox. Confirmation signed in; recovery opened its password form. Independent browser observation now confirms the recovery page reports the password saved and instructs returning to Faangin for a new sign-in code. The current sign-in/device code is expired and no desktop session was exchanged. Use Different Account cleared the browser recovery session and returned to the email field; the activation tab was then closed. The standalone helper was stopped with exit 0 after its last poll reported expired. Obsolete password/activation URL/device code/user code fields were scrubbed from the protected email fixture, which now records password-reset-verified-device-expired and retains the exact owned-cleanup identity fields. No desktop session was exchanged. Full native UI acceptance remains pending. [SMTP-SETUP.md](SMTP-SETUP.md) records the exact settings. Earlier Auth config readback returned 200 with confirmation required, SMTP unset, and the approved callback URLs unchanged; the later dashboard SMTP save/reload verification supersedes the SMTP-unset observation. Preserve the verified SMTP sender and complete recovery/device acceptance. Set Site URL to `https://uxgphdpcgcpgwbwfibkx.supabase.co/functions/v1/billing-return/activate` and add `http://127.0.0.1:*/activate?**` to Auth's redirect allowlist. The callback listener remains open for one hour while the device approval code expires after ten minutes. Keep the desktop open while approving a code or following a confirmation/recovery link. Enable Google only after its provider credentials and redirects are configured and verified.

Verify a fresh account can sign up, confirm email, sign in, recover a password, approve the displayed device code, and create an independent desktop session. Test wrong/expired/reused codes, cancellation, session revocation, and sign-out. Auth settings existing in the dashboard do not establish successful email delivery.

## 4. Configure Edge secrets and public release metadata

Supabase supplies project URL and server keys to deployed Edge Functions. The implementation accepts the default `SUPABASE_SECRET_KEYS` / `SUPABASE_PUBLISHABLE_KEYS` maps with compatibility fallbacks. Keep the private server key inside Edge. Do not put a service-role key in desktop configuration.

An ignored owner-only `backend/.env.supabase.local` currently contains the newly generated signing key and reconciliation credential. Add the remaining environment secrets securely to that file, or prepare a separate ignored `supabase/.env.edge.local` with mode `0600`. Set actual values securely without logging them:

| Name | Purpose |
| --- | --- |
| `STRIPE_CHECKOUT_KEY` | Restricted key: Checkout Sessions, Customers, Customer portal write; Prices, Products, Subscriptions read |
| `STRIPE_WEBHOOK_KEY` | Separate restricted key: Checkout Sessions, Subscriptions, Invoices, Charges, Refunds, Disputes read |
| `STRIPE_WEBHOOK_SECRET` | Signature secret for this project's deployed `stripe-webhook` URL |
| `STRIPE_EXPECT_LIVEMODE` | `false` for sandbox; explicitly `true` only for a live environment |
| `LICENSE_SIGNING_KEY` | Base64 PKCS#8 Ed25519 private key; never the public verification key |
| `OPENAI_API_KEY` | Provider project/service-account key used only by the managed gateway |
| `RECONCILE_SECRET` | High-entropy credential for the internal daily reconciliation caller |

The optional `FAANGIN_HOSTING_ORIGIN` changes billing return URLs. Its default is this project's `/functions/v1/billing-return` base, so no Firebase Hosting domain is required. Return pages use plain text because the shared Supabase Edge domain does not serve arbitrary HTML pages as a trusted app origin.

The new target environment already has a locally generated key pair. For a separate environment with no signing key, generate one with `backend/scripts/gen-license-key.mjs`, redirecting its private stdout into a protected ignored file. Its stderr prints only the matching public key. Set the private value through Edge secrets and put the public SPKI value in the desktop's `licensePublicKeys` array. Keep an existing signing key when retrieving its public half; do not rotate it unnecessarily. During planned rotation, retain old public verification keys for at least the longest outstanding license plus grace window (44 days).

Use the allowlist uploader; the local file also contains the management token, which must stay out of Edge secrets:

```sh
node backend/scripts/upload-supabase-secrets.mjs --env-file backend/.env.supabase.local
```

The desktop release JSON contains only `supabaseUrl`, `publishableKey`, `gatewayBase`, and `licensePublicKeys`. The gateway base is the same project's `/functions/v1/faangin-gateway`. See [launch configuration](../../docs/engineering/launch-configuration.md). A valid public config does not verify deployed services or secret availability.

## 5. Deploy all four Edge Functions

Build the generated gateway bundle before deployment:

```sh
npm --prefix backend/gateway run build
supabase functions deploy faangin-api --project-ref uxgphdpcgcpgwbwfibkx --no-verify-jwt
supabase functions deploy stripe-webhook --project-ref uxgphdpcgcpgwbwfibkx --no-verify-jwt
supabase functions deploy billing-return --project-ref uxgphdpcgcpgwbwfibkx --no-verify-jwt
supabase functions deploy faangin-gateway --project-ref uxgphdpcgcpgwbwfibkx --no-verify-jwt
```

These functions enforce their own Auth, Stripe signature, or reconciliation-secret checks. Platform JWT verification must remain disabled for the public device/Stripe routes and modern publishable-key flow. Verify the deployed function configuration matches `supabase/config.toml`.

Check `/functions/v1/faangin-api/health`, billing return messages, and gateway `/functions/v1/faangin-gateway/healthz`. Health responses are configuration probes; follow them with authenticated requests and negative authorization tests. Confirm no private keys or tokens appear in logs. Set budget/error alerts and review Edge duration, memory, CPU, and connection limits. Gateway transcription rotates connections before Edge lifetime expiry; test a long interview across multiple rotations before admitting customers.

## 6. Connect the Stripe environment

Both restricted runtime keys and the signing secret are saved/uploaded. The checkout key passed its unpaid Checkout/portal smoke; the webhook key passed its required resource reads, and Customers correctly returned 403. Account health reports billing configured. The intended Selmou AI sandbox endpoint is enabled with its exact URL/API version/14 events. Invalid signatures were rejected, and a directly signed unhandled readiness fixture was processed once with replay deduplicated. A later app-created BYOK sandbox simulation passed independent Stripe completed-payment, exact Dashboard SQL processed/applied binding, and runtime signed-license verification, with no real funds. The exact BYOK completion event’s automatic delivery was directly observed as HTTP 200/applied in Stripe Workbench. Post-purchase BYOK duplicate rejection passed without a new Checkout. The renewed Pro monthly sandbox Subscribe now has independent paid provider state, automatic HTTP 200/applied delivery, exact active subscription/retained BYOK database state, signed Pro license, and blocked repeat-purchase proof; one exact hosted Pro completion replay also passed unchanged-state checks; other replay/delivery-order negatives, Pro lifecycle, and desktop UI/restart remain open. See [the exact permissions and secure local-file convention](STRIPE-SETUP.md).

From `backend/`, `node scripts/stripe-setup.mjs status --sandbox` identifies the sandbox account and catalog. `catalog`, `tax-defaults`, and `portal` are idempotent setup commands. The expected lookup keys and portal tag are in [CONTRACT.md](CONTRACT.md). Use separate live and sandbox keys and reject mode mismatches.

The webhook URL is:

```text
https://uxgphdpcgcpgwbwfibkx.supabase.co/functions/v1/stripe-webhook
```

Create/update it with the setup script and always pass `--secret-out` to a protected ignored file. Upload the one-time signing secret through Edge secrets, then delete the temporary file. Subscribe only to the event list in `stripe-setup.mjs`, with the installed SDK's pinned API version. Confirm Stripe Workbench shows successful signed deliveries. A browser return or successful Checkout URL alone grants no entitlement.

The restricted-checkout-key no-payment smoke has passed. To repeat it when a changed key or configuration requires verification, run `npm run stripe:smoke` using that restricted sandbox checkout key. It uses the current Supabase service's exact Checkout parameters. It verifies customer, price, Checkout create/list/expire, and portal permissions without completing payment. Complete actual paid sandbox Checkouts through the desktop to verify signed delivery and fulfillment, subscription reads, and license refresh; use the [concrete paid acceptance plan](PAID-SANDBOX-ACCEPTANCE.md). BYOK sandbox Stripe/database/runtime-license proof has now passed, and its exact automatic webhook delivery was observed HTTP 200/applied. Post-purchase BYOK duplicate rejection passed. The renewed Pro monthly sandbox Subscribe now has independent paid provider state, automatic HTTP 200/applied delivery, exact active subscription/retained BYOK database state, signed Pro license, and blocked repeat-purchase proof; Pro lifecycle, one exact hosted Pro completion replay passed unchanged-state checks; other replay/delivery-order negatives, and desktop UI/restart acceptance remain open.

Before live sales, configure real business/statement details, invoice branding, legal URLs, payment emails, failed-payment cancellation, and dispute handling. Enable Tax/terms flags only after the matching account settings are ready. Confirm relevant tax registrations and operational/payment requirements with the business owner. Revoking entitlement after a refund/dispute does not cancel Stripe billing; support must ensure future charges stop when required.

## 7. Schedule reconciliation and run acceptance

A Vault-backed daily job is installed for 03:15 UTC and remains disabled pending successful Stripe-backed reconciliation acceptance. A one-use reconciliation readiness dispatch completed with HTTP 200, request ID 1, checked 0, and failed 0. This empty run verifies dispatch/HTTP readiness only; it did not reconcile an actual Stripe account. The daily job stays inactive until paid acceptance and a successful nonempty Stripe-backed reconciliation. Its scheduled POST uses a 60-second HMAC plus a private single-use dispatch nonce; pg_net receives no shared credential. The manual secret header is reserved for deliberate server-side operations and is never queued by cron. Inspect the reviewed job with `node backend/scripts/setup-supabase-reconcile.mjs status --env-file backend/.env.supabase.local`; status is read-only. After billing prerequisites pass, run and observe one reconciliation before enabling the daily job and its failure alert. A successful cron queue operation alone is not a successful HTTP reconciliation. Leave the installed pg_net extension unchanged.

Before public distribution, record results for:

1. Fresh signup, mail confirmation, password recovery, device approval, separate-session refresh, and sign-out/revocation.
2. BYOK and Pro sandbox Checkout, signed webhook fulfillment, correct invoices/licenses, portal return, cancellation, payment failure/recovery, duplicate prevention, refund replay, and device cap.
3. Managed Fast/Smart answers, selected-image Solve, microphone and computer audio, automatic help, reconnects across several Edge lifetimes, stop/cancel, notes/export, and saved-session reopen. Pro must work without a personal provider key.
4. Cross-worker admission/usage, daily/monthly/ramp boundaries, Stripe retry/reconciliation behavior, provider quota, sustained latency and memory under admitted load.
5. Live Stripe configuration and a controlled live purchase/refund, followed by signed/notarized installer verification and fresh install.

Do not describe fixture transcripts or local provider stubs as live interview acceptance. Physical audio routing, representative networks/models, email delivery, deployed billing, and release signing each need their own evidence.

## Rotation and recovery

Roll Stripe secrets with overlap, update Edge secrets, and verify the new values before expiring old credentials. Rotate any private Supabase keys shared outside the intended secret store. Revoke temporary management tokens when deployment finishes. Retain a rollback plan for schema and functions without deleting current customer data. The user instructed that pg_net remain unchanged; the recorded namespace warning does not authorize extension removal or relocation. Keep Firebase resources unchanged until their retirement is separately authorized and all required data has been migrated.

Current lifecycle checkpoint: the fix is deployed and a guarded nonempty reconciliation plus scheduled signed-Pro cancellation verification passed. The separate owned scheduled database check passed, then the exact sandbox subscription was canceled without proration/new invoice/refund. Owned database state is BYOK active with Pro canceled and zero seats; fresh signed BYOK fallback has passed with Pro-only license fields cleared. Daily cron is OFF.
