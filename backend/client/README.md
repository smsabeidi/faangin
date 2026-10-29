# Dropping `faangin-cloud.ts` into the desktop app

Copy `client/faangin-cloud.ts` to `src/main/faangin-cloud.ts` in the app repo. It needs only Node (`node:crypto`, global `fetch`) and `ws`, which the app already has. Nothing in it runs in the renderer.

## Three constants

```ts
const FUNCTIONS_BASE = 'https://us-central1-faangin-staging.cloudfunctions.net'   // per environment
const WEB_API_KEY = '<Firebase web API key>'      // public; Project settings → General → Web API key
const GATEWAY_BASE = 'https://faangin-gateway-xxxx-uc.a.run.app'                 // printed by scripts/deploy-gateway.sh
```

Emulator: `FUNCTIONS_BASE = 'http://127.0.0.1:5001/demo-faangin/us-central1'`, `WEB_API_KEY = 'fake-api-key'`, and pass `EMULATOR_IDENTITY_TOOLKIT_BASE` / `EMULATOR_SECURE_TOKEN_BASE` as the `base` argument of `exchangeCustomToken` / `refreshIdToken`.

## Sign in (device code)

```ts
const device = { deviceId, deviceName }                       // deviceId: stable per install, /^[A-Za-z0-9_-]{8,64}$/
const start = await startDeviceSignIn(FUNCTIONS_BASE, device)
shell.openExternal(start.verificationUrl)                     // shows the same userCode in the browser
showCode(start.userCode)                                      // display as ABCD-EFGH
const result = await waitForDeviceSignIn(FUNCTIONS_BASE, start, { signal })
if (result.status !== 'approved') return                      // 'expired' or 'aborted': offer to try again
const session = await exchangeCustomToken(WEB_API_KEY, result.customToken)
```

Store `session.refreshToken` (and `uid`) the way the app already stores the OpenAI key: `safeStorage.encryptString(JSON.stringify({ uid, refreshToken }))` written to a `0600` file under `app.getPath('userData')` (see the key-file helpers in `src/main/index.ts`). Never store the ID token; it lasts an hour and is re-minted from the refresh token:

```ts
const tokens = idTokenSource(WEB_API_KEY, session, { onRefresh: persistRefreshToken })
await tokens.ensureFresh()                                    // before any call; refreshes 5 min before expiry
```

Sign out = delete the file. An `UNAUTHENTICATED` / `TOKEN_EXPIRED` CloudError from `refreshIdToken` means the account was disabled or the token revoked: sign the user out.

## License

```ts
const license = await fetchLicense(FUNCTIONS_BASE, await tokens.ensureFresh(), device)   // on launch and once a day
saveLicenseToken(license.token)                               // plain file; the token is signed, not secret
```

Offline check on every launch, no network:

```ts
const verified = verifyLicenseWithKeys(readLicenseToken())    // null → locked (buy or sign in)
if (verified?.inGrace) showRenewBanner()                      // past 30 days, within the 14-day grace: still works
```

`verified.plan` is `'byok'` or `'pro'`; `verified.status` can be `past_due` (Stripe is retrying a card) which still entitles.
CloudError codes from `fetchLicense`: `FAILED_PRECONDITION` nothing bought, `RESOURCE_EXHAUSTED` fourth active device.

**Public key**: put the value that `node scripts/gen-license-key.mjs` prints on stderr into `LICENSE_PUBLIC_KEYS` at the top of the file (current key first; add the next key before rotating). Staging and production builds use different keys.

## Pro mode (gateway instead of the customer's key)

The app's `inference.ts` hardcodes `RESPONSES_URL` / `TRANSCRIPTION_URL` and takes an `InferenceTransport { fetch?, createWebSocket? }`. Pro mode changes nothing in that file:

```ts
const transport = proTransport(tokens.get, GATEWAY_BASE)      // sync getter; call tokens.ensureFresh() first
generateAnswer(input, { apiKey: 'pro', transport, ... })      // apiKey is replaced by the ID token; any non-empty string
startTranscription({ apiKey: 'pro', transport, model: 'gpt-transcribe', ... })
```

In Pro mode set the model fields to the **modes**, the server picks the real models: `fastModel: 'fast'`, `smartModel: 'smart'`, hands-free answers `'handsfree'`, `transcriptionModel: 'gpt-transcribe'` (the gateway forces its own transcription model; the app only needs a value it accepts). Keep the BYOK path exactly as it is: no transport, the customer's key.

Gateway errors the app should surface: `402 { error: { code: 'no_pro' } }` (not entitled: refresh the license), `429` with `code: 'allowance_exhausted' | 'concurrency' | 'backstop'`, `503 pro_paused`. A `smart` answer that was downgraded carries the response header `x-faangin-mode: fast`. Skip the "Test connection" / model-visibility check in Pro mode; the gateway has no `/v1/models`.

## Tests

From the repo root: `npm run test:client` (runs `client/faangin-cloud.test.ts` with the gateway's `tsx`; needs no emulator and no network).
