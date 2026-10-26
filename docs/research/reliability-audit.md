# Reliability, privacy, and release audit

Audit date: October 11, 2026. Reference: Cue 0.2.4 at commit [`8dfe7165e845bf1d6e02b31a8bb67b80452cd56c`](https://github.com/Blueturboguy07/cue/tree/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c). Audience: principal engineers responsible for the macOS first release, followed by Windows.

The reference demonstrates substantial feature plumbing, but its passing unit suite does not establish production reliability or exact parity with Cluely or InterviewCoder. The highest priority work is trustworthy cancellation, capture capability testing, protection of credentials and transcripts, and durable persistence. Feature parity should preserve observable workflows while correcting these defects.

## Evidence and limits

The review inspected the main process, preload bridge, renderer, provider adapters, meeting persistence, local transcription supervisor, native packaging, and their tests. The team ran `npm ci --ignore-scripts` and `npm test` in a separate reference checkout. On Node 26.7.0 and npm 11.19.0, the installed reference suite completed with **292 passed, 0 failed, 0 skipped**. The test log totals were independently inspected. Install scripts were disabled; this did not launch Electron or download native transcription binaries. The initial environment failures were missing `ws` and denied local socket operations, not demonstrated reference defects.

Three additional native-free reproductions evaluated unchanged reference function bodies in Node VM contexts with stubbed providers and media devices. They verified repeated batch STT calls after quota rejection, a late transcript arriving after stop and clear, and a late system audio stream surviving stop. These tests exercise JavaScript lifecycle behavior; they do not establish actual operating system permission or media behavior.

No signed macOS application, Windows installer, live provider account, paid API, physical microphone, actual loopback session, screen-sharing receiver, or ScreenCaptureKit exclusion behavior was exercised. No screenshot or meeting audio was collected during this audit. Commercial product behavior behind authentication remains unobserved. Any performance target in this document is a proposed release gate, not a measured result.

Priority meanings: **P1** blocks a supported public release or trustworthy capture/data handling; **P2** requires a defined mitigation and follow-up. No claim of an exploitable remote code execution vulnerability is made here.

## Trust boundaries

| Boundary | Reference behavior | Required product contract |
|---|---|---|
| Operating system → application | Screen, microphone, and display audio require separate capabilities. Main process captures screenshots; renderer captures microphone and loopback. | Explicit input selection and permission state for each source; acquisition capability distinct from transcription capability. |
| Renderer → privileged main process | A context bridge exposes settings, audio, capture, external URLs, model operations, document import, consent responses, and quit. | Narrow, validated IPC; correct sending frame and window; source-specific payload and size limits. |
| Application → providers | Screenshots, audio, profile context, transcript, and past meeting summaries can cross network boundaries. | Display the selected processor, cloud/local mode, permitted fallback, and background processing policy before transmission. |
| Application → local storage | Settings and credentials share JSON; meeting history uses a separate JSON file. | Credentials in protected storage, content retention controls, corruption recovery, durable save acknowledgements. |
| Application → local connector | Per-session token and user consent gate a local socket service; caller identity is generally self-reported. | Clearly state same-user trust boundary; stronger peer verification before asserting application identity. |
| Application → native sidecar | Whisper is supervised through loopback HTTP, a random request path, pinned model checksums, and a child process. | Signed/verified runtime, bounded lifecycle and requests, packaged-path verification, no unintended cloud fallback. |

## Prioritized findings

### R01 — P1: Stop does not invalidate a pending system audio start

**Evidence.** [`renderer/renderer.js:763–843`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/renderer/renderer.js#L763) uses `sysStarting` to prevent concurrent starts. After `getDisplayMedia` resolves, it unconditionally installs `sysStream`. `stopSystemAudio` cleans resources already assigned but does not invalidate pending acquisition. The unsupported-API return at lines 778–782 also occurs before the `finally` that clears `sysStarting`.

**Observed offline reproduction.** Start acquisition; stop before the stubbed permission promise resolves; then resolve it. Result: `captureExists: true`, `audioTrack: "live"`. This is a race in the extracted reference code, without native capture.

**Impact.** A delayed permission response can reopen media acquisition after the user stops. A start guard is insufficient as a cancellation contract.

**Required fix and test.** Use a session generation or cancellation token across every asynchronous stage. Stop must invalidate pending starts and stop every late track before assignment. Test pending permission, worklet load, repeated stop, denied permission, unsupported API, renderer crash, and stop/start supersession. Native testing must verify tracks and operating system indicators actually end.

### R02 — P1: Batch STT results can repopulate a cleared or stopped session

**Evidence.** [`main.js:381–413`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L381) awaits transcription and publishes the result without checking a capture or transcript generation. [`main.js:732–748`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L732) stops loops and clears buffers; [`main.js:1118–1123`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1118) clears transcript and closes its meeting. Neither invalidates an in-flight batch response.

**Observed offline reproduction.** Begin a stubbed transcription, set capture inactive and clear the transcript, then resolve transcription. Result: `capturing: false`, `turnsAfterClear: 1`.

**Impact.** Content cleared by the user can reappear or become part of a subsequent meeting. Streaming STT has stale-instance guards, but the batch path lacks their equivalent.

**Required fix and test.** Tag every input, transcription, and publication with session ID, capture generation, and transcript epoch. Apply the [specified closing-session cutoff](../engineering/architecture.md#lifecycle-and-cancellation): Capture Stop ends acquisition and permits only already-admitted speech results within their frozen sequence bounds to finalize for at most five seconds. Clear/reset fences all prior results, including eligible closing results. Exercise stop, clear, restart, provider change, timeout, and delayed callbacks in each STT mode.

### R03 — P1: Batch quota rejection does not actually stop repeated provider calls

**Evidence.** [`main.js:393`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L393) creates a fresh STT adapter per flush. [`src/stt.js:139–177`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/stt.js#L139) keeps the 30-second quota cooldown inside that adapter, so the next flush discards it. `handleSttError` sets `sttDisabled` at [`main.js:428–435`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L428), but neither `flushChannel` nor `routeAudio` consults this flag. The periodic flush interval is 900 ms.

**Observed offline reproduction.** Two sequential audio flushes through a provider returning 429 produced `calls: 2`, `notices: 1`, `records: 2`, `sttDisabled: true`.

**Impact.** The UI suppresses subsequent notices while requests can continue. Authorization and quota failures can become repeated network traffic; a hung batch request can also accumulate audio because buffers have no byte or duration ceiling while that channel is transcribing.

**Required fix and test.** Persist adapter/circuit state per session and provider, respect retry-after, distinguish terminal credential errors from temporary rate limits, enforce byte/duration bounds, and make recovery explicit. A deterministic 429/401/stall fixture must show no new calls while the circuit is open and bounded memory throughout.

### R04 — P1: LLM watchdog releases the UI without cancelling the transport

**Evidence.** [`main.js:841–878`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L841) races generation against an inactivity timer and suppresses late tokens. Provider adapters at [`src/llm.js:239–450`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/llm.js#L239) do not wire a caller cancellation signal into SDK requests or Ollama `fetch`. Slide captions use a similar race at [`main.js:533–554`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L533). No user cancel method appears in the preload bridge.

**Impact.** Timeout drops visible output, but the underlying request can remain active and incur further provider work. Multiple abandoned streams can coexist with subsequent requests. Renderer busy state separately self-clears after 40 seconds, which does not prove main process or provider cancellation.

**Required fix and test.** One operation ID and AbortSignal from UI to provider; independent connection, first-token, inactivity, and total deadlines; explicit cancelled/partial/completed states. Test that cancellation closes the actual transport, releases concurrency, rejects stale tokens, and preserves a useful partial answer. Do not promise that provider billing stops at exactly the local cancellation instant.

### R05 — P1: Durable settings errors are hidden at the IPC boundary

**Evidence.** [`src/store.js:163–172`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/store.js#L163) records `lastSaveError` and returns false. `setSettings` mutates memory and returns data regardless of the save result at [`src/store.js:230–237`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/store.js#L230). [`main.js:886–891`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L886) returns that data as success without checking persistence. Renderer tests ensure the modal awaits its save function, but not that IPC acknowledgement means bytes reached durable storage.

**Impact.** Keys or settings can appear saved, work for the current process, and disappear on restart after disk-full, read-only, or access failures.

**Required fix and test.** A successful save acknowledgement must correspond to committed persistence. Return a structured failure, retain an unsaved indicator, and define rollback behavior. Inject ENOSPC/EACCES, locked destination, failed rename, and process interruption; restart from disk after each case.

### R06 — P1: Meeting transcript persistence has weaker durability and privacy than settings

**Evidence.** [`src/meetings.js:11–27`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/meetings.js#L11) reads plain JSON, returns an empty list on every read/parse failure, and truncates/writes the entire history directly. Write failures return false but callers ignore them. No explicit file mode, backup, atomic replacement, or schema version is applied. [`main.js:1343–1349`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1343) installs a 1.5-second debounce. History is limited to 50 meetings, but each persisted meeting transcript has no duration/turn bound.

**Impact.** A crash mid-write can lose the entire history. File permission strength depends on the user's umask. A hard crash can lose pending debounced turns. A misleading UI clear operation retains the historical meeting at [`main.js:1119`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1119).

**Required fix and test.** Use transactional storage with schema migrations, bounded records, visible save failures, configurable retention, explicit session reset versus history deletion, and export/delete operations. Define a recovery point objective for hard termination and power failure. Test corrupt records without overwriting recoverable content; verify transcript deletion includes summaries, backups, and search material.

### R07 — P1: Credentials are plaintext and most are returned to the renderer

**Evidence.** Credentials are part of `cue-data.json` through [`src/store.js:11,35`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/store.js#L11). [`src/settings-store-core.js:83–102`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/settings-store-core.js#L83) writes plaintext settings and a backup; Unix permissions are 0600, which reduces cross-user exposure but does not encrypt data. [`src/store.js:201–206`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/store.js#L201) redacts only the managed Publik key; other provider keys remain available through `settingsGet`.

**Impact.** Backups, local account compromise, and renderer compromise can expose reusable cloud credentials. Removing a key from the latest settings does not itself remove the previous backup containing that key.

**Required fix and test.** Keep secrets in macOS Keychain or the selected Electron protected storage facility; return credential presence and metadata rather than key material. Use write-only key updates and an explicit replace/delete lifecycle. Migrate old plaintext stores safely, including backup cleanup, with recoverable failure behavior. Windows storage and ACL behavior need separate validation.

### R08 — P1: IPC and media permissions trust too much of the renderer surface

**Evidence.** [`main.js:294–299`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L294) enables context isolation and disables node integration, but disables sandboxing. The permissions window uses the same broad preload and sandbox setting at lines 1308–1313. [`preload.js:4–49`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/preload.js#L4) exposes privileged functions to both windows. Main handlers generally ignore the sending event and do not apply payload schemas or size limits. `ask` dereferences `payload.mode`; PCM immediately enters `Buffer.from`. [`main.js:1352–1354`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1352) grants media permission classes for the default session without checking requesting origin, frame, or input type. The display request handler likewise ignores requester identity.

**Impact.** Malformed IPC can fail inside privileged code or cause resource exhaustion. A compromised authorized renderer has access to unrelated privileges and most credentials. Session-wide media grants expand the consequences of a future navigation or content vulnerability. This is defense-in-depth analysis, not proof of an existing remote exploit.

**Required fix and test.** Sandboxed renderers; per-window preloads; trusted navigation and new-window controls; sender/frame verification and schemas for every IPC method; bounded audio batches; explicit origin and audio-only permission checks. Invalid null, oversized, wrong-type, wrong-window, and untrusted-frame inputs must fail closed without crashing.

### R09 — P2: General external URL opening lacks the restrictions used for gateway URLs

**Evidence.** [`main.js:1166`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1166) passes the renderer-supplied URL directly to `shell.openExternal`. By contrast, the Publik-specific handler uses an origin resolver at lines 1059–1063. Some legitimate settings/help links use operating system schemes, so a blanket HTTPS restriction would break intended behavior.

**Required fix and test.** Give help links and operating system settings separate typed commands. Parse and allowlist explicitly supported HTTPS origins or exact OS settings destinations. Reject file URLs, executable/application protocols, embedded credentials, and deceptive URL shapes. Escaped model output currently does not create arbitrary clickable links, so model text alone is not shown to reach this handler.

### R10 — P1: Background notes can process content and spend outside the foreground gate

**Evidence.** The foreground runner requires the first-use managed-provider card before spending at [`main.js:798–800`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L798). On startup, [`main.js:1350`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1350) calls meeting catch-up. Stopping capture calls note refresh at lines 735–740. [`src/meeting-memory.js:47–64,127–131`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/meeting-memory.js#L47) checks `llm.ready` but does not enforce the foreground first-use card, content-processing policy, or a stream deadline.

**Impact.** Existing unsummarized history can be transmitted on launch to whichever provider is currently selected. A managed key with an unacknowledged card may be usable through this separate path. A stalled summary can leave catch-up or note-refresh permanently in flight. The provider call was not executed during this audit.

**Required fix and test.** Centralize authorization and budgets for every inference, including slides and notes. Explain and store the background processing preference. Provider changes must not silently authorize old history transmission. Stub startup and stop with unaccepted disclosure/card, offline state, quota exhaustion, provider change, and stalled stream; assert no unauthorized request.

### R11 — P1: macOS capture exclusion cannot support a blanket undetectability promise

**Evidence.** Cue calls `setContentProtection(true)` at [`main.js:317–331`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L317). Its own source states that its macOS display loopback route can expose an operating system capture indicator at [`main.js:1368–1375`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1368), so meeting audio defaults off on macOS. Older Windows builds and remote sessions skip protection; Linux has no equivalent primitive in this implementation.

[Electron's BrowserWindow reference](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable) explicitly documents that newer macOS applications using ScreenCaptureKit may capture a protected window. [Electron's desktopCapturer reference](https://www.electronjs.org/docs/latest/api/desktop-capturer) also documents evolving macOS audio routes and permission requirements. These current-runtime facts must be verified against the version actually shipped; Cue declares Electron 33 while current documentation describes later behavior.

**Required product contract.** Maintain an observable compatibility matrix: operating system/version, runtime/version, acquisition API, application build, capture/share client, display/window mode, and receiver observation. Say what was verified for each combination. Content exclusion, taskbar visibility, OS indicators, screen visibility, and process identity are separate properties. An external camera and system process inspection remain outside pixel-exclusion guarantees.

Process/window names imitating an updater at [`main.js:346–350`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L346) are not an engineering substitute for capture compatibility. The new application should use its own product identity.

### R12 — P2: Permission probes and screen failure handling can imply unavailable context

**Evidence.** [`main.js:1243–1246`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L1243) treats any nonzero bitmap byte as proof of access. An opaque black placeholder has nonzero alpha; this does not reliably distinguish permission from placeholder output. [`main.js:803–817`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js#L803) reports screenshot failure but then continues a screen-dependent request without an image. Primary display and first enumerated display selection also differ across screenshot and slide hash routes.

**Required fix and test.** Treat permission status, source enumeration, nonempty frames, and a successful known-content capture as separate signals. Explicitly abort screen-required actions when capture fails, or present a user-approved text-only fallback. Test a black legitimate desktop, blocked/empty thumbnails, secondary monitor, Retina scaling, monitor detach, full-screen workspace, and a capture source changing mid-session.

### R13 — P2: Temporary screenshots and document imports need resource and lifecycle limits

**Evidence.** [`src/screen.js:40–55`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/screen.js#L40) writes a full-resolution PNG in the system temporary directory and unlinks it in a normal completion `finally`; a process crash or early native command error can bypass cleanup. No explicit timeout or private temporary directory is used. [`src/resume.js:6–17`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/resume.js#L6) reads a chosen PDF/DOCX fully and parses it without byte/page/time limits. The user-facing dialog controls paths, which is a positive boundary, but parsing still happens in main process.

**Required fix and test.** Prefer in-memory capture; otherwise use a private temporary directory and crash-safe stale-file cleanup. Bound image/request size explicitly. Parse documents in an isolated process with enforced network denial and file/expansion/time caps; return inert text only. A generic worker alone is not a sandbox. Verify unsupported, malformed, image-only PDF, unusually large, archive-expansion, and interrupted imports without freezing the overlay.

### R14 — P2: Profile and meeting memory enter system instructions without provenance boundaries

**Evidence.** [`src/prompts.js:13–15`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/prompts.js#L13) prepends the profile/context block directly to system instructions. Resume/job-description and prior generated summaries can therefore occupy the same instruction role as application rules. Transcript and screenshot are separately supplied as user content, but no robust prompt-injection test corpus is visible. The behavioral fallback explicitly asks for a plausible story when no STAR stories exist at [`src/interview-context.js:214–217`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/interview-context.js#L214).

**Impact.** Imported content or poisoned meeting memory can steer answers; the system can invent personal experience. This implementation does not give models a tool execution path, so the demonstrated scope is answer integrity and context disclosure, not autonomous privileged action.

**Required fix and test.** Preserve provenance, session association, and trust level of every context segment; keep imported data outside authoritative instructions. Require source support for claims about the user's background and distinguish suggestions from facts. Evaluate adversarial spoken, screen, document, and historical-summary instructions plus thin-context cases. No prompt wording alone should be treated as a complete security boundary.

### R15 — P2: Local connector identity is a same-user assertion, not verified application identity

**Evidence.** [`vendor/app-link/lib/server.js:28–48`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/vendor/app-link/lib/server.js#L28) accurately states that same-user processes can read the runfile token and that Node does not verify peer application identity. `callerId` and name come from client input at lines 291–293. Cue does not supply the optional `verifyPeer` hook. Local socket permissions, request limits, explicit read/action consent, and separate slide-caption consent are useful controls, but do not strengthen caller identity. [`src/applink.js:119–127`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/applink.js#L119) also acknowledges capture state before its asynchronous transition completes.

**Required fix and test.** Either describe the connector as same-user trusted tooling or use native peer/code-signature verification. Use random identifiers and validated sender for UI consent replies. Await actual transitions before reporting success. Test denied consent, revoke during connection, spoofed name/ID, weaker identity after a stronger grant, connection limits, and capture-start failure. This connector is optional for initial parity.

### R16 — P1 for local transcription releases: Native package behavior is not established by configuration tests

**Evidence.** [`scripts/after-pack.js:19–38`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/scripts/after-pack.js#L19) makes macOS Whisper bundling opt-in and writes to `appOutDir/resources/whisper-runtime`. [`src/whisper-runtime.js:20–21`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/whisper-runtime.js#L20) searches relative to runtime `resourcesPath`, which on macOS normally belongs inside the `.app` bundle. This suggests a packaged-path mismatch for opt-in macOS builds; no macOS artifact was built to reproduce it. Signing and notarization also depend on release environment flags.

The installed electron-builder code independently confirms its macOS resources destination is `<product>.app/Contents/Resources` (`app-builder-lib/out/platformPackager.js:470–484`), unlike Cue's fixed output destination. The sidecar's inference request uses cancellation and a 120-second deadline, but its health probe at [`src/whisper-server-session.js:227–244`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/whisper-server-session.js#L227) awaits an unbounded fetch inside an outer 180-second loop. A stalled health request can prevent the loop from checking its deadline or cancellation promptly.

**Required fix and test.** Launch the produced signed application on a clean machine, resolve bundled paths from the runtime itself, verify sidecar signing/dependencies, load a verified model offline, and stop during model loading/inference. Add a per-health-request deadline. Packaging config assertions and fake child processes are insufficient acceptance evidence. The default macOS build must either include a usable local runtime or clearly declare that local STT is unavailable.

### R17 — P1 release review: Dependency advisories require triage

**Evidence.** The October 11 dependency audit for the installed reference reported **18 vulnerable packages: 8 high and 10 moderate, 0 critical**. Direct packages marked affected included Electron and extract-zip at high severity and electron-builder and mammoth at moderate severity. This is an advisory snapshot, not proof that all reported paths are reachable in the shipped application.

**Required fix and test.** Classify each advisory by runtime/build/import/download exposure, upgrade to reviewed supported versions, and repeat relevant native capture, document parsing, package, and signing checks. Do not blindly apply `npm audit fix --force`: suggested resolutions include major changes and possible downgrades. Produce a dependency inventory and a documented decision for every unresolved runtime advisory before distribution.

## Controls worth preserving

- The renderer CSP restricts scripts to local files. Stream tokens and transcript text use `textContent`; final markdown escapes raw HTML before producing a small fixed tag set. An arbitrary-HTML XSS was not demonstrated in this rendering path. See [`renderer/index.html:5`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/renderer/index.html#L5) and [`renderer/renderer.js:58–81`](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/renderer/renderer.js#L58).
- Managed-provider keys are excluded from renderer settings and incoming renderer patches. Gateway URLs use a stricter resolver. This pattern should extend to all secrets and external destinations.
- Settings use a temporary write, best-effort backup, corruption recovery, and 0600 mode. These are meaningful improvements, although fallback in-place writes are not atomic and no explicit fsync establishes power-loss durability.
- Streaming sockets detach stale callbacks, cancel reconnect timers, and clear keep-alive intervals on stop. Local-only startup failure explicitly avoids cloud fallback. Preserve this privacy contract across all errors.
- Model downloads/imports validate catalog size and SHA-256 and support abort/resume. Sidecar inference uses loopback, a random path, in-memory audio multipart, a bounded log tail, and cancellation. Keep these boundaries while verifying actual shipped binaries.
- Foreground recap/follow-up reject an empty transcript, reducing generic fabricated output. Extend evidence-aware behavior to screenshot failures and profile answers.

## Release validation and parity plan

### macOS first

| Gate | Procedure | Evidence required |
|---|---|---|
| Permissions and audio route | Test first launch, grant, deny, revoke, relaunch, OS upgrade, runtime upgrade; identify the exact microphone/system-audio API and required plist values. | Signed build hash, macOS/runtime versions, permission state transitions, known test audio observed, OS indicator behavior. |
| Capture selection and share compatibility | Capture a synthetic screen on one/two displays, window/full-screen shares, selected supported call clients and browsers; inspect from a second participant's receiver. | Local and receiver captures with synthetic content, explicit pass/fail for overlay pixels and OS indicators per mode. |
| Stop and session isolation | Capture Stop during permission, worklet load, and STT; separately cancel a pending answer; restart and clear repeatedly. | Acquisition ends on Stop; only admitted speech results within the frozen cutoff may finalize for five seconds, then speech transport/sidecar disposal completes within its two-second deadline. No stale publications after clear. Answer Cancel follows its independent transport lifecycle. |
| Local privacy | Run local STT with outbound network denied; fail model/runtime/startup and verify behavior. | Zero audio/cloud fallback requests, clear unavailability errors, verified sidecar/artifact paths. |
| Persistence and deletion | Kill app mid-write, inject disk full/access failures, corrupt individual records, restart, migrate old schema, delete history and key. | Recoverable state, visible save failures, documented maximum loss window, absence of deleted content and credentials in retained artifacts. |
| Distribution | Install quarantined signed/notarized artifact on clean Apple Silicon and any claimed Intel target. | Gatekeeper outcome, permissions attached to correct identity, upgrade continuity, signing verification including sidecar. |

Evaluate the current supported Electron/runtime audio path before freezing the OS support table. Current desktopCapturer documentation includes CoreAudio Tap behavior in newer versions; therefore an assumption that system audio always requires the older display loopback route should not become a permanent design constraint. The exact choice needs a native spike and capability probe.

### Windows next

Test a physical local-console Windows 11 session first, then any declared Windows 10 build. Treat RDP, Cloud PC, and VM consoles as separate compatibility rows. Verify microphone privacy settings, WASAPI/loopback behavior through the chosen runtime, capture exclusion across supported receiver APIs, NSIS per-user install, DLL distribution, Defender/quarantine, hotkeys, mixed DPI displays, device changes, and audio exclusive mode. Configuration-only tests establish none of these native outcomes.

### Deterministic quality suite

1. **Provider fixtures:** success, no text, partial stream, 401/403, 404, quota 429, rate-limit 429 with retry-after, 413, 5xx, connect stall, midstream stall, malformed frames, network change, and aborted stream. Assert request routing, terminal state, cost/budget gate, bounded retry, and absence of stale output.
2. **Session state machine:** permission and media acquisition independent from STT connection; separate microphone and system-source health; operation/session IDs; capture start/stop and clear fencing; no duplicated pipelines. Use real promises and behavioral assertions rather than source regex checks.
3. **Content integrity:** known synthetic audio transcripts, overlapping speakers, silence, device sample-rate drift, delayed interim/final events, OCR-heavy/code screenshots, malformed output, adversarial document/transcript/screenshot instructions, unrelated historical meeting context, and missing personal history.
4. **Longevity and resources:** two-hour synthetic session, repeated device disconnect/reconnect, 100 start/stop cycles, long meeting history, large import, quota exhaustion, and provider stall. Record queue bytes, drops, CPU, memory, sidecar state, and deadline outcomes.
5. **Migration and data handling:** versioned schema upgrades, partial/corrupt stores, secret-store locked/unavailable, interrupted credential migration, retention pruning, delete/export, and crash recovery. No test should require real private meeting content.

The [PRD release targets](../prd.md#release-targets) own the proposed performance thresholds. Measure each threshold on a named hardware/runtime/provider/network configuration and report cold versus warm behavior. Cold local-model load requires its own hardware/model benchmark and deadline. Thresholds must be calibrated with actual native measurements; vendor marketing latency is not acceptance evidence.

Parity is established per workflow with a reference version, observed input, observed output/state transition, failure behavior, and supported environment. It is not established by using identical prompts, counting features, matching landing-page claims, or passing a source-inspection test suite.
