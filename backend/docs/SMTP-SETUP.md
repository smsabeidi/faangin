# Auth email delivery and remaining acceptance

Updated November 3, 2026. Actual signup confirmation and password-recovery emails from **Faangin <noreply@auth.faangin.com>** reached the approved connected Hostinger inbox. Signup confirmation completed; recovery reached its new-password form. The recovery page now independently confirms the password saved and requests returning to Faangin for a new code. The sign-in/device code expired without device approval/session exchange; reused/expired-link rejection and full native UI acceptance remain pending.

## Current verified state

| Check | Observation |
| --- | --- |
| DNS authority | `cosmos.dns-parking.com`, `nova.dns-parking.com` |
| `resend._domainkey.auth.faangin.com` | DKIM TXT present; key value intentionally omitted |
| `rsend.auth.faangin.com` | CNAME → `rsend.forge.rmta.net` |
| `send.auth.faangin.com` | CNAME → `send.forge.rmta.net`; SPF/MX resolve through CNAME |
| `_dmarc.auth.faangin.com` | Absent; DMARC remains a separate deliverability/protection step |
| Supabase Auth readback | Earlier API read returned HTTP 200 with confirmation required and SMTP unset. SMTP has since been saved in the dashboard and verified after reload. Current deployment token intentionally grants no Auth configuration access; earlier Auth API readback remains historical |
| Callback URLs | Previously approved Site URL and loopback allowlist remain unchanged and correct |
| Resend domain | auth.faangin.com is Verified after Verify DNS records; DKIM and both Forge CNAME sending checks passed. Sending enabled, receiving disabled |
| API key | Created after fresh approval: Faangin Auth / Sending access / auth.faangin.com. Captured/current key stored only in ignored backend/.env.smtp.local, mode 0600; its masked prefix matched the selected key |
| Duplicate key | The unused extra key was deleted after fresh user approval; Resend confirmed deletion and only the captured/current Faangin Auth key remains |
| SMTP save | Accepted and verified after reload: custom SMTP checked; smtp.resend.com, 465, Faangin, noreply@auth.faangin.com; Save disabled with no dirty changes |
| SMTP transport probe | Certificate-verified TLS to smtp.resend.com:465; EHLO and AUTH PLAIN returned 235. This transport/key probe sent zero messages |
| Tracking | No tracking subdomain is configured. Configure opened an empty New tracking subdomain form; it was left without submitting. Unsaved form defaults do not establish enabled tracking |
| Signup confirmation | Approved public signup delivered to founders@selmou.com INBOX at 2026-11-02 16:25:02 UTC, mailbox UID 51; sender matched Faangin <noreply@auth.faangin.com>. Confirmation link reached the real activation callback and signed in; fragment cleared |
| Password recovery | Actual page requested recovery; mail reached the same INBOX at 16:28:44 UTC, UID 52. Verified recovery link opened the new-password form and cleared its fragment. Recovery-page status independently confirms password saved; current device code expired without desktop session exchange |
| Device/native acceptance | The protected fixture confirms the code expired and no desktop session exists; device approval/session exchange were not completed. Source activation/callback integration was exercised; native Window capture failed with ScreenCaptureKit, so this is not full native UI acceptance |

Do not duplicate TXT/MX records at an existing CNAME name. Match Resend's actual generated records, which may use CNAMEs instead of older example TXT/MX layouts. Resend's Verified status and the two inbox deliveries are independently confirmed; full recovery and desktop activation remain unfinished. See [domain verification](https://resend.com/docs/add-a-domain) and [Hostinger instructions](https://resend.com/docs/guides/dns/hostinger).

## Saved SMTP settings

The current key is named **Faangin Auth**, with **Sending access** restricted to verified `auth.faangin.com`. It was created and connected after fresh approval. A browser timeout/state race created an unused extra key; that extra was deleted after fresh user approval and the current key was preserved. Keep its value in the approved secret store or SMTP password field, never in desktop JSON, chat, screenshots, or tracked files.

| Supabase SMTP setting | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` (implicit TLS) |
| Username | `resend` |
| Password | The approved domain-restricted sending key |
| Sender email | `noreply@auth.faangin.com` |
| Sender name | `Faangin` |

These settings and the protected key were saved, and a reload confirmed custom SMTP enabled with no unsaved changes. The nonsecret values follow [Resend's Supabase SMTP guide](https://resend.com/docs/send-with-supabase-smtp). Keep click and open tracking **off** for this authentication subdomain; rewriting links can break single-use Auth links. See [Resend Auth deliverability](https://resend.com/docs/knowledge-base/how-do-i-maximize-deliverability-for-supabase-auth-emails).

The previous scoped token expired; a fresh approved 24-hour token now supports project-read and Edge function/secret deployment only. It does not grant Auth configuration read/write, so earlier Auth API readback remains historical and owner Dashboard access is the current Auth settings path. Saving it through the Management API additionally requires both `auth_config_write` and `project_admin_write`, so do not silently expand that token. Use the owner's authorized Dashboard workflow. Read back only nonsecret settings after saving. [Read permissions](https://supabase.com/docs/reference/api/v1-get-auth-service-config), [write permissions](https://supabase.com/docs/reference/api/v1-update-auth-service-config).

## Minimal acceptance

1. Confirm the right Resend account/team and `auth.faangin.com` sending-domain verification; review the absent DMARC policy separately without changing unrelated DNS.
2. SMTP save/reload verification has passed. Preserve required email confirmation and existing callback URLs when making any further changes.
3. Fresh public signup and confirmation delivery/callback passed using the actual source activation server and device-sign-in helper. The exact dashboard search had no existing user before signup. Complete optional owner device approval and verify the independent desktop session; neither is yet claimed.
4. Recovery delivery and callback passed. Recovery-page status independently confirms the new password saved. Verify subsequent sign-in and reused/expired-link rejection; those checks and fresh device-session exchange remain open. Record provider delivery status and inbox authentication results without saving tokens or full mail links.

Only the two approved test messages were read. Each verification link was checked for the exact Supabase verification host, expected signup/recovery kind, and redirect to the real active callback lease; URLs, fragments, passwords, and device codes are withheld. Switching accounts exposed a valid logout HTTP 204 being parsed as JSON. The Auth request helper now accepts an empty 204 response; nine focused regressions and typecheck passed. The native app build passed, but capture failure prevented full native UI proof.

The email fixture is recorded privately in ignored mode-0600 `backend/.env.supabase-email-acceptance.local.json`. The email account and separate billing SQL account make two owned Auth fixtures pending cleanup when approved management access is renewed. The recovery page independently confirmed password saved. Use Different Account returned to the email field, clearing the recovery browser session; its activation tab was closed. The isolated Electron process and standalone callback helper are stopped; the latter exited 0 after an expired poll. Obsolete password, activation URL, device code and user code fields were scrubbed from the protected email fixture. Its phase is now password-reset-verified-device-expired, with exact uid/run/email/deviceId retained for owned cleanup and no desktop session. Device exchange remains incomplete; a fresh code is needed for a future sign-in.

Supabase documents an initial custom-SMTP limit of 30 messages/hour and a default 60-second same-user confirmation/recovery interval. Inspect actual project limits before interpreting a repeated test failure. Admin-created confirmed accounts do not prove email delivery. [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits).
