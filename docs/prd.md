# Faangin product requirements

Version: 0.2 · October 12, 2026 · Implementation and acceptance stage  
Decision owner: project maintainer  
Platform order: macOS, then Windows

## Objective

Build a complete desktop assistant that reproduces the verifiable meeting and interview-assistance workflows of the reference products. Match observable feature behavior and interaction timing where measured. Establish a versioned reference baseline before claiming exact operational or visual equivalence.

The first implementation is a comprehensive macOS release. The full parity program also includes Windows, calendar preparation, hosted notes, accounts/entitlements, mobile, and ancillary web tools. All of these appear in the inventory; a desktop release does not silently count them as delivered.

An Apple Silicon implementation and unsigned 0.2.0 candidate are available. Requirements remain acceptance criteria; implemented code does not by itself pass native, live-provider, or full-parity gates. See the [feature status](engineering/feature-status.md) and [verification record](engineering/build-status.md). Performance numbers below remain release targets, not measurements of Faangin or its references.

## Users and jobs

| User | Job | Successful outcome |
| --- | --- | --- |
| Student practicing technical interviews | Understand a coding problem, discuss an approach, and check edge cases | Correct, readable solution with an explanation and complexity analysis |
| User preparing behavioral interviews | Relate questions to their actual background | A concise answer grounded in uploaded facts, with missing details identified |
| Meeting participant | Recover context and prepare a useful response | Fast contextual assistance with the relevant speaker/source visible |
| User reviewing a session | Find decisions and follow-ups | Editable notes, linked transcript passages, searchable local history |
| User configuring the desktop | Control capture, providers, privacy, and shortcuts | Clear permission and channel states, durable settings, predictable keyboard operation |

## Parity contract

Four evidence classes apply to reference behavior: **observed public UI**, **documented claim**, **source-confirmed**, and **unknown**. Only native observations can establish native behavior. See the [product matrix](research/product-parity.md), [source audit](research/cue-audit.md), and [validation plan](engineering/validation-plan.md).

For each behavior, record the reference product/version, OS, plan, input fixture, interaction sequence, output, and failure cases. Faangin passes that behavior only when the same sequence meets its acceptance criteria. Model-generated wording is nondeterministic; evaluate correctness, structure, context use, and usefulness rather than identical prose. Pixel comparisons require versioned screenshots from the actual app, at the same viewport and scale.

The references have different shortcuts, feature scopes, business models, and default visibility. Compatibility presets keep those distinctions explicit. No single mixed keymap can be called identical to both products.

## Scope and priority

**D0 — first complete macOS implementation:** core desktop, dual-channel capture, inference, meeting and interview flows, personalization, local library, privacy controls, and a distributable package.

**D1 — full parity expansion:** Windows certification, streaming local transcription, calendar preparation, web-backed sharing/sync, commercial-style accounts and entitlements, mobile, and public web tools. D1 work remains in scope and has separate release criteria. Each can be developed after D0 contracts settle.

**V — requires reference verification:** exact commercial output templates, model routing, quotas, geometry, visibility mechanisms, and private integrations. These cannot be inferred from marketing material.

Research does not authorize purchases, account creation, accepting service terms, or production deployment. Credentials and live model usage are a later implementation decision. Documentation of those integrations is part of this deliverable.

## Complete user journeys

### First launch

Open the packaged app → choose Meeting or Interview → see what screen/audio data each action uses → choose capture sources → request only the needed permissions → verify input meters with a short sample → configure the selected inference and speech providers → test the configuration → reach an idle overlay. A denied permission leaves usable unrelated features available and provides a recovery action. Success is not shown until the relevant operation succeeds.

No audio or screenshot is sent before the user starts the applicable action. Startup must not generate background notes, activate microphones, or silently choose a paid gateway. A recovery of old data is distinct from resuming capture.

### Meeting

Start session → choose microphone/system channels → view live channel health and transcript → trigger Assist, What should I say?, Follow-up questions, Recap, or a typed question → view streaming output and context indicators → stop capture → allow already-admitted speech requests to finalize for at most five seconds → save session → request notes with a visible retry/error state → review, edit, search, export, or delete the session. Unsent queued audio is discarded with an incomplete-transcript indicator. Ambient Chat offers screen/typed assistance without audio capture. A configurable silence policy can end an idle session; the Cluely compatibility candidate is ten minutes, subject to native verification.

