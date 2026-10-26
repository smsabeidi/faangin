# Build verification record

Updated: October 25, 2026 · Latest 0.4.2 permission-first setup; historical records preserved

## Permission-first setup 0.4.2

The first screen now requires microphone, screen, and independently verified computer-audio access before workspace/overlay use. It guides OS approval, rechecks status automatically, preserves progress, and configures inputs without starting listening. Screen-share privacy is a separate explicit choice with an honest platform caveat. Historical audio receipts do not manufacture current permission: completed setup authorizes one bounded no-sample capability recheck on a later launch. See [permission-first behavior](../design/access-setup-042.md).

**614 tests pass**, with successful typecheck and production build. The exact packaged app passes 13 access-setup QA groups, 12 native overlay layout groups, and the 21-request localhost workflow. Access QA covers fresh-install gating, 25 backend/shortcut guard checks, independent permission states, silent status polling, denial/timeout cleanup, configuration without automatic recording, revocation, restart, and the single prior-consent startup check. Recovery instructions and Retry are visible at 900×550. Native resizing and the original oversized-window regression remain covered.

The tested app archive SHA-256 is `7b10b56161a70489cd6f0bf463fe9e79688a62c6938c1e93a119f5e03384324f`. The verified installer is `dist/access-setup-042/Faangin-0.4.2-arm64.dmg`, also copied directly to the user's Desktop. Reports, checksums, and source/artifact provenance accompany the package. These checks use explicit isolated permission fixtures; the host's real OS permission dialogs and physical OS pointer routing were not exercised, and no live provider calls or recordings were made.

After explicit user authorization, the running 0.4.1 app was closed and backed up, and the verified 0.4.2 app was installed and launched from `/Applications/Faangin.app`. Its running process and archive hash were confirmed. OS permissions and access completion were left for the user to approve in the new setup screen. Settings, session storage, and credentials were not erased. This remains an unsigned local build; Apple Developer signing/notarization and public distribution remain separate gates.

## Native overlay repair 0.4.1

The reported full-screen overlay came from saved 1512×949 native bounds on a smaller work area. The running process was also an older 0.3.0 candidate, despite the installed 0.4.0 app. The [repair](../design/overlay-041.md) adds overlay-specific restoration and size limits, a visible native resize grip, keyboard sizing, Compact/Comfortable presets, and reset entry points in More, Settings, and the native menu. Current version appears in the native menu and tray tooltip.

**602 tests pass.** Typecheck and production build pass. The final packaged 0.4.1 app passes the 21-request localhost workflow and 12 native layout checks across four launches. Native checks include actual bounds/min/max/resizability/full-screen flags, the exact reported dimensions, an oversized height preference, disconnected-display saved geometry, trusted renderer pointer resizing, keyboard increments, all reset entry points, 54 px collapse, and saved size after full restart. No viewport emulation is used. Physical OS edge hit-testing, physical monitor changes, live provider calls, and recorded audio are outside this fixture evidence.

The exact tested archive SHA-256 is `95592070992ae42e9fc41b9ac69b913c10046ffd6f61dd79f7f5c4a6baba1f09`. The local package is `dist/overlay-repair-041/Faangin-0.4.1-arm64.dmg`; native results are in `output/qa/overlay-layout/report.json`. The verified app was installed at `/Applications/Faangin.app`, with the prior installed version backed up under `dist/installation-backup/`. After explicit user authorization, the legacy 0.3.0 process was stopped, readable background opacity was set to 94%, and the installed 0.4.1 process was launched and verified at `/Applications/Faangin.app/Contents/MacOS/Faangin`. The restart receipt is saved with verification records. Other saved preferences were compared and left unchanged.

This remains an unsigned local build. Signed-release preflight was run and stopped because the Apple Developer signing identity and team configuration are missing. No notarized public release or deployment is claimed.

## Onboarding and overlay redesign 0.4.0

The restored working copy at `/Users/admin/Desktop/faangin` now contains a four-step setup guide, explicit native permission requests, persisted setup progress, Settings replay, readable compact overlay controls, and coordinated workspace styling. The original relocated source at `/Users/admin/Documents/desk/faangin` was preserved. See the [design and setup behavior](../design/onboarding-040.md).

Verification passed: **595 tests, zero failures**, TypeScript and production build, plus 16 desktop UX checks covering both themes, 900×550 and 1000×650 setup layouts, 360×550 and 480×560 overlays, keyboard focus/navigation, accurate permission badges, restart persistence, true 0% opacity, and native 54 px collapse. Fifteen renderer screenshots and the full report are saved under `output/qa/onboarding/`.

The **packaged 0.4.0 app** passed the existing 21-request isolated localhost workflow, including source ownership, streaming, cancellation, interview continuity, saved answers and restart. Its main, preload and renderer entry files were compared with the verified build. These runs used disposable profiles without real credentials or recorded audio. First-time native permission approval itself was not exercised; its routing has unit coverage.

The local Apple Silicon installer is `dist/onboarding-040/Faangin-0.4.0-arm64.dmg`, alongside `mac-arm64/Faangin.app`. This is an unsigned local build. It has not been published or notarized. Finished-artifact hashes, build provenance and verification records are stored with the installer. Existing installed applications and user workspace data were not replaced.

