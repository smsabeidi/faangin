# System audio permissions

The reported state was microphone live and system audio denied in the running 0.1.0 app, even though macOS **Privacy & Security → Screen & System Audio Recording → Faangin** was already enabled.

The app's permission gate was rejecting a legitimate display-capture request. In the pinned Electron 44.7.0 runtime, `getDisplayMedia({ video: true, audio: true })` reaches the permission callback as `permission = 'media'` with an explicit empty `mediaTypes` array. Only device microphone/camera requests populate that array. The previous gate required exactly `['audio']`, which admitted microphone capture and blocked display/system audio before source selection. See [the pinned Electron implementation](https://github.com/electron/electron/blob/v44.7.0/shell/browser/web_contents_permission_helper.cc).

Version 0.2.6 admits the legacy empty array only from the owned local capture main frame while a current capture generation/session owns enabled, non-revoked system audio. Missing/malformed arrays, foreign windows/pages, subframes and device camera requests remain denied. The modern `display-capture` permission uses the same ownership requirement. Source enumeration rechecks the original generation and session after its asynchronous operation, so Stop or a replacement capture cannot lend its permission to an obsolete request.

This app gate is separate from macOS permission. The fix does not change OS recording settings. The UI must describe denied capture without claiming macOS was necessarily the source, and it must report failure of the chosen question source even when another source is healthy.

## Windows

Windows has no screen-recording or system-audio permission. `getMediaAccessStatus('screen')` always reports `granted` there, so the platform object (`src/main/platform/win32.ts`) reports `not-required` without asking the OS and offers no settings deep link; setup and Settings treat the screen row as satisfied. The microphone is governed by the global switch in **Settings → Privacy & security → Microphone** (`ms-settings:privacy-microphone`), read through `getMediaAccessStatus('microphone')` without any prompt because Windows never shows a per-app dialog to desktop apps; `denied` (the per-user switch) and `restricted` (the device-wide switch or group policy) block capture with copy that names that page, and `not-determined` and unreadable statuses let Chromium open the device.

Computer audio goes through the same `setDisplayMediaRequestHandler` as macOS: the owned capture frame's request is answered with a 0×0 screen source and `audio: 'loopback'`, which Chromium satisfies with WASAPI loopback of the default render device. Any screen source admits the request when the primary display id cannot be matched, since duplicated and remote displays report an empty `display_id` and the loopback is device-wide. No OS dialog appears and nothing can be denied, so a `NotAllowedError` can only come from Faangin's own gate; a failed check names the default playback device in **Windows Sound settings** (`ms-settings:sound`) rather than a permission, and the in-app computer-audio notice still gates the first session. From PowerShell the native check is `$env:FAANGIN_APP_PATH="$PWD\dist\win-unpacked\Faangin.exe"; $env:FAANGIN_SMOKE_NATIVE_AUDIO=1; npm run smoke`; it has not been run on Windows hardware.

## Verification

The regression suite checks legacy and modern permissions, microphone-only operation, camera denial, malformed inputs, untrusted frames, and revocation. The isolated desktop workflow additionally calls **real Electron `getDisplayMedia`** in the sandboxed capture renderer. It verifies that the explicit empty-array request reaches the display handler. That probe deliberately declines source selection before `desktopCapturer.getSources`; it opens no screen/audio stream and uses no provider credential. The remaining desktop workflow uses public synthetic transcripts and a localhost provider.

Those checks catch the reported app-policy regression. They do not establish that a physical output device, conferencing application's routing, actual recognized speech or live model quality is correct. Check the expected source's words in **Conversation**, not only a moving meter or a healthy microphone. See the [0.2.6 verification record](build-status.md#audio-permission-candidate-026).

A separate explicit native check is available for a packaged app:

```sh
FAANGIN_APP_PATH="$PWD/dist/mac-arm64/Faangin.app" FAANGIN_SMOKE_NATIVE_AUDIO=1 npm run smoke
```

This opts into a bounded real system-audio stream in the same disposable, credential-free workspace. It reuses production source selection, immediately stops video without consuming pixels, verifies a live audio track, and measures aggregate RMS for one second through a muted output. It stops every track and closes its AudioContext, with acquisition and hard cleanup deadlines. Reports contain only availability, state, counts, sample rate and peak RMS; no audio samples, device labels or screen images. The default smoke does not run this check. A silent result can establish native stream availability, but not recognized speech or correct conferencing output. macOS permission prompts still require the user's decision.