Hide collapses or hides presentation only; it must not implicitly stop capture. Stop ends capture regardless of window visibility. A globally available stop action and menu item remain reachable.

### Interview practice

Choose interview type, coding language, background, and prompt preset → collect one or more screenshots or import an image → review/reorder/remove attachments → extract the problem and flag uncertainty → request a solution → read approach, code, time/space complexity, edge cases, and suggested tests → ask follow-ups or attach a changed screen → reset the problem context without erasing unrelated saved sessions.

System-design and behavioral presets use the same transport with different output contracts. The first implementation provides explicit user selection; automatic problem detection is an enhancement that must not override a selected mode.

### Library and recovery

Search sessions → open notes/transcript/answers → edit notes → export selected data → delete through a recoverable local trash. Resume an ended/interrupted session retains selected accumulated context and starts a new capture generation only after user action; starting a new independent session clears that context. A stale session is not silently sent to a provider. Disk failures are visible and preserve unsaved content for export where possible.

## Desktop and capture requirements

| ID | Priority | Requirement | Acceptance criterion |
| --- | --- | --- | --- |
| F01 | D0 | Onboarding and capability checks | Fresh packaged install reaches usable idle state; microphone denied, screen denied, unavailable system audio, and missing provider all have distinct recoverable states |
| F02 | D0 | Floating overlay and full workspace | Overlay remains above supported apps; drag/resize/collapse work; settings/library open in a full window; last valid bounds restore and remain reachable after monitor changes |
| F03 | D0 | Global shortcuts and compatibility presets | Register/unregister atomically; conflicts are reported; UI/menu fallback works; selected preset persists; keyboard labels reflect platform |
| F04 | D0 | Click-through and focus control | Explicit pass-through state preserves underlying clicks; a recovery shortcut restores interaction; typing mode can receive keyboard input without trapping focus |
| F05 | D0/V | Screen-share privacy mode | Separate visibility control reports requested capability and tested limitations; validate every owned window, dialogs included; do not show guaranteed invisibility from an API flag |
| F06 | D0 | Screenshot capture and display selection | Selected display/window/region is captured at known scale; own overlay is excluded or the UI reports inability; denial, unplugged monitor, capture timeout, and stale source are handled |
| F07 | D0 | Screenshot tray | Ordered attachments can be previewed, removed, reordered, and cleared; MIME/size/count caps apply before provider dispatch; failed capture does not consume a request |
| F08 | D0 | Separate microphone and system-audio sources | Independent meters, microphone device choice, default-output system loopback, health state, channel labels, and controls; per-app capture is gated by the native spike; system audio failure does not masquerade as healthy or stop the mic |
| F09 | D0 | Partial/final transcription | Partial revisions replace the same segment; final text commits once; timestamps/channel/language are retained; reconnect never duplicates final turns |
| F10 | D0 | Session lifecycle | Start/Stop are idempotent; only one capture generation is live; late capture acquisition is disposed; Stop accepts no new frames or speech dispatch; only already-admitted speech requests finalize for up to five seconds; unsent backlog is discarded visibly; notes are separately admitted; idle ending and Ambient Chat work |
| F11 | D0 | Transcript control | Pause/resume capture, clear live context, copy transcript, and adjust language are available; destructive clear is distinct from hiding the panel |
| F12 | D0 | Input and output languages | Configure input language independently of response language; only tested supported provider languages are selectable; switching language updates the next applicable request |

## Assistance requirements

