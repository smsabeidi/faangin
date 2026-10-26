# Requirement status

October 13, 2026 · Preserved macOS 0.2.0/0.2.1/0.2.2 checkpoints; latest 0.2.3 Live suggestions candidate

The PRD remains the scope contract. Preserved 0.2.0/0.2.1/0.2.2 records retain 313/334/343 passing tests and final build/package/smoke/hash evidence. The latest [0.2.3 Live suggestions update](#live-suggestions-candidate-023) passed its final 385-test suite and typecheck/build; final nine-request smoke was not executed because Codex approval review hit its usage limit. Packaging and final artifact evidence remain pending. Fixtures do not certify physical capture, real audio, model quality, screen-share protection, other platforms, or commercial parity. No row is a blanket production signoff.

## Desktop requirements

| ID | Current implementation and evidence | Remaining acceptance or implementation |
| --- | --- | --- |
| F01 | Packaged startup, sandbox/preload checks, missing-key cleanup, distinct source/status and permission UI | Fresh signed install; native denial and recovery matrix |
| F02 | Workspace/overlay, native collapse/expand, remembered height, atomic reachable bounds with monitor fixtures | Physical monitor changes, full-screen apps, restart geometry acceptance |
| F03 | Faangin and Cue shortcut presets (Cluely and InterviewCoder presets retired; saved choices fall back to Faangin), overrides/disable, atomic conflict rollback, menu fallback; fixture checks | Physical shortcut conflicts and every compatibility binding |
| F04 | Explicit click-through and authoritative interaction state; showing overlay restores interaction | Underlying-app click/focus and keyboard recovery certification |
| F05 | Content-protection preference and platform limits disclosed | Every supported screen-sharing path and owned dialog; no universal invisibility claim |
| F06 | Display/window selection, own-window hiding/restoration, source exclusion, timeout mutex; local preview crop with sender/session/epoch/topology-bound two-minute lease and chosen-pixel commit; consent/coordinate/expiry fixtures, generated Retina canonical-pixel crop and final source/build/package | Actual physical region interaction, compositor exclusion, Retina and mixed-DPI verification |
| F07 | Four-image tray, selection, preview/remove/clear/reorder, actual signatures and size/count limits; consent fixtures | Native multi-image interaction and vision quality |
| F08 | Independent microphone/system pipelines, meters/status, exact microphone selection, isolated inventory | Real devices, unavailable inputs, loopback, permissions and reconnect; no per-app audio capture |
| F09 | Partial replacement, final deduplication, source capture ordering, empty-final retirement, durable incomplete flag | Real speech accuracy and language cases; language preferences are not detected per-turn language metadata |
| F10 | Revocable startup; idempotent Stop; no new post-Stop speech commit; bounded admitted drain; manual pause/sleep/device/idle policy fixtures and actual missing-key IPC cleanup | Physical sleep/wake/device and long-session acceptance |
| F11 | Pause/Resume, context reset distinct from hiding, transcript copy, configurable input language | Native capture interactions and live language changes |
| F12 | Independent input/output settings and request snapshot; documented Realtime configuration | Every selectable language remains uncertified against real speech and answers |
| F13 | Bounded Assist snapshot, explicit image/memory consent, source counts/truncation and missing-context checks | Live usefulness and representative latency |
| F14 | Reply action with bounded conversation and factual background | Real conversation response quality and attribution |
| F15 | Follow-up-question action and context contract | Live relevance and non-repetition |
| F16 | Finalized-only Recap, reset epochs, explicit transcript truncation | Long-session summary fidelity; no rolling factual summary yet |
| F17 | Typed questions, opt-in same-session answers, selected images and prior excerpts | Native repeated-turn acceptance with a real provider |
| F18 | Snapshotted Fast/Smart models, explicit capability gates; actual packaged routing through local fixture service | Real provider/model matrix; commercial routing unknown |
| F19 | Request-scoped streaming/cancel, retained incomplete output; real packaged HTTP cancellation and restart | Provider outages and representative live workloads |
| F20 | Interview brief, structured Solve contract, constraints/language/code/complexity/edge cases | Live correctness and ambiguity evaluations; no code execution is claimed |
| F21 | Hint/Debug/Review, retained problem/attempt and bounded opted-in prior solutions | Real follow-up quality and error screenshots |
| F22 | Coding, review/debug, design and grounded behavioral contracts | Live evaluation; additional reference interview categories remain backlog |
| F23 | Response/note preset CRUD, duplicate/default restore, revision conflicts, per-session choice; native selection and packaged restart | Complete native manager acceptance, especially multi-window drafts |
| F24 | Editable profile/job context, previewed TXT/PDF/DOCX import; actual sandboxed fixture extraction | Real document corpus and factual behavioral evaluation |
| F25 | OpenAI chat/speech configuration plus separate compatible chat endpoint/key/models/vision; pinned localhost; adapter fixtures and real packaged local chat route | Live account access, provider capabilities, billed connection checks; broader speech-provider selection pending |
| F26 | Not implemented | Bundled local transcription/runtime integrity and architecture testing |
| F27 | Not implemented | Explicit search provider, destinations, citations and factual support |
| F28 | Finalized transcript notes and source-linked follow-up drafts; selected templates, saved-edit CAS protection and independent notes; bounded passage snapshots persist/reopen/reset, source modal, CommonMark copy/export and action/prompt retry; final packaged draft/source restart, hidden render fixture and native AX observations | Resolved visible-compositor/click acceptance; representative live note/draft quality and factual support. Transcript source links do not fulfill F27 web research |
| F29 | Title/notes/transcript/answer/brief search, mode and local-calendar date filters before cap, editable session and library | Full keyboard/native search certification; discovery is capped at 500 sessions |
| F30 | Markdown/JSON export, copy, Trash/restore, separate permanent-delete UI/API, cascade/checkpoint reporting | Native saved-file inspection and artifact cleanup matrix; exports/OS backups/SSD remnants are outside app deletion |
| F31 | Schema v3, transactions, startup recovery, corrupt/future schema preservation, visible safe storage errors; SQLite fixtures and actual restart | Forced process-crash/disk failure and migration acceptance on real prior workspaces |
| F32 | Explicit attributable prior-session search/selection/edit/removal, final-selection budgets and source revalidation; packaged request provenance | Wider native retrieval corpus; no embeddings or automatic history inclusion |
| F33 | Separate OS-encrypted credentials, no raw audio persistence, RAM-only history mode and preserved saved snapshots/preset choices | Real Keychain failure/revocation and forensic/storage-limit review |
| F34 | Saved theme/font/0–100% overlay tint, Apple blue glass styling, reduced transparency/motion/contrast, shortcut/capture/context settings | Full VoiceOver/keyboard/contrast acceptance; clear backdrop visuals require observation over actual apps |
| F35 | Classified provider errors/deadlines/cancellation, explicit retry; safe quota rejection through packaged fixture | Real offline/disk/permission/provider matrix and support review |
| F36 | Explicit metadata-only diagnostic export, allowlisted provider/errors, bounded timing stats; no key/text/image/device/path serialization | Native export/file inspection and operational support acceptance |
| F37 | Final 0.2.0 Apple Silicon app, DMG/ZIP and finished-byte checksums; packaged security/document/IPC/draft-source restart smoke; executable ad hoc/linker-signed without a Developer ID team | Developer ID signing, notarization, Gatekeeper/fresh install; x64 uncertified |
| F38 | Windows packaging configuration | Windows native implementation certification and signed installer |
| F39 | Not implemented; signed macOS release tooling is separate | Update provenance/notice, idle install, migration backup and rollback |
| F40 | Bounded speech, transport, images, context and inventory; sleep/device/idle lifecycle fixtures | 60-minute physical dual-source memory/CPU benchmark and native overload recovery |
| F41 | Actual returned model/token usage and measured first-text/total durations; no automatic paid retry | Real provider usage/cost semantics and representative latency distributions |
| F42 | Original branding; earlier Faangin captures kept separately from reference evidence; new draft/source/notes state inspected through native accessibility | Resolve inconsistent/stale ScreenCaptureKit frames before final visual acceptance; versioned native commercial screenshots and comparison baseline |
| F43 | Not implemented | Opt-in slide-change tracking and bounded captions |
| F44 | Not implemented | Revocable local integration capabilities and identity threat model |
| F45 | OpenAI and generic compatible chat contracts only | Provider inventory expansion and independently verified speech/model coverage |
| F46 | Not implemented | Managed inference gateway/account/credits, service contracts and revocation |

## Full parity expansion

| ID | Status |
| --- | --- |
| A01 | Calendar connection and pre-meeting briefs: pending |
| A02 | Hosted note sharing/revocation: pending; local export does not satisfy it |
| A03 | Accounts, device sessions, account deletion/recovery: pending |
| A04 | Cross-device sync/conflicts/tombstones: pending; reference behavior also requires observation |
| A05 | Entitlements, billing and credit accounting: pending |
| A06 | Mobile companion: pending |
| A07 | Original/licensed interview preparation directory: pending |
| A08 | Product/download website and public utilities: pending |
| A09 | Collaboration, administration and integration inventory: pending reference verification and implementation |
| A10 | Absolute undetectability: unverified and not promised |
| A11 | Affiliate/referral operations: pending |
| A12 | Version/account analytics surfaces: pending |

## Next engineering gates

Certify the finite macOS device/provider/language matrix using the intended version’s tested package. The prior computer-control attempt reported a locked Mac and failed automatic unlock. Complete native interaction after unlocking, resolve the screenshot/click/accessibility discrepancy and test physical capture separately from generated pixel fixtures. The user reports entering a replacement key, but its saved state/access/quota and actual model/audio quality were not independently verified. Signing credentials are unavailable; prepare the verified pipeline but do not label an ad hoc artifact a Developer ID signed release. Keep Windows and the entire D1 backlog in the delivery plan. Establish native reference observations before any exact-parity claim.

## Latency candidate 0.2.1

| Requirement | Implemented latency work | Evidence and remaining acceptance |
| --- | --- | --- |
| F13/F18 | One admitted compiled snapshot, narrow answer admission event, existing Fast/Smart selection and concise Fast interview opening with full required detail | Final 334-test suite, build/package and packaged fixture smoke passed. Selected sources, saved brief, context budgets and output caps are preserved; live usefulness and latency remain unmeasured |
| F19/F35 | Immediate first non-whitespace text update with leading whitespace retained; ordered later updates on a frame/nominal 32 ms fallback; cancellation, canonical completion, stale-state/session/reset and Strict Mode cleanup guards | 18 deterministic stream regressions and final packaged admission/first-workspace-DOM-text checks passed; physical visible interaction and paint timing remain uncertified |
| F31/F40 | Epoch existence check avoids full-record reload in answer saves; request-time full-state refresh is removed; unchanged answer/citation bodies memoized | Source regressions passed; no real resource or wall-clock benchmark establishes a quantified performance improvement |
| F41 | First-text timing now includes main-process preparation; total duration precedes final save/emission | Main metrics do not include all IPC or physical paint and are not directly comparable to 0.2.0’s earlier timing origin; representative real-provider measurements pending |

Final output, checksums, build provenance and four verification logs are separate at `dist/latency-candidate`; 0.2.0 artifacts and hashes remain historical. The final packaged smoke tested the frozen source after the whitespace correction, with five localhost requests and draft sources retained across restart. The user reports saving a replacement key, but no independent credential or live inference check was performed. No models, preferences or credentials were changed by this update; no extra paid/background generation was added. Nanosecond-scale cloud response is not a supported promise. See [latency measurement](latency.md). The complete PRD and D1 backlog remain in scope.

## Spoken-question candidate 0.2.2

| Requirement | Current change | Verification and remaining acceptance |
| --- | --- | --- |
| F03/F13 | Empty-composer local ⌘/Ctrl+Enter fallback for Assist; typed Ask, Shift/Solve, busy/working and native-shortcut guards retained | Four new composer regressions passed in the 343-test suite. No automatic request generation added |
| F08/F09/F10 | Explicit Start/Stop listening vs Capture screen labels, remote System audio guidance, separate low-level/silent/no-frame diagnostics with adequate-frame recovery | Five new audio-health regressions passed; existing VAD/provider/permission behavior retained. Actual device/output/recognized-speech acceptance pending |
| F14 | Manual Reply in both modes, expanded overlay and Conversation; Conversation navigates to Assistance and uses eligible finalized/manual or active provisional text | Source and final packaged smoke clicked the actual Interview Conversation Reply button with a manual public question proxy, empty prompt and no images; main `/reply`/rendering passed. Not a captured-speech or live-quality claim |
| F37 | Separate final 0.2.2 output at `dist/spoken-candidate`, bundle version 0.2.2, finished checksums/provenance and four verification logs | 343 tests/typecheck/build/package and six-request final packaged smoke passed; earlier 0.2.0/0.2.1 evidence and exact hashes preserved. Signed/public and physical acceptance remain pending |

User-reported screenshot/Solve success does not certify live transcription. Read-only settings/count metadata suggests checking System audio. Engineering did not inspect transcript/credential content, change primary settings, start recording or call a live provider. Automatic answer generation remains unimplemented. See [spoken questions](spoken-questions.md). All native/provider/audio/signing/Windows/exact-parity and D1 gates remain in scope.

## Live suggestions candidate 0.2.3

| Requirement | Implemented automatic flow | Evidence and remaining acceptance |
| --- | --- | --- |
| F13/F14 | Off-by-default Live suggestions; chosen System/Microphone source; finalized lexical utterance trigger including statements/follow-ups; manual Reply retained | Final 385-test suite and typecheck/build passed; earlier seven-request source smoke passed. Final nine-request smoke not executed due approval-review usage limit; packaging pending. No semantic question classifier or speaker identity inference |
| F18/F19/F35 | Existing configured provider/model; one active/latest pending; nominal 350 ms settle, three-second spacing and six starts/rolling minute; partial deferral, manual priority and failure pause without auto retry | Finalized targeted context/no images; lifecycle/source/session/key/provider invalidation; explicit failure recovery. Real provider quality/latency/cost acceptance pending |
| F17/F23/F34 | Automatic-origin answer cards, live status/reason, composer preserved and dirty editors retained during reveal | UI state/ownership fixtures; final smoke and physical accessibility/visible interaction pending |
| F33/F41 | Explicit opt-in and destination/usage disclosure; source choice controls trigger while normal bounded background/history/memory can be included | No primary user settings/keys changed, live paid inference or recording performed; sources do not identify people and rates do not cap all provider usage |
| F37/F42 | Planned separate `dist/live-candidate`; linked actual Rea investigation with versioned static-client and coverage limits | No 0.2.3 package exists; final package/hashes pending. Historical 0.2.0/0.2.1/0.2.2 hashes preserved; latest verified installer remains 0.2.2. No private-backend or 100% parity claim |

The manual-only automatic-generation gap in the 0.2.2 record above remains historical. In 0.2.3, Live suggestions is an implemented opt-in flow with a Faangin policy; it is not proof of exact Cluely/InterviewCoder behavior. See [spoken-question usage](spoken-questions.md) and [Rea investigation](../research/rea-live-suggestions.md). All physical/provider/signing/Windows/exact-parity and full D1 gates remain in scope.
