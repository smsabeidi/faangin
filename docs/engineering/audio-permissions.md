# System audio permissions

The reported state was microphone live and system audio denied in the running 0.1.0 app, even though macOS **Privacy & Security → Screen & System Audio Recording → Faangin** was already enabled.

The app's permission gate was rejecting a legitimate display-capture request. In the pinned Electron 44.7.0 runtime, `getDisplayMedia({ video: true, audio: true })` reaches the permission callback as `permission = 'media'` with an explicit empty `mediaTypes` array. Only device microphone/camera requests populate that array. The previous gate required exactly `['audio']`, which admitted microphone capture and blocked display/system audio before source selection. See [the pinned Electron implementation](https://github.com/electron/electron/blob/v44.7.0/shell/browser/web_contents_permission_helper.cc).

Version 0.2.6 admits the legacy empty array only from the owned local capture main frame while a current capture generation/session owns enabled, non-revoked system audio. Missing/malformed arrays, foreign windows/pages, subframes and device camera requests remain denied. The modern `display-capture` permission uses the same ownership requirement. Source enumeration rechecks the original generation and session after its asynchronous operation, so Stop or a replacement capture cannot lend its permission to an obsolete request.

This app gate is separate from macOS permission. The fix does not change OS recording settings. The UI must describe denied capture without claiming macOS was necessarily the source, and it must report failure of the chosen question source even when another source is healthy.

## Verification

The regression suite checks legacy and modern permissions, microphone-only operation, camera denial, malformed inputs, untrusted frames, and revocation. The isolated desktop workflow additionally calls **real Electron `getDisplayMedia`** in the sandboxed capture renderer. It verifies that the explicit empty-array request reaches the display handler. That probe deliberately declines source selection before `desktopCapturer.getSources`; it opens no screen/audio stream and uses no provider credential. The remaining desktop workflow uses public synthetic transcripts and a localhost provider.

Those checks catch the reported app-policy regression. They do not establish that a physical output device, conferencing application's routing, actual recognized speech or live model quality is correct. Check the expected source's words in **Conversation**, not only a moving meter or a healthy microphone. See the [0.2.6 verification record](build-status.md#audio-permission-candidate-026).

A separate explicit native check is available for a packaged app:

```sh
FAANGIN_APP_PATH="$PWD/dist/mac-arm64/Faangin.app" FAANGIN_SMOKE_NATIVE_AUDIO=1 npm run smoke
```

This opts into a bounded real system-audio stream in the same disposable, credential-free workspace. It reuses production source selection, immediately stops video without consuming pixels, verifies a live audio track, and measures aggregate RMS for one second through a muted output. It stops every track and closes its AudioContext, with acquisition and hard cleanup deadlines. Reports contain only availability, state, counts, sample rate and peak RMS; no audio samples, device labels or screen images. The default smoke does not run this check. A silent result can establish native stream availability, but not recognized speech or correct conferencing output. macOS permission prompts still require the user's decision.