| ID | Priority | Requirement | Acceptance criterion |
| --- | --- | --- | --- |
| F13 | D0 | Assist | Builds a bounded snapshot of selected screen and recent transcript; indicates included sources; returns useful next-step assistance or an honest missing-context response |
| F14 | D0 | What should I say? | Uses conversation context and selected factual background; answers concisely; identifies who is being answered; no screenshot is required when disabled |
| F15 | D0 | Follow-up questions | Produces relevant, non-redundant questions tied to the current session; weak or absent context is reported |
| F16 | D0 | Recap | Summarizes the current session with factual boundaries; long sessions are handled through explicit context management; reset session does not leak earlier transcripts |
| F17 | D0 | Typed contextual chat | User can select screen/conversation attachments; bounded prior user and assistant turns are included explicitly in multi-turn context; Cancel/Retry preserve coherent request status |
| F18 | D0/V | Fast/Smart selection | Selected policy maps to configured model capabilities; unsupported vision/audio is blocked explicitly; show the chosen mode; exact commercial routing remains unverified |
| F19 | D0 | Streamed output and cancellation | Ordered request-tagged chunks render incrementally; cancel aborts transport and drops late events; partial answer remains marked incomplete; old output cannot replace a newer request |
| F20 | D0 | Structured coding solution | Includes understood problem, assumptions, approach, code, complexity, and edge cases; ambiguous screenshots require clarification; selected language is honored |
| F21 | D0 | Coding follow-up and debugging | Follow-up includes selected problem snapshot, bounded prior solution and exchanges; adding an error screenshot updates relevant context; reset clears problem-specific state |
| F22 | D0 | Interview types | Coding, debugging, system design, and behavioral presets have explicit output structures; remaining advertised categories are distinct configuration/data work rather than empty buttons |
| F23 | D0 | Prompt manager, modes, and note templates | Create/edit/duplicate/delete response presets and meeting-note templates; select per session; preview data included; configuration persists; restore built-in defaults |
| F24 | D0 | Profile and preparation material | Resume/background, role description, company context, and factual examples have visible import/edit/clear flows; PDF/DOCX/TXT extraction is previewed and size-bounded |
| F25 | D0 | Provider configuration | Separate chat and speech selection, model IDs, capability validation, safe connectivity check, custom compatible chat endpoints including explicit localhost, and actionable errors; secrets are masked and not returned to the renderer |
| F26 | D1 | Bundled local transcription | Model/runtime availability and supported architectures are visible; downloads are explicit and integrity checked; local speech never silently switches to cloud; compatible local chat belongs to F25 |
| F27 | D1/V | Smart search and citations | Explicitly enabled search reports the search data destination; citations resolve to supporting sources; no fabricated links; exact reference search routing remains unknown |

## Notes, storage, privacy, and delivery requirements

| ID | Priority | Requirement | Acceptance criterion |
| --- | --- | --- | --- |
| F28 | D0 | End-session notes and next-step drafts | Notes honor selected template and include summary, topics, decisions, action items, owners/dates when stated, and open questions; unsupported fields are omitted; user can request a source-linked follow-up draft; session saving is independent of notes generation |
| F29 | D0 | Library | Search by title/text/date; open notes, transcript, and answers; rename/edit; filter; resume with retained context; keyboard navigation and empty/loading/error states work |
| F30 | D0 | Local export and deletion | Export Markdown/JSON and copy selected text; recoverable deletion removes content from retrieval immediately; permanent deletion explicitly clears associated artifacts/backups subject to documented storage limits |
| F31 | D0 | Durable session recovery | Only committed transcript turns are reported saved; crash recovery is deterministic; save failure is visible; schema migrations preserve existing data |
| F32 | D0 | Context and meeting memory | Prior sessions are opt-in retrieval sources; retrieved items are attributable and editable/removable; no unbounded transcript accumulation or cross-session leakage |
| F33 | D0 | Credential/data controls | Credentials use OS-backed encryption; raw audio is not saved by default; user can disable history; provider destinations and retention behavior are visible |
| F34 | D0 | Settings and accessibility | Appearance, opacity, font size, shortcut preset, capture, language, context, and retention persist; keyboard/screen-reader navigation works; reduced-motion and readable contrast supported |
| F35 | D0 | Failure reporting | Distinguish credentials, quota, timeout, source/permission failure, unsupported capability, offline, disk failure, and cancellation; no automatic paid retry after uncertain completion |
| F36 | D0 | Diagnostic bundle | Explicit export contains versions, capability state, redacted error codes, and timings; secrets, screenshots, transcript text, and personal file paths are excluded |
| F37 | D0 | macOS package | Installable arm64 artifact with stable app identity; x64 artifact is gated by x64 testing; usage descriptions, bundled resources, migrations, permissions, and uninstall documented |
| F38 | D1 | Windows package and parity | Windows 11 capture/audio/shortcuts/data flows pass equivalent tests; DPI, monitor topology, and display-affinity behavior independently validated |
| F39 | D1 | Safe updates | Signed/provenanced artifacts, explicit update notice, idle install, data migration backup and rollback; live capture is never interrupted by an automatic install |
| F40 | D0 | Resource management | Bounded audio/image/context queues; overload is visible; sleep/device change tears down and re-establishes sources only with the session still active |
| F41 | D0 | Request usage visibility | Track available model usage/cost metadata; estimated values are labeled; no hidden startup/background requests or surprise cloud fallback |
| F42 | D0/V | Visual comparison baseline | Capture actual reference-app states before claiming pixel parity; proposed initial geometry/token values are clearly marked; Faangin branding uses original assets |
| F43 | D1 | Slide/context change tracking | Explicit opt-in on a selected display; stable-change captions reference immutable transcript sequence IDs; bounded polling/history; capture and caption failures are visible |
| F44 | D1 | Local integration interface | Optional redacted state and scoped controls with consent/revocation; asynchronous actions report settled state; same-user identity limits disclosed; stronger app identity requires native verification |
| F45 | D1/V | Expanded provider coverage | Map Cue's source-confirmed chat/speech adapter inventory to verified current official capabilities; expose only tested model/input combinations; no silent credential reuse or cloud fallback |
| F46 | D1/V | Managed inference access | Optional account/device-linked gateway, balance/usage disclosure, explicit consent, and secure revocation; use independently specified service contracts and credentials; do not reuse reference publication tokens |

