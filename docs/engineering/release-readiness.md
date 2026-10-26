# Release readiness

Date: October 13, 2026 · Preserved 0.2.0/0.2.1/0.2.2 checkpoints and latest 0.2.3 Live suggestions candidate

Historical candidates retain their verification: 0.2.0 passed 313 tests, [0.2.1](#latency-candidate-021) 334 and [0.2.2](#spoken-question-candidate-022) 343, with their final builds/packages/smoke/checksums. The latest [0.2.3 Live suggestions candidate](#live-suggestions-candidate-023) adds opt-in automatic Reply; final verification/package evidence is pending. Native physical acceptance, signing, live model/audio quality and exact commercial parity remain open.

## Checked workflows

| Workflow | Implemented behavior | Verified scope and remaining acceptance |
| --- | --- | --- |
| Interview brief and actions | Company/role/round/stage/problem/constraints/attempt are retained; typed/spoken context feeds Solve/Debug; Hint and Review have distinct contracts | SQLite migration/reopen/reset, prompt fixtures, packaged IPC and native saved brief; live answer quality and real speech pending |
| Fast/Smart and streaming | Explicit model mapping, snapshotted admission, measured timings, retained partial output and real cancellation | Actual packaged routes through a local fixture service, cancellation/quota errors and restart; commercial-provider/model matrix pending |
| Capture lifecycle | Independent source state, revocable Start, Stop without new speech dispatch, bounded admitted drain, Pause/Resume and idle/sleep/device policy | Controlled fixtures plus actual missing-key cleanup; physical microphone/system audio, device/permission and sleep/wake cases pending |
| Notes, drafts and presets | Finalized-only notes and follow-up drafts, selected templates, saved-edit protection, independent notes, preset CRUD/choice; persisted passage snapshots, source modal, CommonMark copy/export links and action/prompt retry | Final tests/build/package and five-request packaged fixture smoke including draft/source restart passed; hidden render fixture passed; native accessibility observed two saved fixture drafts/source dialog/Notes. Visible-compositor/click acceptance and live fidelity pending |
| Prior-session memory | Search/select/edit/remove with bounded final text, exact approved excerpts, attribution and source revalidation | Integration fixtures and actual packaged request provenance; wider native corpus/keyboard review pending |
| Library and data controls | Answer/brief/text search, local-calendar date/mode filters before cap, Trash/restore/permanent delete, RAM-only history | SQLite/search/date/privacy fixtures and packaged restart; native export/file inspection and deletion matrix pending |
| Provider setup | OpenAI chat/speech plus separate compatible chat endpoint/key/Fast/Smart/vision declaration; explicit generated connection test | Adapter validation and packaged local fixture route; user reports entering a replacement key, but independent access/quota and live checks remain pending |
| Overlay | Saved 0–100% background opacity with opaque text; collapse/expand and restored height | Native 0% preference saved; 480 × 54 / 480 × 700 DIP collapse/expand observed; backdrop, click-through, full-screen and monitor acceptance pending |
| Screen, regions and attachments | Selected display/window; local preview crop; window/session/epoch/topology-bound two-minute leases; chosen-pixel commit; bounded ordered/selected images and own-window handling | Final source/build/package, consent/lease/coordinate fixtures and generated Retina canonical-pixel crop passed; actual physical crop interaction, mixed-DPI/compositor and vision acceptance pending |
| Diagnostic export | Explicit local bundle with allowlisted counts/status/codes/timing summaries | Redaction and bounds fixtures; native saved-file/support review pending |

The final packaged checkpoint log is `/private/tmp/faangin-final-candidate-smoke.log` and exited 0. It verifies real sandboxed preload/IPC, SQLite, document workers and five requests through a controlled localhost service, including Draft and persisted passage snapshots across restart. The candidate DMG/ZIP checksums were refreshed for those finished bytes. No live provider or physical recording was performed. [Build verification](build-status.md) records the exact artifacts and evidence; [requirement status](feature-status.md) retains every PRD gap.

## Native evidence and acceptance sequence

QA used a separate app identity and workspace, preserving the primary app’s data and drafts. Earlier captures are [saved interview context](../assets/interview-context-v020.png) and [collapsed overlay](../assets/overlay-collapsed-v020.png). Native accessibility inspection observed two saved fixture drafts, their source dialog and separate Notes controls; an independent hidden render fixture also passed. ScreenCaptureKit images and click behavior did not consistently match that accessibility state. The final computer-control attempt reported a locked Mac and failed automatic unlock. Complete visible interaction after unlocking and resolve the discrepancy before certifying final native visuals. Flattened captures also do not certify a transparent backdrop over another application.

1. Save open drafts and select the intended version: the preserved 0.2.0 region/draft candidate is at `dist/candidate/mac-arm64/Faangin.app`; the tested 0.2.1 latency candidate is at `dist/latency-candidate/mac-arm64/Faangin.app`. Verify that version’s build record and hashes before acceptance; source changes require another build and manifest.
2. Review your saved OpenAI or compatible provider connection in Settings. The user reports entering a replacement key; engineering checks did not independently verify it. Saving does not generate an answer. **Check OpenAI model access** is separate from **Test chat generation**, which explicitly may make up to two tiny billed requests. A compatible key remains bound to its saved destination.
3. Save an Interview brief and select a response preset. Exercise Hint, Solve, Review, Debug, Design and Behavioral with appropriate real inputs; copy code/answers, cancel, explicitly retry and inspect timings. Confirm code is analyzed without execution.
4. Import/select/reorder/remove images and validate that only selected images are dispatched. Choose **Capture a region**, drag on the local preview or enter preview-image pixel bounds, and confirm **Add region**. Verify cancel/expiry/reset/foreign-window rejection without attachment mutation, then certify actual source/permission/Retina/mixed-DPI cases on the final package. Generated-image fixtures are not physical capture acceptance.
5. Test microphone and default-output system audio separately and together. Exercise permissions, source loss, Stop/Pause/Resume, sleep/wake, device changes, idle ending and long sessions; inspect provisional/final order and incomplete transcript notices.
6. Check the overlay at 0%, 35% and 100% over bright/dark apps; collapse/expand, keyboard recovery, click-through, full-screen and monitor changes. Exercise Reduce Transparency/Motion/Increase Contrast and VoiceOver.
7. Search/filter saved sessions and explicitly select/edit/remove prior excerpts. Generate notes, then choose **Draft** or **Notes → Draft follow-up**. Verify finalized-only passage snapshots and source dialog, bounded source scrolling, preserved retry wording and notes independence; inspect inline/titled/reference-style source links and excerpts after copy/Markdown export and reopen. Drafts are reviewed and copied, never sent automatically. Test export, reset, Trash/restore/permanent deletion and history-off restart without erasing old snapshots or promoting RAM sessions.
8. Export/review diagnostic metadata and execute the documented fresh-install/device/provider/language matrix plus a 60-minute resource run. Keep native fixture results distinct from provider/model quality and commercial parity.

## Latency and quality

Record representative first-text and total-answer p50/p95, distinguishing network/model delay, speech finalization and rendering. Nanosecond-scale cloud answers are unattainable and no sub-millisecond guarantee is offered. **First text** is main-process entry-to-first-received-non-whitespace-text, including preparation; **Finished in** precedes terminal save/emission. Neither measures physical paint. Fast interview mode preserves the saved brief and established transcript budget, and asks for a useful opening before the required details. See [latency](latency.md) for a manual comparison with the actual saved Fast/Smart models; no live benchmark or model switch was performed.

The Realtime adapter uses 24 kHz PCM, client turn commits and item-ID reconciliation. Source labels/capture timestamps are application metadata, not provider diarization or word timestamps. Evaluate real microphones, accents, languages, noise, overlapping speakers, coding vocabulary, long sessions, constraint preservation, complexity analysis, uncertainty and supported personal facts. Fixture structure alone does not certify live quality or hiring outcomes.

## Signed macOS release

`npm run dist:mac` produces the unsigned local acceptance build. `npm run release:mac` uses a separate configuration and output directory, `dist/release-mac`, so it preserves that local bundle. The release command never publishes.

Supply credentials through your secure environment or Keychain. Do not commit certificates, private keys, passwords, or API keys.

| Setting | Required value |
| --- | --- |
| `CSC_NAME` | Installed Developer ID Application certificate name suffix, including its `(TEAMID)`, without the `Developer ID Application:` prefix |
| `APPLE_TEAM_ID` | Matching 10-character Developer Team ID |
| Notarization credentials | Exactly one strategy: `APPLE_KEYCHAIN_PROFILE`; `APPLE_API_KEY` path plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`; or `APPLE_ID` plus `APPLE_APP_SPECIFIC_PASSWORD` |
| Imported signing certificate, if used | `CSC_LINK` and `CSC_KEY_PASSWORD`; otherwise use an installed Keychain identity |
| Custom notarization Keychain, if used | `APPLE_KEYCHAIN`, with the profile strategy |

```sh
npm run release:mac -- --check
npm run release:mac
```

The read-only preflight checks required settings, Apple tools, installed identity metadata, and API-key file accessibility. It does not prove Apple credential validity. An explicit release run builds with Hardened Runtime and JIT/audio entitlements, signs with Developer ID, notarizes and staples the app and final DMG, verifies signatures, team, secure timestamps, entitlements, Gatekeeper and stapled tickets, and verifies an app extracted from the final ZIP. It removes obsolete update metadata and writes `SHA256SUMS` for the finished DMG/ZIP. Missing setup fails before packaging; fixture tests verify fail-fast and verification rules without uploading or signing.

This pipeline has passed configuration and fixture checks only. No real signed/notarized artifact has been produced in this session.

## Remaining production gates

| Gate | Current state | Required action |
| --- | --- | --- |
| Final D0 region/draft acceptance | Implemented; final 313 tests/build/package, five-request packaged fixture smoke, source restart and checksums passed | Resolve native screenshot/click discrepancy; test actual physical capture and visible source-review flows |
| Replacement provider credential | User reports entering a replacement in Settings; independent saved-state/access/quota checks were not performed | Review the saved destination and explicitly run the supported provider/model checks when desired |
| Live inference, vision and quality | Local transport fixtures passed; commercial models remain untested | Execute representative supported scenarios, inspect outputs and record timing/usage |
| Physical audio and permissions | Controlled lifecycle fixtures passed; recording not run | Test actual enabled sources, denial/revocation/device/loopback/sleep and recovery cases |
| Complete native acceptance | Earlier brief/preset/0% save and overlay geometry checked; new draft/source/notes AX state observed; final control attempt stopped at locked Mac | Unlock and resolve screenshot/click discrepancies; actual region capture, backdrop/monitor/full-screen/click-through, library/export, accessibility and long-session matrix |
| Apple public distribution | Executable is ad hoc/linker-signed, with no Developer ID team or sealed-resource signature; no notarization run | Supply real Apple credentials and verify the separate signed-release pipeline and fresh install |
| Windows and x64 | Configuration exists; native operation uncertified | Validate Windows after macOS acceptance and gate x64 on actual architecture tests |
| Exact parity | Public/source research, no complete native commercial baseline | Versioned authorized reference observations and behavior-specific measurements |

The full [PRD](../prd.md) and D1 [delivery plan](delivery-plan.md#full-parity-expansion-work) remain in scope: Windows, bundled local speech, expanded providers, search/citations, slide/local integrations, managed inference, accounts/entitlements, hosted sharing/sync, calendar preparation, billing, mobile, original prep/web utilities, referral operations and safe updates/version surfaces. These are tracked requirements, not silently removed from the project or counted as delivered by local desktop packaging.

No credential supplied in chat was saved or used. No Apple identity, account or publishing credential was fabricated. No signed/public production release or absolute screen-share invisibility is certified by this checkpoint.

## Latency candidate 0.2.1

The final 0.2.1 candidate at `dist/latency-candidate` preserves the old application and 0.2.0 artifact hashes. Its complete source regression run passed 334 tests with no failures or skips; typecheck/build, packaging and final packaged smoke passed with exit 0. The smoke verified narrow admission before first delta, first answer text in the actual workspace Markdown DOM, five localhost requests and persisted draft sources across restart. Finished-byte checksums and build provenance are recorded in [build status](build-status.md#latency-candidate-021).

This release removes repeated local compilation/state/storage work and batches later stream rendering while publishing first text immediately. Fast’s short opening retains full action requirements and the 4,096-token Solve budget. The nominal 32 ms fallback is not a visible-paint SLA. Deterministic stream and transport regressions protect admission ordering, pending text, cancellation, terminal output and disposal; they do not establish cloud latency or answer quality.

Use the existing Fast toggle and follow the [manual three-trial Fast/Smart procedure](latency.md#measure-with-your-configured-provider). Each request is explicit and may be billed. The final packaged smoke used the frozen source after the whitespace correction; the earlier source smoke preceded it. The user’s key setup is reported, not independently validated; no engineering-paid generation, hidden background inference or automatic benchmark was performed. All production and D1 gates above remain open.

## Spoken-question candidate 0.2.2

The final candidate uses `dist/spoken-candidate`, preserving the previous app and 0.2.0/0.2.1 evidence. All 343 tests passed with no failures/skips; typecheck/build, packaging, source and final packaged smoke passed. Its six localhost requests include the actual Interview Conversation Reply button reaching the main API and `/reply` using a manual public question, empty composer and no images, plus draft/source restart paths. Bundle version 0.2.2, finished checksums, provenance and four verification logs are recorded in [build status](build-status.md#spoken-question-candidate-022). The user’s screenshot/Solve success is feedback about that path, not certification of live transcription or automatic responses.

Before switching bundles, save/export needed session data, including RAM-only sessions, then deliberately quit the old instance and open 0.2.2. A second normal instance focuses the already-running workspace.

For a remote interviewer, use **Stop listening → Settings → Audio sources → System audio → Save changes → Start listening → verify words in Conversation → Reply**. Use Microphone for voices in the room. Conversation Reply opens Assistance and needs eligible finalized/manual or active provisional text; paused/stopped uncommitted speech is excluded. Selected images and permitted background/history can still be included. Reply remains explicit; automatic generation was not implemented. See [spoken-question setup](spoken-questions.md).

Acceptance must distinguish source capture from response dispatch: test real system audio/headphones and microphone separately, inspect recognized words and source health, then request Reply and assess the answer. Low-level diagnostics are conditional energy notices and preserve existing VAD thresholds. Passed source/packaged smoke use a manual public question as a captured-question proxy; neither certifies actual recording or physical visible interaction. System audio must be enabled and saved deliberately in the user’s settings; the engineering checks did not change them. Existing live audio/provider, device/permission, signing, Windows and D1 gates remain open.

## Live suggestions candidate 0.2.3

The final 385-test suite and typecheck/production build passed after the failure-pause correction. An earlier seven-request source smoke passed; the expanded final nine-request smoke did not run because Codex automatic approval review hit its account usage limit. Review capacity, rather than an unsafe-action finding, blocked that call. No 0.2.3 bundle or installer exists. `dist/live-candidate` is planned output; final smoke, packaging, packaged smoke and hashes remain pending. All previous artifacts/hashes are preserved, with 0.2.2 still the latest verified installer.

For a remote call, stop listening, enable System audio in Settings → Audio sources, turn on Live suggestions, select System audio as its source, Save changes and Start listening. Verify finalized words and the displayed Automatic replies status. The mode is off by default; enabling it permits automatic context dispatch and provider usage. Manual Reply remains available, including when automatic failure is paused. Microphone mode cannot distinguish interviewer from candidate.

Acceptance must check disabled-mode silence, chosen-source admission, finalized target context with no images, partial deferral, coalescing/latest pending, rolling limits, manual priority, cancellation and stale lifecycle results, failure pause/recovery, automatic origin/status, preserved composer and dirty editor drafts. The coordinator has one active request, a nominal 350 ms settle interval, at least three seconds between starts and at most six starts per rolling minute; these are dispatch limits, not timing or total-cost guarantees.

Resolve a provider error, then explicitly toggle/reconfigure the mode or start a new capture to resume; manual generation does not clear that automatic failure pause. Stop/Pause/disable/source/session/reset/key/provider changes invalidate automatic work. No real primary preferences, keys, paid provider calls or recordings were used for this checkpoint. Public-text localhost fixtures through the final callback do not certify physical speech or live model quality. See [usage and consent](spoken-questions.md) and [Rea evidence/limits](../research/rea-live-suggestions.md). All production, platform, exact-parity and D1 gates remain open.