The latest [0.3.0 hands-free record](#hands-free-interview-candidate-030) follows the historical checkpoints below.

The following records and exact hashes describe preserved 0.2.0, [0.2.1 latency](#latency-candidate-021), [0.2.2 manual spoken-question](#spoken-question-candidate-022), and later interview artifacts. The [0.2.3 Live suggestions checkpoint](#live-suggestions-candidate-023) is historical. Reference-product research remains separate evidence. No checkpoint certifies a signed production release or exact commercial parity.

## Environment

- macOS 26.6.1, Apple Silicon
- Node.js 26.7.0 for development
- Electron 44.7.0 with bundled Node.js 24.21.0
- React 19.3.0, TypeScript 7.0.2, Vite 7.3.7, electron-vite 5.0.0
- OpenAI Responses and Realtime transcription; separately configured compatible Chat Completions

## Verification checkpoint

| Check | Result | Evidence and scope |
| --- | --- | --- |
| Regression suite | 313 passed; 0 failed; 0 skipped | Final integrated `npm test`, including nested CommonMark definitions, region consent/leases/pixel mapping, draft snapshots and text-only routing, plus SQLite recovery/data controls, imports, capture lifecycle, prompts, presets, memory, filters, diagnostics, streaming and release tooling |
| Strict TypeScript and production build | Passed | Final `npm run build` includes `npm run typecheck`; main, sandboxed preload, workspace, capture, and document surfaces |
| macOS acceptance packaging | Passed, exit 0 | Final app reports version 0.2.0; DMG and ZIP in `dist/candidate`; Apple Silicon artifacts, separate from the previous running build. Executable is ad hoc/linker-signed with no Developer ID team or sealed-resource signature; this is not a signed/notarized release |
| Packaged integration smoke | Passed, exit 0 | `/private/tmp/faangin-final-candidate-smoke.log`; final packaged preload/IPC, sandbox/context isolation, SQLite, imports, brief, opacity, capture cleanup, presets, reset/Trash/permanent delete, private history and restart |
| Provider transport | Final packaged fixture smoke passed | Five controlled localhost requests including source-linked Draft and persisted source snapshots across restart; earlier packaged Fast/Smart routing, selected-memory, cancellation and safe quota checks also passed. No commercial-provider request |
| Region image/pixel behavior | Generated Retina canonical-pixel fixture passed | Native image normalization and crop use the same encoded pixel grid; source consent, sender/session/epoch/topology, expiry and one-shot commit have fixtures. No physical screen/Retina/mixed-DPI capture is certified |
| Source-linked draft behavior | Implemented; source fixtures and local transport smoke passed | Finalized-only bounded evidence, exact admitted passage snapshots, source dialog, reopen/reset, independent notes, action/prompt retry, text-only model routing and copied/exported CommonMark citation handling |
| Draft/Notes render fixture | Passed in a hidden isolated renderer | Drafts, separate Notes controls and a T1 source modal rendered correctly; this is not visible-compositor or physical click acceptance |
| Native workspace acceptance | Passed for the checked flows | An isolated app with a unique bundle identity saved an interview brief and selected preset; settings accepted and saved 0% overlay opacity |
| Native overlay geometry | Passed for collapse/expand | Collapsed to 480 × 54 DIP and expanded to 480 × 700 DIP; physical monitor/full-screen/device matrices remain pending |
| Native document extraction | Passed | Real PDF/DOCX fixtures parsed through separate sandboxed renderer processes |
| Packaged permission/security metadata | Passed | Microphone, screen and system-audio usage descriptions; sandboxed/context-isolated surfaces and no main-world Node access |
| Runtime dependency audit | 0 reported vulnerabilities | Latest `npm audit --omit=dev`; this statement covers runtime dependencies, not the full development/build graph |
| Signed macOS release tooling | Configuration and fixture checks passed | Separate `release:mac` credential preflight, signing/notarization verification and checksum rules; real Apple signing/notarization has not run |
| Native draft/notes interaction | Accessibility state observed; final visuals pending | Isolated native accessibility checks observed two saved fixture drafts, a source dialog and separate Notes controls. ScreenCaptureKit captures disagreed with the current accessibility state; they are not final visual acceptance |
| Native appearance evidence | Historical captures retained; final visuals pending | Earlier workspace and collapsed-overlay captures do not certify the final region/draft UI or transparency over another app |

No live provider request or physical microphone/system-audio recording was performed for these checks. The user subsequently reports entering a replacement credential in Settings; its saved state, account access and quota were not independently verified. No credential supplied in chat was saved or used by the engineering checks. Apple Developer ID and notarization credentials remain unavailable; packaging does not waive that release gate. Isolated native accessibility inspection was performed earlier. The final 0.2.0 computer-control attempt reported that the Mac was locked and automatic unlock failed; native screenshot/click discrepancies and the remaining device/provider matrix prevent complete native acceptance.

The fixture suite verifies transport and lifecycle behavior under controlled conditions. It does not measure real provider latency, speech accuracy, interview-answer quality, physical audio output, or screen-share protection in another application. Cancellation closes a real local HTTP connection and rejects late output. Capture/transcription fixtures cover reordered finals, duplicates, pending-start revocation, Stop/drain deadlines, independent source disposal, sleep/device/idle policy, and incomplete transcript notices.

## Data and context controls

History opt-out is implemented. With history off, new sessions and subsequent active-session writes stay in RAM, while previously saved snapshots remain intact. Turning history on does not promote an existing RAM session into durable history. Preferences and presets remain durable. Tests and packaged restart checks verify the separation.

Prior-session context is explicitly searched, selected, edited and removed. Selection retains the approved excerpt, applies limits to the final edited text, and checks new source attribution. Request admission rechecks saved sources. Searching does not add context automatically. Credentials are separate by provider and compatible credentials are bound to the saved exact endpoint.

Region capture first creates a local preview; it does not select an attachment or send the preview to a provider. The full preview is held temporarily in RAM. A bounded two-minute lease belongs to the requesting window, session and context epoch; confirmed display changes invalidate the lease. Drag or numeric bounds use preview-image pixels. A successful commit consumes the lease and adds only the chosen crop. Cancel, expiry, reset and window disposal discard preview data. Generated Retina-image testing verifies the shared canonical pixel grid, not a physical compositor or multi-monitor setup.

Follow-up drafts receive only finalized same-session transcript passages within the request budget. Provisional speech, selected images, notes, profile/job context, prior answers and selected prior-session memory are excluded. Application-owned labels link to the exact included snapshots, which can be shorter than the full source turn. Saved snapshots survive restart with their answer; reset removes them. The source modal displays plain passage text, capture channel and time; a channel does not identify a speaker. Copy/Markdown export rewrite actual CommonMark links and reference definitions to distinct source anchors, preserve code examples and mark unknown sources unavailable. Drafts do not overwrite notes or send a message. Retries retain their action and original wording. These transcript sources do not satisfy the separate web-research/citations requirement.

Trash and restore remain separate from permanent deletion. Permanent deletion cascades session content and clears app-owned RAM content; a busy database checkpoint is reported. User exports, OS backups and storage-device remnants are outside app deletion. Diagnostic export contains allowlisted metadata and bounded timing/error summaries, with no keys, transcript/profile text, screenshots, device names or personal file paths.

## Appearance evidence

The workspace uses Apple-blue glass styling, native macOS vibrancy where appropriate, and custom renderer surfaces. The overlay has a 0–100% background-tint preference with a 35% new-install default; text remains opaque and the native opaque HUD backing is removed. This does not claim native `NSGlassEffectView` refraction. Reduce Transparency, Reduce Motion and Increase Contrast have integration/fixture coverage; the full manual accessibility and VoiceOver matrix remains pending.

Historical native evidence is stored in [interview context](../assets/interview-context-v020.png) and [collapsed overlay](../assets/overlay-collapsed-v020.png). These captures came from earlier isolated QA and do not establish final region/draft visual acceptance. Accessibility inspection observed saved fixture drafts, source-dialog text and Notes controls, while ScreenCaptureKit images and click behavior did not consistently reflect that state. The final computer-control attempt reported a locked Mac and could not unlock it. Complete visible interaction after unlocking and resolve the capture discrepancy before accepting final screenshots. Verify the clear overlay over bright and dark applications at 0%, 35% and 100%; screenshot flattening alone cannot establish the actual backdrop or contrast. See [Desktop appearance](design-system.md).

## Scope and remaining gates

The [PRD](../prd.md) remains the scope contract. The [requirement ledger](feature-status.md) distinguishes implemented flows from acceptance gaps. Region capture and source-linked drafts have passed final integrated tests, build and packaged fixture smoke. Final D0 acceptance still requires physical capture, resolved native screenshot/click evidence, the finite device/provider/language matrix, fresh-install demonstration, representative model/audio evaluation, resource benchmarks and accessibility checks.

D1 remains in scope: Windows certification, bundled local speech, expanded provider coverage, explicit research/citations, slide tracking, local integrations, managed inference, accounts/device sessions, hosted sharing/sync, calendar preparation, billing/entitlements, mobile, original preparation/web utilities, referral operations and safe updates/version surfaces. A local compatible chat server does not establish bundled offline transcription or completion of this backlog.

Exact commercial-product parity requires versioned native reference observations and feature-specific measurements. Public research and Faangin’s own fixtures do not establish private routing, complete operational equivalence or absolute invisibility.

## Local artifacts and handoff

| Artifact | Location |
| --- | --- |
| Application bundle | `dist/candidate/mac-arm64/Faangin.app` |
| DMG | `dist/candidate/Faangin-0.2.0-arm64.dmg` · 133,748,496 bytes |
| ZIP | `dist/candidate/Faangin-0.2.0-arm64-mac.zip` · 133,181,078 bytes |
| Finished-artifact manifest | `dist/candidate/SHA256SUMS` |
| Build provenance and verification | `dist/candidate/BUILD-MANIFEST.json` and `dist/candidate/verification/` |

The final region/draft package and smoke exited 0, and `SHA256SUMS` was rewritten for the finished DMG/ZIP. Their SHA-256 values are:

```text
70ebf23746bad13563464e89851c4293567c9e336e837952fb1d0bdf1101a1b6  Faangin-0.2.0-arm64.dmg
a2ca0cd54e749d529bf4223aa4d3b60342008e368226fb52cbfb06ab952b358a  Faangin-0.2.0-arm64-mac.zip
```

The manifest belongs to these packaged bytes, not later source edits; rebuild and refresh it if application source changes. The signed-release path remains separate at `dist/release-mac` and has not run with real Apple credentials. No public GitHub release or deployment is recorded by this verification checkpoint.

The local build manifest records the application input hash, artifact sizes/hashes and the limits of the checks. The verification directory retains regression/build/package/smoke logs, the runtime audit and explicitly labelled hidden-renderer images. These local artifacts are excluded from Git; the images are not physical-screen acceptance evidence.

See [Release readiness](release-readiness.md) for acceptance steps, signed-release setup and production gates.

## Latency candidate 0.2.1

The latency candidate uses separate output at `dist/latency-candidate`, preserving the historical 0.2.0 bundle, its manifest and the running app. The final source suite passed **334 tests, 0 failed, 0 skipped**. Typecheck/production build, candidate packaging and final packaged smoke passed with exit 0. The app reports version 0.2.1. Finished DMG/ZIP checksums, build provenance and four verification logs were saved with this candidate.

The change reuses the admitted compiled prompt for OpenAI, emits a narrow persisted `answer-started` before text, avoids a duplicate request-time full-state refresh and replaces full session reloads inside answer saves with an active-session epoch lookup. Fast interview prompts lead with useful text while retaining their saved sources, models, context budgets and required details. First non-whitespace text updates immediately; later updates share a frame with a nominal 32 ms fallback. Cancellation, completion, reset, session changes and Strict Mode cleanup guard pending delivery. Unchanged answer bodies and citation metadata reuse memoized work.

`firstTokenMs` now begins at main-process request entry and includes preparation through first accepted non-whitespace text. It excludes earlier UI IPC and later renderer/physical paint. Terminal duration also precedes the final save/emission. The 0.2.0 timing origin omitted some preparation, so its numbers are not directly comparable. No real cloud latency, visible-paint benchmark or quantified speedup was measured; nanosecond-scale cloud responses are not promised.

The final packaged smoke at `/private/tmp/faangin-latency-packaged-smoke.log` verified narrow admission before first delta, the actual workspace DOM’s first Markdown text, five controlled localhost requests and persisted draft sources across restart. It establishes the final compiled source, including leading-whitespace handling; an earlier source smoke ran before that last correction. Hidden renderer evidence does not certify physical pixels. The user reports saving a replacement key, but no independent credential access test or live inference was run. Models, preferences and credentials were not changed by the latency work.

| Artifact | Final 0.2.1 evidence |
| --- | --- |
| Application bundle | `dist/latency-candidate/mac-arm64/Faangin.app` · bundle version 0.2.1 |
| DMG | `dist/latency-candidate/Faangin-0.2.1-arm64.dmg` · 133,760,542 bytes |
| ZIP | `dist/latency-candidate/Faangin-0.2.1-arm64-mac.zip` · 133,182,726 bytes |
| Checksums | `dist/latency-candidate/SHA256SUMS` |
| Provenance and logs | `dist/latency-candidate/BUILD-MANIFEST.json` and `dist/latency-candidate/verification/` |

```text
ab5d3a8cc38db74b7a39e179e0c46ce0fb4c0ac1cd70483d49ede1711cd4bf87  Faangin-0.2.1-arm64.dmg
9b99ad76b9bb4c2cb803ce6f244b621a60d336aaeaa3d22206e0d83044492ab5  Faangin-0.2.1-arm64-mac.zip
```

The recorded application input hash is `aad6c3cfb33653dc15cbf64832952700b44495d55adb6381d726c4509e80bc4e`, covering source, resources, configuration, package metadata and lockfile. These hashes identify the completed 0.2.1 artifact bytes and do not replace the preserved 0.2.0 hashes above. This local candidate is not a Developer ID signed/notarized release.

See [latency implementation and manual measurement](latency.md) for exact measurement boundaries and acceptance steps. Signing, real providers/audio, native physical acceptance, Windows and full D1 parity remain open.

## Spoken-question candidate 0.2.2

October 13, 2026. The user reported working screenshot capture/Solve and no response to a spoken interviewer question. A read-only metadata snapshot showed microphone enabled, system audio disabled, and seven microphone/zero system turns in the latest saved transcript. Transcript text and credentials were not read; primary settings were not changed, and no real audio/provider call was performed. This supports checking source selection, but does not prove a hardware/transcription diagnosis.

The UI now exposes manual Reply in Meeting, Interview, the expanded overlay and Conversation; Conversation Reply opens Assistance from other session tabs. It accepts nonblank finalized/manual text or active current-session provisional speech, with busy/working guards. Listening and screenshot controls are labelled separately. Empty-composer local ⌘/Ctrl+Enter fallback requests Assist, preserving typed Ask, Shift/Solve and native-shortcut ownership. Automatic generation is not implemented and was not added.

Per-source audio diagnostics now report conditional low level after more than eight seconds without three consecutive frames at the existing .015 admission-level energy, when frames are current and energy above .003 was observed within the last eight seconds. Three adequate frames recover Listening. Silence/no-frame health stays separate; the header recognizes low-level capture as an active source. VAD admission, providers, permissions and audio dispatch are unchanged. Energy/status alone is not recognized speech.

The full source suite passed **343 tests, 0 failed, 0 skipped**, including four new composer and five audio-health regressions. Typecheck/production build, separate candidate packaging and final packaged smoke passed with exit 0. The app reports version 0.2.2. Output is separate at `dist/spoken-candidate`, retaining the 0.2.0/0.2.1 artifacts and exact historical hashes above.

Source smoke exited 0 at `/private/tmp/faangin-spoken-source-smoke.log`; the final packaged smoke exited 0 at `/private/tmp/faangin-spoken-packaged-smoke.log`. Each makes six localhost fixture requests. The sixth appends the public manual question “What is binary search?” and clicks the actual Interview Conversation Reply button in an isolated hidden renderer, with empty composer/no images. The main API dispatched `/reply` with that sole transcript context and rendered the answer. Other paths retain draft sources across restart. This checks explicit UI→request→saved response context and rendering, not real captured speech, physical audio routing or model quality.

| Artifact | Final 0.2.2 evidence |
| --- | --- |
| Application bundle | `dist/spoken-candidate/mac-arm64/Faangin.app` · bundle version 0.2.2 |
| DMG | `dist/spoken-candidate/Faangin-0.2.2-arm64.dmg` · 133,758,777 bytes |
| ZIP | `dist/spoken-candidate/Faangin-0.2.2-arm64-mac.zip` · 133,183,728 bytes |
| Checksums | `dist/spoken-candidate/SHA256SUMS` |
| Provenance and logs | `dist/spoken-candidate/BUILD-MANIFEST.json` and `dist/spoken-candidate/verification/` |

```text
897e36931db276b79282460cca76949b8aa82e04900422dc45a4cdbe307bafe7  Faangin-0.2.2-arm64.dmg
a3e2dd4fb007c94301147d648c038cb1d6e493ee736163f3ca87cf88004588ec  Faangin-0.2.2-arm64-mac.zip
```

The recorded application input hash is `ffe425b7a0a3f35370e2edd2647124aeb6209ac8bb3bc469e86d9cd77bf6b035`. Finished checksums, build provenance and four verification logs identify this frozen 0.2.2 source/artifact checkpoint. They do not replace historical 0.2.0/0.2.1 hashes. The candidate is not a Developer ID signed/notarized release.

Before switching to this bundle, save/export needed data, including RAM-only sessions, and quit the prior instance; a second normal instance focuses the already-running app. System audio must be enabled/saved deliberately by the user, then listening started and Reply requested. Engineering did not change primary settings or record/call a live provider. See [spoken-question usage](spoken-questions.md). Signed distribution, native physical/audio/provider acceptance, Windows and complete parity remain open.

## Live suggestions candidate 0.2.3

Live suggestions is an explicitly enabled automatic Reply mode, off by default with System audio as the default trigger source. Microphone can be selected for speech in the room. Source labels identify inputs, not speakers. The mode admits finalized selected-source text containing letters/numbers, including statements/follow-ups, without a question classifier. A nominal 350 ms coalescing interval, three-second start spacing, six starts per rolling 60 seconds, one active request and one latest pending target bound automatic work. Continuing partial speech defers dispatch.

Requests use finalized context frozen at the target and no images; permitted bounded profile/job/notes/brief, opted-in history and selected memory can remain included. Disable/Stop/pause/sleep/source failure/session change/reset/key removal and relevant provider/settings changes abort automatic work. Manual actions take priority and preserve the failure pause. Provider failure requires explicit toggle/reconfiguration/new capture to recover; no automatic retry is performed. Cards/status identify automatic origin and reasons. Composer text, focus and dirty editor drafts are preserved.

The final integrated checkpoint passed **385 tests, 0 failed, 0 skipped**, with typecheck/production build passing after the failure-pause correction. Logs are `/private/tmp/faangin-live-tests.log` and `/private/tmp/faangin-live-build.log`. An earlier seven-request source smoke passed at `/private/tmp/faangin-live-source-smoke.log`; it predates the final failure-pause correction and the expanded nine-request fixture. The final nine-request smoke was **not executed**: Codex automatic approval review failed because the account usage limit was reached. This is a review-capacity rejection, not a determination that the action was unsafe. No review bypass or paid/live substitute test was performed.

No 0.2.3 application bundle or installer has been produced. `dist/live-candidate` is planned output only; packaging, final source/packaged smoke and finished checksums remain pending. The latest verified installer is preserved 0.2.2 in `dist/spoken-candidate` with the exact hashes recorded above. The automatic fixture goes through the same final-ingestion callback using public text proxies and localhost responses, not microphone/loopback audio. Primary settings/keys were not changed and no live paid calls or recordings were performed. Resume the final nine-request smoke and separate packaging once approval review is available, then record the actual finished bytes and packaged results.

The [actual Rea static client investigation](../research/rea-live-suggestions.md) is separate versioned research with partial coverage and unknown hosted internals. It informed the distinction between live insights and requested answers; Faangin’s trigger, limits and recovery policy are its own implementation. This checkpoint does not prove private backend recovery, physical speech accuracy, production release readiness or 100% commercial parity. Historical 0.2.0/0.2.1/0.2.2 hashes and evidence remain unchanged.


## Interview reliability candidate 0.2.4

October 16, 2026. The latest desktop interview candidate is available separately in `dist/interview-candidate`; earlier candidates are preserved. See [workflow and engineering changes](interview-reliability.md).

| Check | Result | Scope |
| --- | --- | --- |
| Final regression suite | **427 passed; 0 failed; 0 skipped** | Capture readiness/cleanup, quiet speech, source fallback, flush/Stop finalization, stale context, screenshot and audio-only follow-up continuity, concurrent operations, drafts, storage, transport and existing controls |
| TypeScript and production build | Passed | Final `npm run build`, including typecheck, all Electron surfaces and assets |
| Source desktop smoke | Passed | **13 localhost fixture requests**, actual Solve selected and Answer follow-up buttons, selected image admission, manual/automatic BFS/DFS context with history off, audio-only continuation, source/partial/duplicate/disable/Stop/failure controls and restart persistence |
| Packaged desktop smoke | Passed | Same 13-request flow using `dist/interview-candidate/mac-arm64/Faangin.app`; expanded overlay has capture/listen/follow-up/source/automatic controls |
| Responsive layout | Passed | Renderer geometry at 1280 × 808, 1000 × 650 and 900 × 550; main page fits horizontally, answer space remains usable, short workspaces scroll internally |
| Visual fixture | Inspected and accepted | [Packaged interview screenshot](../assets/interview-workflow-v024.png): readable complete follow-up, explicit source controls, compact composer and expandable unselected images |
| macOS packaging | Passed | Apple Silicon app, DMG and ZIP; version 0.2.4, local development build, Developer ID signing skipped by configuration |
| Bundle/source correspondence | Passed | All **12 generated output files** in app.asar match the final tested `out` files byte for byte; packaged manifest version checked |
| Real audio/provider check | **Pending** | The saved OpenAI connection was detected by file presence only. Reuse confirmation was requested; no key was decrypted, no paid call made and no physical microphone/system recording performed |

Saved evidence in `dist/interview-candidate`: `tests.log`, `build.log`, `package.log`, `source-smoke.log`, `packaged-smoke.log`, `SHA256SUMS`, and `build-provenance.json` with per-file source hashes. The source snapshot is the uncommitted workspace; no Git revision is claimed.

Source fingerprint SHA-256: `cfb26be6579d72f91f5a992d7b96ed19baa20877f80d21fd629bacb0ab6f1d61`.

| Artifact | SHA-256 |
| --- | --- |
| `Faangin-0.2.4-arm64.dmg` | `874b549973a62611e2ee5fd0da0490a59439f893c6af1a49f4f5f6ae49cf07ba` |
| `Faangin-0.2.4-arm64-mac.zip` | `4d60b22672c08ac592a46b8f066b8cacf8a2782e8781450bdd781fb94acb5de2` |
| `mac-arm64/Faangin.app/Contents/Resources/app.asar` | `df02c34d9e33cba3e76fcb9da78beddfa64200af7607c07200f3812f56671c10` |

Save/export any RAM-only work and quit the previous Faangin instance before opening 0.2.4; otherwise the single-instance lock focuses the running older app. The isolated checks never modify the primary app's settings, credentials or sessions. Physical audio, real answer quality and latency, conferencing/headset compatibility, Apple signing/notarization, and Windows remain unverified. The fixture source image/text and local responses do not certify those properties.


## Interview context candidate 0.2.5

October 16, 2026. Available in `dist/context-candidate`; 0.2.4 and earlier artifacts remain separate. See [interruption and context behavior](interview-context.md).

| Check | Result | Scope |
| --- | --- | --- |
| Full regression suite | **473 passed; zero failed/skipped** | Interruption ownership/races, source ordering and duplicates, pending preparation Stop/session revocation, shortcut takeover, complete baselines, interrupted drafts/retirement, scenario evidence, domain guidance, and existing audio/storage/transport controls |
| TypeScript and production build | Passed | Final 0.2.5 main/preload/renderer/capture/document outputs |
| Source desktop workflow | **17 fixture requests passed** | Actual Solve and Answer latest controls; real localhost streams aborted on finalized manual scenario changes and new automatic partial speech; no replacement from unfinished speech; no automatic calls while disabled; updated context contains complete baseline and labelled interrupted draft |
| Packaged desktop workflow | **17 fixture requests passed** | Same checks against the finished 0.2.5 app, three responsive viewports, expanded overlay controls, app restart, preserved interrupted code/reasons, baseline snapshots and interrupted-draft source IDs |
| macOS packaging | Passed | Apple Silicon app, DMG and ZIP; local unsigned development candidate |
| Bundle correspondence | Passed | All 12 generated output files match final tested files byte for byte; packaged manifest is 0.2.5 |
| Visual inspection | Passed for fixture view | [0.2.5 interview preview](../assets/interview-context-v025.png) shows latest updated-scenario response, current-answer badge, source controls, transcript and compact composer without overlap |
| Live model/audio evaluation | **Pending** | No real provider calls, key decryption or physical microphone/system-audio recording; earlier request to reuse the saved connection remains unanswered |

Five verification logs, `SHA256SUMS`, and per-file `build-provenance.json` are saved in `dist/context-candidate`. Source is an uncommitted workspace snapshot. Fingerprint SHA-256: `d441c899a33e5c1684466fcd0236d0258f0e5729251a98ce75d27213b687ede2`.

| Artifact | SHA-256 |
| --- | --- |
| `Faangin-0.2.5-arm64.dmg` | `6b2c664a64aed50f56cb2e453d5b62a4aaae136590f9ff0197efc1ac3cda6479` |
| `Faangin-0.2.5-arm64-mac.zip` | `94ea2bd04d7c210d0efd257e202e9929dcdff7c6f953cf42493fe819684e2796` |
| `mac-arm64/Faangin.app/Contents/Resources/app.asar` | `d061f2b1f7a31ced4ec0c7c21e255869d958274de37460aa05ea5f04975b586b` |

Quit the older Faangin instance before opening 0.2.5; save/export needed RAM-only work first. Engineering checks use disposable storage and synthetic source text/images, leaving primary app settings, sessions and credentials untouched. These fixtures verify state, context contents, transport cancellation and persistence. They do not certify real semantic correctness, speech quality, cloud latency, every scenario, or research-lab quality. Apple signing/notarization and Windows remain separate acceptance gates.

## Audio permission candidate 0.2.6

October 16, 2026. Available in `dist/audio-permission-candidate`. The app at the normal launch path, `dist/mac-arm64/Faangin.app`, was updated from 0.1.0 to these exact 0.2.6 bytes and reopened. The visible version is 0.2.6 and all 15 saved sessions remain listed. Failed capture was stopped before quitting. The previous app and a local SQLite checkpoint are preserved under ignored `dist/previous-launch`; their contents are private and are not release artifacts. No OS permission toggle was changed, and listening remains off until the user starts it.

The confirmed app-side cause and the bounded test design are described in [audio permission behavior](audio-permissions.md). The chosen question source now controls listening indicators; a healthy microphone no longer masks failed computer audio. Recovery guidance distinguishes blocked capture from proven OS denial and handles access already enabled.

| Check | Result | Scope |
| --- | --- | --- |
| Regression suite | **485 passed; zero failed/skipped** | Legacy empty-array and modern display permissions, active ownership/revocation, camera denial, microphone capture, granted-permission recovery, chosen-source health and previous interview/audio/storage checks |
| TypeScript and production build | Passed | Final main/preload/workspace/capture/document outputs |
| Source desktop workflow | **17 fixture requests passed** | Actual Electron display permission callback reaches the owned capture handler; deliberate source-selection denial opens no OS stream; prior interruption, code/design scenario, transport and restart checks |
| Final packaged workflow | **17 fixture requests passed** | Same interview workflow, three responsive viewports, expanded overlay, restart/persistence, and the opt-in native check below |
| Native system-audio stream | **Passed availability/cleanup** | Production display source selected; macOS reports screen access granted; one live audio track; running 48 kHz AudioContext; one second of analysis; video immediately stopped; all tracks ended and context closed |
| Playback/speech signal | **Unverified** | Peak RMS was zero; sampling counters measure analyser reads, not independently verified incoming PCM frames. No recognized-speech or conferencing-route claim |
| Packaging and launch correspondence | Passed | Apple Silicon app, DMG and ZIP; all 12 generated output files match the bundle byte for byte; launch copy matches candidate `app.asar` |
| Live provider/model evaluation | **Pending** | No saved key decrypted, no real provider calls; interview responses are synthetic localhost fixtures |

An initial native acquisition attempt failed with a generic `Error` before obtaining a stream. A repeat on the same binary passed without changing OS permissions. The final binary adds explicit stage/timeout/source-selection diagnostics and passed its native check. The transient cause was not established; success does not certify every cold start or device configuration. Default smoke still opens no stream. The native opt-in retains no audio, consumes no screen pixels and reports no device labels/IDs.

Five final verification logs, the initial native-failure log, `SHA256SUMS`, and `build-provenance.json` are saved in `dist/audio-permission-candidate`. [Fixture preview](../assets/interview-permission-v026.png) was visually inspected. The source is an uncommitted workspace snapshot. Source fingerprint SHA-256: `a2e726291c4d5f37464789afda7eef9bfcab81e6b7c692f0570c65b361438f24`.

| Artifact | SHA-256 |
| --- | --- |
| `Faangin-0.2.6-arm64.dmg` | `8147285287dc864f5528639a9fd136a968f30b5cbd8575fcf85425bddfd9e629` |
| `Faangin-0.2.6-arm64-mac.zip` | `e2d2b5bd4dfe67b2d7a1ce819b1133c1e522986dc86561463e92e90a38b8d8e9` |
| `mac-arm64/Faangin.app/Contents/Resources/app.asar` | `468796d1289d8685b4f0721910ed6fdba4ecdeec404698a187243d670098c92d` |

This remains a local unsigned development candidate. Apple signing/notarization, Windows, actual recognized speech, real model correctness and latency remain separate acceptance checks.

## Neutral dark candidate 0.2.7

October 16, 2026. The color-only update adopts [Astryx Neutral's gray ramp](https://github.com/facebook/astryx/blob/main/packages/themes/neutral/src/neutralPalettes.generated.ts) through existing semantic CSS variables. It covers dark surfaces, text, controls, selection, focus, overlay, shadows, crop selection, theme previews, high-contrast borders and the opaque native-window fallback. Light palette, layout, type, transparency controls and application behavior are preserved. No Astryx package or font dependency was added.

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript and production build | Passed | Version 0.2.7 |
| Packaged desktop workflow | **17 isolated fixture requests passed** | Interview/context/transport/restart checks, responsive sizes and overlay controls; no native recording or live provider calls |
| Light appearance comparison | Passed | 320 computed-property comparisons across 20 principal elements against the previous CSS; zero differences |
| Dark appearance comparison | Passed | Sampled colors neutral; zero geometry differences; CSS fallback restores original shared shadow/crop colors in light appearance |
| Visual inspection | Passed for fixture views | [Dark workspace](../assets/workspace-dark-neutral-v027.png), [light workspace](../assets/workspace-light-neutral-v027.png), [dark overlay](../assets/overlay-dark-neutral-v027.png) |
| Launch copy | Updated | Normal launch path reopened as 0.2.7 with 15 saved sessions still listed; 0.2.6 bundle preserved under ignored `dist/previous-launch` |

The app, DMG, ZIP and verification evidence are in `dist/neutral-candidate`. This is a local unsigned candidate. No new behavior tests were added for this reversible color change; the previous 485-test audio/context checkpoint remains historical. Physical audio and provider/model evaluation were not repeated for a palette change. See [desktop appearance](design-system.md) for token choices.

## Apple light candidate 0.2.8

October 16, 2026. Light appearance now follows Apple's [Color](https://developer.apple.com/design/human-interface-guidelines/color) and [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) guidance with white content, soft gray chrome, neutral labels/separators/shadows, and restrained blue actions/selection/focus. The existing dark palette, geometry, typography and behavior are preserved. These are custom semantic CSS colors, not native AppKit dynamic-color bindings.

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript and production build | Passed | Final version 0.2.8 |
| Packaged desktop workflow | **17 isolated fixture requests passed** | Interview/context/transport/restart, responsive viewports and overlay controls; no native recording or live provider calls |
| Dark appearance preserved | Passed | 320 sampled workspace properties, 144 overlay properties and geometry match the previous CSS |
| Light/system-light parity | Passed | Explicit Light matches emulated system-light in workspace and overlay; light geometry unchanged |
| Light palette and visuals | Passed for fixture views | Neutral principal backgrounds, intended blue controls, [light workspace](../assets/workspace-light-apple-v028.png) and [light overlay](../assets/overlay-light-apple-v028.png) reviewed |
| Nominal sRGB contrast | Passed for specified token pairs | Primary white label at least 4.70:1; body on white 16.83:1; secondary text on gray 7.26:1; faint text on gray 4.66:1; link on white 5.57:1 |
| Launch update | Verified | Normal launch copy reopened as 0.2.8 with all 15 sessions listed; previous 0.2.7 bundle retained under ignored `dist/previous-launch` |

Artifacts and verification evidence are in `dist/apple-light-candidate`. The older running instance was slow to finish closing during replacement; it eventually exited, and the new instance opened successfully. The exact cause of that shutdown delay was not established. Palette work does not change capture/shutdown behavior.

This remains a local unsigned candidate. Contrast figures describe nominal token pairs, not every translucent background. No full hardware/display/VoiceOver matrix, live audio or provider evaluation was repeated for a color-only change. See [desktop appearance](design-system.md) for the implementation and remaining visual acceptance scope.

## Script wordmark candidate 0.2.9

October 17, 2026. The wordmark adopts locally bundled [Pacifico Regular](https://github.com/google/fonts/tree/main/ofl/pacifico), selected as a style match for the supplied connected-script logo reference. This is not an exact identification of that logo's original typeface. Body/control/code typography, palettes and compact icon are preserved. The font and its SIL Open Font License are included in the app; no remote font loader, dependency or OS font installation is added.

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript and production build | Passed | Final version 0.2.9 |
| Packaged desktop workflow | **17 isolated fixture requests passed** | Existing interview/context/transport/restart checks, responsive sizes and overlay controls; no recording or real provider calls |
| Local font loading | Passed | Font loads under production `font-src 'self'` / `connect-src 'none'`; bundled TTF and license present |
| Sidebar fit | Passed | Full brand width 132.4px at 1280px viewport; 117.4px at 1100/1000px; glyph remains 25px with wordmark hidden at 900px |
| Script bounds | Passed | Measured ink fits the 101px sidebar header without clipping; no page overflow |
| Other typography | Preserved | All 70 sampled non-brand font properties match the previous CSS |
| Visual review | Passed | [Logo detail](../assets/wordmark-script-v029.png), [light workspace](../assets/workspace-light-script-v029.png), [dark workspace](../assets/workspace-dark-script-v029.png) |
| Launch update | Verified | Normal launch copy reopened as 0.2.9 with 15 sessions listed; previous 0.2.8 bundle retained under ignored `dist/previous-launch` |

Artifacts and verification evidence are in `dist/script-logo-candidate`. This is a local unsigned candidate. No full hardware, accessibility, audio or model evaluation was repeated for a logo font change.

## Standalone wordmark candidate 0.2.10

October 18, 2026. The full script **faangin.** wordmark replaces the separate F monogram across the sidebar, compact sidebar, overlay, empty state and native app icon. The existing local font and license are retained. CoreText outlines of the bundled font provide a standalone SVG and the native icon source; no dependency or remote asset is added.

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript and production build | Passed | Final version 0.2.10 |
| Packaged desktop workflow | **17 isolated fixture requests passed** | Existing interview/context/transport/restart checks; no recording or real provider calls |
| Sidebar fit | Passed | Full wordmark at 1280/1100/1000px; 45.47px wordmark inside the 47px collapsed header at 900px |
| Compact surfaces | Passed | Full wordmark at 480/360px overlay widths and inside the 92×52px empty-state pill |
| Monogram removal | Passed | Every rendered Brand contains the complete name and zero old symbol/SVG nodes |
| Font and typography | Passed | Local font loaded; 70 sampled non-brand font properties unchanged |
| Native icon and package assets | Passed | Full-name PNG/ICNS visually reviewed; packaged ICNS matches source and all 15 production output files match the package |
| Visual review | Passed | [Logo detail](../assets/wordmark-only-v0210.png), [light workspace](../assets/workspace-light-wordmark-v0210.png), [dark workspace](../assets/workspace-dark-wordmark-v0210.png), [compact sidebar](../assets/workspace-compact-light-wordmark-v0210.png), [overlay](../assets/overlay-dark-wordmark-v0210.png), [empty state](../assets/workspace-empty-wordmark-v0210.png) |
| Launch update | Verified | Normal launch copy reopened as 0.2.10 with the standalone wordmark visible and 15 sessions listed; previous 0.2.9 bundle retained under ignored `dist/previous-launch` |

Artifacts and verification evidence are in `dist/wordmark-candidate`. This remains a local unsigned candidate. No full hardware, accessibility, audio or model evaluation was repeated for a branding change.


## Hands-free interview candidate 0.3.0

October 19, 2026. See [hands-free implementation and acceptance scope](hands-free-interview.md) for the conversation protocol, audio timing, race guards, model settings, screenshots and measured live results.

| Check | Result | Scope |
| --- | --- | --- |
| Final regression suite | **533 passed; 0 failed; 0 skipped** | Audio ingestion/PCM/VAD, capture lifecycle, source-aware context, streaming disposition, exact target provenance, timing, interruption, storage, UI setup/Stop races and existing behavior |
| TypeScript / production build | Passed | Version 0.3.0 |
| Source desktop workflow | **21 fixture requests passed** | Localhost fake provider, disposable workspace, actual renderer/IPC, interruption, hidden WAIT, malformed framing, late candidate context and restart |
| Packaged desktop workflow | **21 fixture requests passed** | Same workflow against the finished .app, responsive sizes and expanded overlay |
| Focused desktop UI | Passed | Ready/start/consent, both-source context, no framing leak, preserved draft/focus, Stop→Ready; 1280/1000/900px and 480px overlay |
| Saved OpenAI access | Verified | GPT-6 Luna, GPT-6.1 Sol and GPT Live Transcribe metadata; key never printed |
| Production model generation | Passed | Actual app Settings completed one tiny streamed request for each of saved Fast/Luna and Smart/Sol; no session data or audio sent |
| Launch update | Verified | Normal launch bundle reopened as 0.3.0, 15 saved sessions listed, Fast/Luna selected, Start hands-free visible, capture off; prior 0.2.10 bundle retained |
| Synthetic live transcription | Passed | Public generated speech; final 667 ms after explicit commit, no physical recording |
| Synthetic live routing | **5/5 expected dispositions** | BFS, already answered, acknowledgment, weighted scenario, candidate thinking; final visible answers manually reviewed |
| Live latency | Observed | First useful answer 1,022–1,573 ms after model dispatch; small synthetic sample only |

Evidence is saved under ignored `dist/handsfree-candidate`. One intermediate live run was incomplete (`malformed_response`) and a subsequent bounded rerun completed. Physical routing, representative call quality, broad semantic accuracy and signing/notarization remain outside this checkpoint. The primary workspace's saved sessions and credentials are preserved.


## Overlay interaction repair 0.3.3

The interaction regression is fixed in source and the installed app. The overlay is interactive by default, explicit opening restores input, and only the bounded 110 px logo/status handle drags. Background output preserves an explicit click-through choice without requesting focus. The repair also fixes overlay Settings shortcut navigation and safely waits for a cancelled region preview's native acquisition before a new single-click Capture & solve. Waiting is bounded, preserves native draining, and rechecks cancellation/context ownership before acquiring a fresh frame.

Source recovery was verified before repair: the user's moved Documents checkout identified as 0.3.0, and the reconstructed 0.3.2 source passed **580 tests** with **all 15 compiled output files byte-identical to the installed 0.3.2 app**. The original Documents source was backed up before restoring the current source and repair. The final 0.3.3 source passes **588 tests**, typecheck and production build, including a successful build from the actual restored Documents folder.

Source and packaged acceptance each pass **22 native-state/renderer interaction checks**, **9 localhost fixture responses**, and **four visually reviewed screenshots**. Source and packaged general smoke each pass **21 localhost interview fixture requests**. The original default-mode test fails on unmodified 0.3.2 and passes on 0.3.3 without a forced `setClickThrough(false)` recovery. Region Cancel → single Capture & solve and overlay Command-comma → workspace Settings pass. Check scope, physical-device limits, behavior, and source restoration are recorded in [the repair note](overlay-interaction-v033.md).

The installed app and normal launch bundle were updated, with previous copies preserved. User data and credentials were not changed. Faangin was not running at replacement and has not been launched after installation. The installer is also `/Users/admin/Desktop/Faangin-0.3.3-arm64.dmg`. The installed, candidate, and normal-launch app copies match; all 15 output files match their ASARs. Final provenance and verification logs are at `dist/interaction-repair-candidate`.

Physical mouse routing, physical global shortcut delivery, OS file pickers/clipboard, live capture/resume and real provider quality remain manual acceptance. No 100% universal operation claim is made. Artifacts remain unsigned local development builds; no public release was published.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Faangin-0.3.3-arm64.dmg` | 132792497 | `efe8519e9130aee02d420d46dd8d283ce88b8bb76e70e7036c4838ebd3f1ff6e` |
| `Faangin-0.3.3-arm64-mac.zip` | 132815144 | `3dfec51d84b55dda789738b32b897bc9e61bb9c3f221ca059649d2582ffb7860` |
| `mac-arm64/Faangin.app/Contents/Resources/app.asar` | 39898730 | `b2a60f4e4c791e1e0b2798a25e1337a9a749827425ffe1a4d1c8c790a5c1fe6c` |