## Full-product parity expansion

| ID | Priority | Surface | Required result and unresolved evidence |
| --- | --- | --- | --- |
| A01 | D1 | Calendar connection and pre-meeting briefs | Secure connection, upcoming meetings, revoke/disconnect, timezone correctness, preparation context; initially Google Calendar based on official evidence |
| A02 | D1 | Hosted note sharing | Authenticated publication, link visibility, revoke, deleted-session behavior, and participant privacy; local export alone does not pass |
| A03 | D1 | Accounts and device sessions | Sign-in/out, device linking, session expiration/revocation, account deletion, support recovery; commercial contracts remain unobserved |
| A04 | D1/V | Sync and cross-device state | Conflict resolution, settings/shortcut sync, offline edits, deleted-item tombstones; define observable reference behavior before matching it |
| A05 | D1/V | Entitlements, billing, usage credits | Plan/capability matrix, atomic credit accounting, receipts/cancel/refund states, idempotent events; price replication is not needed to prove desktop operation |
| A06 | D1 | Mobile companion | In-person capture, transcripts, chat, title/notes edit, copy/share/delete/resume/sync, supported device matrix; documented mobile v1 excludes call capture/invisibility; current billing/account-deletion behavior needs native verification |
| A07 | D1 | Interview preparation directory | Search, company filters, newest sorting, detail pages, and pagination over licensed/original content; no automatic reuse of proprietary question collections |
| A08 | D1 | Web utilities and product website | Download/version docs, topic/difficulty browser, company/offer comparison with data provenance/freshness, feedback/support; original copy/assets and accurate feature status |
| A09 | D1/V | Collaboration, administration, integrations | Evidence-first inventory of actual current features; enterprise roles/SSO/CRM are not assumed merely because a meeting assistant might offer them |
| A10 | V | Additional undetectability claims | Process invisibility, universal browser non-detection, and zero traces are unverified; inspectability, OS indicators, and arbitrary capture paths preclude an absolute guarantee |
| A11 | D1/V | Affiliate/referral operations | Referral links, disclosed calculator assumptions, attribution/dashboard and payout states; the reference advertises 30% and external Tolt operations, which were not exercised |
| A12 | D1/V | Version/account analytics surfaces | Changelog, prior builds, upgrade/comparison flow, migrations, and explicitly scoped analytics; changelog claims are not proof of current native behavior |

## Workspace interaction specification

The public Cluely demo establishes a compact pill, an answer panel, quick actions, composer, and Smart control. InterviewCoder establishes keyboard-oriented capture and interview operation. See the [research document](research/product-parity.md) for source-specific commands and discrepancies.

Proposed first-build layout: draggable session pill; expandable answer surface; optional transcript sidebar; screenshot tray in Interview mode; multiline composer; Stop/Retry/Copy controls attached to the relevant request. Library/settings occupy a separate conventional window. Numeric sizes and exact typography remain design choices until native reference measurements exist.

Required states: first launch, permissions missing, idle, starting capture, live, channel degraded, paused, capture stopping, generating, partial output, cancelled, offline, quota exhausted, save failed, notes pending/failed, empty library, recovered session, and unsupported privacy mode. Every state must expose a useful next action. A green recording indicator means capture is active, not simply that Start was pressed.

Reference compatibility presets are proposed, subject to native checks:

