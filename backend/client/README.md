# Desktop Supabase account client

`faangin-cloud.ts` is copied into `src/main/faangin-cloud.ts`. The synchronization test allows only the shipped license public keys to differ. It runs in Electron's main process and depends on Node crypto, fetch, and `ws`; no Supabase SDK, private backend key, or account token runs in the renderer.

Release metadata defaults to `config/cloud.supabase.json`; set `FAANGIN_CLOUD_CONFIG_FILE` to another public JSON file to override it:

```json
{
  "supabaseUrl": "https://your-project.supabase.co",
  "publishableKey": "sb_publishable_...",
  "gatewayBase": "https://your-project.supabase.co/functions/v1/faangin-gateway",
  "licensePublicKeys": ["base64 SPKI Ed25519 public key"]
}
```

The accounts base is derived as `${supabaseUrl}/functions/v1/faangin-api`. Packaged builds ignore runtime endpoint overrides. Development runs accept `FAANGIN_SUPABASE_URL`, `FAANGIN_SUPABASE_PUBLISHABLE_KEY`, `FAANGIN_GATEWAY_BASE`, and comma-separated `FAANGIN_LICENSE_PUBLIC_KEYS`.

## Browser approval and separate desktop sessions

1. Main calls `deviceCodeStart` with this installation's device ID and name.
2. Main serves one temporary activation page bound to `127.0.0.1` on an ephemeral port and opens it in the system browser. The URL carries a random page lease and the display code. A strict Host check, nonce CSP, no-store headers, and the lease expiry protect the page.
3. The page sends password/signup/recovery requests directly to Supabase. Browser access tokens stay in memory; browser refresh tokens are neither stored nor handed to desktop. Google sign-in is offered only when enabled in the project.
4. A verified browser user approves the code through `deviceCodeApprove`. The browser then revokes its own session with `scope=local`.
5. Main polls with the independent high-entropy device code. Approval returns `{status:'approved',tokenHash,uid}`. The server has already claimed the one-use approval and generated an email token for that exact verified user.
6. Main calls `/auth/v1/verify` with `{token_hash,type:'email'}`, then `/auth/v1/user` and checks the user ID against the approval. This creates an independent desktop session.
7. Main encrypts the desktop refresh token using OS-backed storage. Stored sessions include `provider:'supabase'` and the Supabase origin; legacy or other-project credentials are discarded locally.

Allow the temporary callback pattern `http://127.0.0.1:*/activate*` in the project's Auth redirect allowlist for confirmation, password recovery, and optional Google callbacks. The app must remain open while that activation lease is used. Public signup also requires working confirmation email delivery.

## Authenticated API and refresh

Public requests carry `apikey: <publishableKey>`. Authenticated account and gateway calls also carry the user's `Authorization: Bearer <access token>`. New publishable keys are not bearer tokens. Edge endpoints verify users explicitly; the private service key stays in the backend.

Account operations preserve `{data}` requests and `{result}` responses. Stable error codes include `UNAUTHENTICATED`, `FAILED_PRECONDITION`, and `RESOURCE_EXHAUSTED`.

Refresh calls `/auth/v1/token?grant_type=refresh_token` with a JSON refresh token. Main serializes refreshes and atomically persists a rotated refresh token before admitting another request. Revoked sessions clear local credentials; transient errors preserve them. Sign-out clears local credentials immediately and attempts to revoke only that desktop session.

The offline Ed25519 license format is unchanged. `LicenseService.requireInferenceAccess()` allows verified BYOK/Pro active and grace states; paid Pro obtains the managed gateway transport without a personal model key. The transport replaces provider authorization, adds the public apikey, and refuses reuse after local sign-out.

## Verification

From the repository root run the licensing, activation, and gateway fixture tests. From `backend/`, `npm run test:client` covers actual localhost HTTP/WebSocket transport, Supabase token exchange/user verification, refresh shape, license verification, and cancellation. These fixtures do not certify a deployed signup, Stripe payment, live model, or hardware audio journey.
