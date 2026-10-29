# Cue reference implementation audit

**Audience:** principal desktop, audio, platform, application, and quality engineers.  
**Audit date:** October 11, 2026.  
**Reference:** [Blueturboguy07/cue](https://github.com/Blueturboguy07/cue), commit `8dfe7165e845bf1d6e02b31a8bb67b80452cd56c`, package version `0.2.4`.  
**Local reference checkout:** `/private/tmp/faangin-cue-reference`. No Cue application code was copied into Faangin during this audit.

## Assessment

Cue is a working Electron reference for an overlay assistant with on-demand screen capture, separate microphone and system-audio transcription channels, streaming answers, local meeting memory, and local Whisper supervision. Its modular audio/model/storage code offers useful implementation lessons. It is not a complete Cluely or InterviewCoder product: several modules are disconnected from the current UI, platform guarantees are overstated in places, and application security and failure handling need substantial work before reuse as a production foundation.

The reproducible unit suite passed **292 of 292 tests** after installing locked dependencies without lifecycle scripts and allowing local test sockets. This establishes useful regression coverage, not operational parity or verified audio quality. No live provider request, real microphone capture, screen-share compatibility matrix, notarized application, or native Whisper inference was exercised in this audit.

For a macOS-first Faangin implementation, prioritize a platform capability spike before promising system-audio behavior or capture exclusion. Cue's macOS packaging currently skips the local Whisper runtime by default, and its optional packaging destination is inconsistent with the macOS application resource directory.

## Evidence and method

The audit read the checked-out README, application source, renderer, preload, build scripts, release/CI workflows, tests, vendored integration library, and dependency lockfile. Statements below are classified as implemented paths, source-observed gaps, or unverified operational claims. Source references identify this exact commit; they do not describe an eventual release binary.

Commands performed:

```sh
git clone --depth 1 https://github.com/Blueturboguy07/cue.git /private/tmp/faangin-cue-reference
git rev-parse HEAD
npm ci --ignore-scripts
npm test
npm audit --json
```

Test environment: Node `26.7.0`, npm `11.19.0`, host macOS, execution date above. Dependencies installed: 392 packages. Electron's installation hook was deliberately not run, so the Electron GUI was not launched. An initial dependency-free sandbox run produced six socket `EPERM` failures and one missing `ws` dependency; these were environmental failures and disappeared in the complete run. The final run recorded 292 tests, 292 passes, zero failures, zero skips, and zero cancellations. Temporary evidence files are `/private/tmp/cue-test-installed.log` and `/private/tmp/cue-npm-audit.json`.

## Architecture

| Layer | Implementation | Implication for Faangin |
|---|---|---|
| Desktop shell | Electron `^33.2.1`; `main.js` is 1,469 lines. A frameless transparent window is always on top, occupies all workspaces, and hides from taskbar/Dock paths. | Use a supported Electron release and separate permission, window, capture, session, and model controllers. |
| Renderer | Vanilla HTML/CSS/JS; `renderer/renderer.js` is 2,091 lines. Audio capture lives beside UI and state logic. | Preserve fast local interaction while isolating capture lifecycle from rendering. |
| Bridge | Explicit `contextBridge` methods in `preload.js`; no direct renderer Node integration. Events stream transcript, status, and model tokens. | Keep a narrow typed IPC contract, validate sender and payload, and return unsubscribe functions. |
| Screen | macOS `screencapture` subprocess, then `desktopCapturer` fallback; primary display; JPEG encoding. | Separate selected display/region capture from model attachment policy. |
| Audio | Renderer `getUserMedia` and `getDisplayMedia`; AudioWorklet converts mono float samples into 16-bit PCM; 16 kHz AudioContexts. | Build independently supervised channels with device and track health reporting. |
| Speech | Streaming OpenAI, Deepgram, or explicit Gemini Live; batch OpenAI/Groq/Gemini/custom; local Whisper sidecar. | Model providers need capability metadata, measured latency, stable transcript identifiers, and deterministic failover. |
| Responses | One `createLLM` streaming abstraction maps to several provider SDKs and compatible endpoints. | Standardize cancellation, usage, errors, and image capability before adding numerous providers. |
| Storage | Settings JSON with backup/atomic replacement; meeting JSON with separate persistence mechanics. | Use a transactional local store for sessions and OS-protected credential storage. |
| Integration | Vendored local app-link server exposes redacted state, capture actions, and separately consented slide captions. | A local integration API is optional scope; document its same-user trust boundary. |

The public runtime is a local desktop application. There is no first-party account service, hosted session sync, managed model gateway implementation, billing backend, web dashboard, or enterprise organization service in this repository. `publik` is an external gateway integration rather than that backend's source.

## Actual capability inventory

“Implemented” below means a reachable code path exists; it does not mean every operating system/provider combination was tested.

| Capability | Status | Evidence and practical limits |
|---|---|---|
| Floating glass overlay | Implemented | `main.js:createWindow`, `renderer/index.html`, `renderer/styles.css`. Drag, collapse, opacity from 20–100%, resize, and click-through empty margins. Placement starts from the primary display. |
| Global answer shortcuts | Implemented | `main.js:1214`. Say, assist, coding solve, hide, quit. Registration failures are recorded. |
| Configurable shortcut manager | Library only | `src/shortcuts.js` has eight defaults, conflict checks, and validation; main never imports it and registers five fixed shortcuts. No shortcut configuration UI. |
| Smart assist | Implemented | `src/prompts.js:32`, `main.js:763`. Current screen plus recent conversation and profile context. |
| “What should I say?” | Implemented | Transcript-only `say` mode. Unlike `recap`, it is not gated on nonempty transcript. Quality depends on hearing the remote speaker. |
| Freeform ask | Implemented | Screen plus last 12 transcript turns. Each request sends one newly built user turn; prior generated answers are displayed but not included as conversational model turns. |
| Answer a transcribed question | Implemented | The remote channel fills the composer; heuristic completeness and short silence timers signal readiness. Enter selects `answerThis`, which sends the exact question without screenshot. This is a heuristic, not a semantic question detector. |
| Coding screenshot solution | Implemented | `leetcode` mode requests restatement, approach, fenced solution, and complexity. Language follows screenshot, else Python. No executable verification, multi-screenshot stack, editor, debugger, or dedicated solution workspace. |
| Fast/smart model tiers | Implemented | Toggle chooses provider-specific model IDs and 700/1,400 default output-token limits. Gemini adds thinking headroom; no universal model-capability negotiation. |
| Microphone capture | Implemented | AudioWorklet with ScriptProcessor fallback; mic generation counter prevents stale duplicate starts. Uses default OS input; no device chooser. |
| System/meeting audio | Implemented, platform dependent | Electron display-media handler supplies `audio: 'loopback'`; macOS enables Chromium ScreenCaptureKit switches and requires opt-in `meetingAudio`. The capture UI stops video tracks and retains audio. No per-application loopback selection. |
| Speaker attribution | Two channel labels | “You” is microphone, “Them” is all system audio. Several remote people share “Them”; this is not multi-speaker diarization. No speaker identities or confidence scores. |
| Live interim/final transcript | Implemented | Streaming STT updates live text and sidebar. Final rows merge sentence fragments by channel/silence. No timestamp-rich transcript editor. |
| Batch transcription | Implemented | Main flushes buffered PCM every 900 ms, skips clips under minimum duration and RMS gate. VAD states do not bound batch input into natural utterances. |
| Local transcription | Implemented path | Persistent loopback Whisper server, channel-specific utterance segmentation, serialized inference, 15-second stop-drain budget. Packaged macOS runtime problem described below. |
| Whisper model management | Implemented | 30 catalog artifacts, tiny through large/turbo and quantized variants; resumable Range downloads, cancel, import, delete, size/SHA-256 verification. Individual models range about 32 MB to 3.1 GB. |
| Recap | Implemented | Whole in-memory transcript, capped at 200 turns. The stored meeting transcript can be longer, so “whole conversation” in the foreground recap is bounded. |
| Meeting persistence/resume | Implemented backend | First transcript turn opens a meeting; up to 50 retained; recent open meeting resumes within 30 minutes; background notes and last-three-summary memory. |
| Historical session UI/search/export | Absent | `src/meetings.js` supports substring search and removal, but main/preload expose no meeting APIs. UI “history” is current transcript only. Clear History retains its ended meeting in storage. |
| Structured notes | Implemented backend | Summary, key points, decisions, action items, follow-up; notes generation on stop and catch-up at launch. No notes display/edit/export UI. |
| Resume/JD import and profile personalization | Backend only in current UI | PDF/DOCX parsing, resume/JD/STAR/motivation/compensation fields, category-based context are present. `renderer/index.html` has only Keys, Audio, Style, Appearance; no profile fields or call to exposed `pickProfileDocument`. Existing saved profile data can still affect prompts. |
| Style instructions | Implemented | 2,000-character rules applied to all answer modes except coding solve. Stored locally; included in provider system prompt. |
| Slide tracking | Implemented, partial UI | Opt-in small-screen hashing, stable-change captions, transcript indices, up to 50 default slides. Images are not stored; captions live in memory. Renderer shows a status message, not a browsable slide gallery. Captions are available through IPC/local integration. |
| Follow-up suggestions | No dedicated answer mode | Old `docs/overlay.png` shows “Follow-up questions,” but current action row and `MODES` do not contain it. Structured notes do have a follow-up field. |
| External assistant access | Implemented | Redacted state plus start/stop listening; independent consent for slide captions; revocation UI. Local same-user processes can read discovery tokens, so caller name is not strong app identity. |
| Keyless managed gateway | Conditional integration | Packaged releases embed publishable `PUBLIK_APP_TOKEN`, provision anonymous install, show pricing/disclosure, wallet/claim/credit links, and re-provisioning. Committed `src/publik-build.json` has empty token: development checkout lacks this path by default. |
| First-run permission/tutorial flow | Implemented | macOS microphone and screen permission gate; Windows informational gate; explicit statuses. Wording is inconsistent for Linux/Windows in some renderer branches. |
| Capture exclusion | Best effort | OS window content protection; Linux explicitly skipped, old Windows and remote Windows session excluded from protection. macOS modern capture compatibility unverified. |
| Account/team/cloud integrations | Absent | No calendar/CRM/video-platform integrations, team administration, SSO, cloud meeting search, share links, or cloud retention service. |
| Auto-update | Absent | Builder uses `publish: null`; no application auto-update controller. |

## Provider inventory and verification limits

LLM routes exist for OpenAI, Anthropic, Gemini, Azure, Ollama, Custom, Groq, Cerebras, MiniMax, DeepSeek, and publik. Compatible routes reuse chat-completions; Azure performs endpoint/header adaptation; Ollama parses newline JSON and optionally sends images. Model IDs are editable but not discovered or capability-tested.

Speech selection is independent of chat selection. Auto streaming prioritizes Deepgram, then OpenAI. Gemini-only Auto goes to batch; explicit Gemini has Live implementation. Batch Auto chains OpenAI/Groq/Gemini; Custom must be explicitly selected with URL and key. Current Audio UI presents only Auto, Local, OpenAI, and Custom, so explicit Gemini/Groq/Deepgram selections are backend possibilities rather than current selectable controls.

Configured names such as `gemini-3.8-flash`, `gemini-3.5-transcribe`, and `gpt-realtime-whisper` are **source configuration facts, not verified available services**. The model-retirement tests check strings/selection against local assumptions; they do not authenticate to provider catalogs. Do not carry these IDs into Faangin without official provider verification and real capability checks. Screen-based requests can be sent to a model that does not support images because the factory has no vision capability registry.

## macOS-first risks

1. **Local Whisper is omitted from normal macOS builds.** `scripts/after-pack.js:31` defaults bundling only archive targets. `darwin-x64` and `darwin-arm64` are source targets; `release.yml` does not opt them in. This contradicts the README's blanket packaged-runtime claim.
2. **Even the opt-in destination is incorrect for the macOS bundle layout.** `after-pack.js:37` writes to `<appOutDir>/resources/whisper-runtime`; the installed electron-builder implementation places macOS resources at `<appOutDir>/cue.app/Contents/Resources`, and `src/whisper-runtime.js` searches `process.resourcesPath/whisper-runtime`. This is a source-confirmed path mismatch; a full macOS packaging run was not attempted.
3. **The macOS source archive checksum is brittle.** Runtime preparation pins the SHA-256 of GitHub's autogenerated tag ZIP. Source/workflow comments acknowledge that recompression can invalidate it; macOS was consequently removed from runtime-smoke CI. Prefer immutable mirrored artifacts or controlled reproducible builds.
4. **System audio and capture privacy conflict.** Code defaults macOS meeting audio off because ScreenCaptureKit capture exposes an OS indicator. The README support table says macOS 14.4+ works; later “under the hood” and troubleshooting paragraphs still call meeting audio Windows-only. Actual compatibility requires testing supported OS/Electron versions and permission transitions.
5. **Native screenshot path has different behavior from Electron fallback.** `screencapture` uses temporary PNG storage and normally unlinks it; the initial subprocess-error branch resolves before cleanup. It does not offer a region/display selector. Fallback explicitly prefers primary display. Screenshots are downscaled to a 1,568-pixel long edge at JPEG quality 70, which can reduce code readability.
6. **No verified capture exclusion guarantee.** The README itself qualifies macOS 15.4+ behavior. Exclusion must be reported as a detected platform capability and validated by share/capture tests, not promised universally.

## Security, reliability, and quality gaps

| Finding | Evidence | Engineering consequence |
|---|---|---|
| Renderer sandbox disabled | `main.js:298`, `main.js:1312`. Context isolation true and Node integration false are useful, but sandbox is explicitly false. | Enable sandbox and audit preload compatibility. |
| No IPC origin/frame authentication | Main handlers accept callers without checking expected window, sender frame, or local document URL. Payload schema/size limits are absent for asks, settings, and PCM. | Central sender validation plus typed runtime schemas and bounded payloads. |
| External URL policy incomplete | `publik:open` allowlists its domain; general `open-pane` passes arbitrary supplied URLs to `shell.openExternal`. No explicit navigation/window-open guards found. | Apply one URL policy and deny new renderer navigation by default. |
| Media permissions broadly granted | Session handlers allow media/screen permission classes without checking requester origin or initiating operation. | Tie grants to trusted app frames and explicit capture state. |
| Credentials plaintext and mostly renderer-visible | `cue-data.json` contains BYOK and managed gateway keys. File modes aim at `0600`; only publik credential is redacted from renderer. Backups retain key material. | OS secret storage and set-only credential IPC. Separate nonsecret settings. |
| Misleading process identity | Main sets `MicrosoftEdgeUpdate`/`Microsoft Edge Update`; `rename-electron.js` alters executable presentation. | Keep honest Faangin identity for maintainability, signing, diagnostics, and portfolio credibility. |
| Settings save failures reported as success | Store catches persistence failure into `lastSaveError`; `settings:set` never checks it before returning. | Preserve dirty state and expose actionable error; verify committed durable write. |
| Meeting persistence weaker than settings | `src/meetings.js:23` bare synchronous overwrite, silent failures, no backup/private mode enforcement. | Crash-safe transactional write and retention/delete semantics. |
| “Transcription disabled” does not stop batch calls | `sttDisabled` is set for errors but not checked in `routeAudio` or `flushChannel`; each flush constructs a new STT factory, losing its instance cooldown. | Make provider backoff an explicit persistent state transition and stop dispatch during cooldown. |
| Timed-out model call keeps running | Foreground/slide watchdogs use `Promise.race`; no AbortSignal reaches provider call. Busy state recovers, upstream request and cost can continue. | Abort transport and enforce per-request IDs across stale tokens. |
| Local inference backlog unbounded | `_enqueue` increments `pendingJobs` and retains a serialized promise chain/PCM closures with no limit. Each utterance is bounded but total queue is not. | Enforce queue duration/bytes budget with visible overload state. |
| System-audio stop/start race | `sysStarting` prevents double start, but stop does not invalidate pending `getDisplayMedia`; late result can retain capture after stop. | Channel generation tokens and track shutdown on stale completion. |
| Background notes differ from foreground gates | Memory catch-up/refresh invokes LLM directly rather than foreground watchdog/billing-card flow. | Shared inference admission, cancellation, cost, consent, and timeout policy. |
| Integration control reports intended state early | `src/applink.js:121` calls async `setCapturing` without awaiting then returns requested state. | Return actual settled state/error and serialize with UI capture transitions. |
| Slide polling can mismatch display and transcript | Hash reads `sources[0]`, screenshot fallback prefers primary; indices refer to a live array that shifts after 200 turns. “Stable” counts changes from last slide without matching candidate frame identity. | Stable selected display, global transcript sequence IDs, candidate-hash debounce. |
| Input/transcript/response growth | Foreground transcript capped, but UI messages, meeting per-session transcript, batch buffer during slow request, and inference queues have no explicit global budgets. | Measure and cap duration/bytes/tokens in long sessions. |
| Prompt/context modules diverge | `src/context.js`, `src/shortcuts.js`, and resume reference helper have tests but are not main orchestration paths. The active interview builder uses different context construction. | One production context compiler with traceable token budgets and data/instruction separation. |

The renderer's simple Markdown formatter escapes text before adding a small fixed tag set, and user bubbles/transcripts use `textContent`; this is a useful existing boundary. Local Whisper uses a random request path, binds `127.0.0.1`, avoids audio files, verifies model artifacts, and serializes inference. App-link prompts deny by default, scopes reads/actions separately, and redacts transcript, profile, and keys from routine state. Preserve these ideas while strengthening identity, payload, and lifecycle checks.

### Dependency and test evidence

`npm audit` of the locked tree returned **18 vulnerable packages: 10 moderate, 8 high, zero critical**. Direct reported packages include `electron` (high), `extract-zip` (high), `electron-builder` (moderate), and `mammoth` (moderate); transitive reports include XML parsing, URI normalization, brace expansion, HTTP caching, YAML parsing, and `undici`. This is a package advisory count, not 18 proven application exploits. Runtime reachability and remediation must be assessed separately. Relevant fetched advisory examples: [Electron context isolation bypass](https://github.com/advisories/GHSA-h7rp-cf8h-j98x), [extract-zip symlink traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv).

Tests cover pure context/prompt selection, settings atomic writes/recovery, model integrity/resume, PCM/WAV, VAD/segmentation, local process supervision with doubles, mocked provider calls, integration sockets/consent, and release configuration. Several renderer/platform regressions assert source text patterns rather than operating a real window or device. CI syntax/tests run Node 18/20/22 despite package engine `>=22.12.0`. CI packages Windows and conditionally smoke-tests native runtime on Windows/Linux; it does not establish a working signed macOS application. `scripts/smoke-quit.cjs` exercises a real Electron quit click but is not wired into ordinary CI. `verify.js` is also separate from `npm test`.

Missing verification: display/permission E2E, actual macOS runtime bundle loading, microphone/loopback fixture ingestion, local real inference, live provider catalog/contract checks, word-error-rate corpus, capture exclusion platform matrix, long-session memory/latency/cost measurements, suspend/resume and hotplug, accessibility keyboard/screen-reader audit, and release signing/notarization verification.

## License and reuse decision

`package.json` declares `GPL-3.0-or-later`; root `LICENSE` supplies GPLv3. Its sections 4–6 establish notice, modified-work, licensing, and corresponding-source requirements for conveying covered code. **Choose explicitly before copying:** either Faangin becomes a compliant GPL derivative with upstream notices, modification attribution, and distribution source, or it is independently implemented from observed behavior and architectural lessons. This audit recommends independent implementation for the currently open project scope; no license for Cluely/InterviewCoder proprietary source/assets is established by public website access.

`whisper.cpp`'s included license is MIT; direct upstream integration is a separate available route with its notice preserved. The vendored `@publik/app-link` directory identifies its upstream commit but carries no separate LICENSE file in this checkout; do not infer permissive rights or copy it independently based on that metadata. Resolve upstream licensing first. Do not reuse publication secrets, provisioned user keys, trademark identity, UI screenshots/assets, or proprietary gateway contracts.

## Implementation lessons for Faangin

1. Keep screen, microphone, and system audio separate through capture, transcript, context compilation, and retention. Define one capture state machine whose settled state controls both UI and devices.
2. Build a macOS permission/capture/runtime packaging proof first. Include selected display, remote speaker track, restart after permission change, mixed-DPI movement, suspend/resume, and signed-bundle identity in acceptance checks.
3. Adopt one provider contract with capability metadata, cancellation, usage, first-token timings, backoff, and bounded retry. Use current official model verification before choosing defaults.
4. Implement durable sessions and explicit review/delete/export UI together. A hidden backend module does not satisfy a product requirement.
5. Separate OS-protected secrets from settings and constrain renderer IPC from day one. Preserve safe text rendering.
6. Use immutable native-runtime assets, package platform-correct resource paths, and test the installed bundle rather than only build configuration.
7. Specify measurable quality gates: transcription accuracy, end-of-question latency, time to first answer token, failure recovery, peak queue size, CPU/memory, and provider cost. Cue source supplies no audited product SLOs.
8. Treat capture exclusion as conditional OS behavior. Present supported/capture-visible states truthfully and keep application identity accurate.
9. Maintain honest professional repository artifacts: clear project authorship, source attribution where required, architecture decisions, verifiable tests, and original branding. Removing attribution or fabricating development history would undermine portfolio credibility.

## Permanent source index

All links are pinned to the audited SHA:

- [Package and license declaration](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/package.json); [GPL license text](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/LICENSE).
- [Main window/capture/IPC/lifecycle orchestration](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/main.js); [preload API](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/preload.js).
- [Current UI controls](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/renderer/index.html); [renderer capture and input behavior](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/renderer/renderer.js).
- [Answer modes](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/prompts.js); [active interview context](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/interview-context.js); [provider routing](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/llm.js).
- [Batch speech factory](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/stt.js); [streaming speech factory](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/stt-streaming.js); [screen capture](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/screen.js).
- [Local inference queue](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/local-whisper-transcriber.js); [sidecar supervision](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/whisper-server-session.js); [model integrity/downloads](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/whisper-model-manager.js).
- [Settings store](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/store.js); [atomic settings mechanics](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/settings-store-core.js); [meeting store](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/meetings.js); [meeting memory](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/meeting-memory.js).
- [Slide logic](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/slides.js); [app-link integration](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/applink.js); [vendored trust boundary](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/vendor/app-link/lib/server.js).
- [Build configuration](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/electron-builder.cjs); [runtime after-pack hook](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/scripts/after-pack.js); [runtime lookup](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/src/whisper-runtime.js); [CI](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/.github/workflows/ci.yml); [release workflow](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/.github/workflows/release.yml).