| Action | Cluely-style | InterviewCoder-style | Cue-style |
| --- | --- | --- | --- |
| Assist | Cmd+Enter | Map after native verification | Cmd+Shift+Enter |
| Suggested reply | Button or configured shortcut | Mode-dependent | Cmd+Enter |
| Screenshot/solve | Configure separately | Cmd+H capture; solve command to verify | Cmd+H solve |
| Reset problem | Configure | Cmd+G | Configure |
| Hide/show | Cmd+backslash documented | Cmd+B documented | Cmd+Shift+/ source-confirmed |
| Move | Configurable arrows | Cmd+arrows documented | Drag handle; no registered movement shortcut |

Cluely also documents Cmd+Shift+backslash for session start/stop and Cmd+Shift+Up/Down for scrolling. InterviewCoder's Cmd+H/G are thumbnail-derived candidates. All commercial native registrations require verification; Cue accelerators are source-confirmed rather than native-tested.

Do not register all presets simultaneously. Reserved shortcuts and collisions must be handled. Windows replaces platform modifiers only after validating registration and interaction behavior.

## Release targets

| Metric | Proposed gate | Measurement |
| --- | --- | --- |
| Hotkey acknowledgement | p95 under 100 ms | Native event receipt to visible acknowledgement |
| On-demand screen capture | p95 under 800 ms | Capture action to usable selected image, supported devices |
| Transcript partial | p95 under 800 ms, capable streaming provider | Audio frame time to first useful partial; report final-turn latency separately |
| Fast assist first useful content | p95 under 2.5 s | Request action to useful rendered content; split capture, network, and inference time |
| Smart/coding response | p95 first content under 5 s; full result under 30 s on benchmark fixtures | Report model, input size, connection, and output length |
| Stop capture | Within 250 ms target; pending OS acquisition never survives Stop | Track disposal of devices and all late acquisition paths |
| Durable commit | p95 under 250 ms after final turn | Final-turn receipt to transaction acknowledgement |
| Idle resource envelope | Under 350 MB RSS and under 2% average CPU on named baseline machine | Warm idle 10 minutes, no active capture |
| Active memory | Under 650 MB excluding optional local model | 60-minute dual-channel benchmark; bounded queues and no steady upward trend |
| Coding correctness | At least 90% on 50 fixtures per certified language/provider/mode combination | Public/original problems with independent tests; compile failures and timeouts count as failures; report every combination separately |
| Notes fidelity | At least 95% of stated decisions/action items; zero invented owners/dates in gate set | Twenty scripted meetings with two independent reviewers and adjudicated ground truth; report omissions and unsupported facts separately |

If a target cannot be met, report the measured result and revise the release scope explicitly. Do not redefine the stopwatch to conceal latency. Provider outages and regional variation are reported separately.

## Definition of done

A requirement is complete only with a working UI path, relevant contract tests, failure handling, documentation, and platform evidence when native behavior is involved. A backend function without reachable controls does not pass. Mocked tests do not certify native capture. A successful dev launch does not certify a packaged release.

D0 signoff requires all D0 rows, quality/security gates, and a complete fresh-install-to-library demonstration. Freeze a finite certification matrix after the capture spike: exact macOS/Electron versions, machines/architectures, display/capture paths, and initial provider/model/language combinations. Capabilities outside that matrix remain experimental. D1 has its own tracked backlog and evidence. Exact parity signoff requires a versioned reference baseline for every claimed behavior and a disclosed list of unknown or intentionally different surfaces.

## Open decisions

| Decision | Default recommendation | Gate |
| --- | --- | --- |
| First chat and speech providers | Select after credential decision; separate capability contracts | Before live integration |
| Minimum macOS and architectures | Provisional 14.4+ candidate; arm64 first; x64 after device validation | Capture/package spike |
| Exact visual and native baseline | Authorized reference-app observation with version/plan recorded | Before exact-parity claim |
| Managed service versus local provider credentials | Local provider credentials for the first desktop milestone | Product review; commercial parity tracked separately |
| Local STT distribution | Explicit verified model/runtime download; no silent cloud fallback | D1 local-runtime spike |
| Signed public release | Stable Developer ID/notarization arrangement | Before public macOS distribution |
| Retention defaults | Raw audio off; local transcript history on with visible controls | Privacy review |

These decisions do not prevent a detailed specification. They prevent claiming untested operation or starting unauthorized live API work.
