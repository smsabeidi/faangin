# Verification and release evidence

Status: release certification plan; executed checks are recorded separately · October 11, 2026  
Requirements: [PRD](../prd.md)  
Performance targets live only in the PRD; this document defines how to measure them.

## What is already verified

Cue's source suite passed 292 tests under Node 26.7.0. The source team installed locked dependencies with lifecycle scripts disabled and recorded the dependency advisory result. The reliability team reproduced three lifecycle failures using unchanged reference function bodies in an offline VM harness with media/provider stubs. These results concern Cue, not Faangin.

Faangin now has an Apple Silicon application and local DMG/ZIP packages. Automated regression, build, isolated packaged workflow and earlier native UI checks are recorded in the [build verification record](build-status.md). Live provider, physical audio, signed distribution, performance certification and commercial-native parity remain unverified. See the [source audit](../research/cue-audit.md) and [reliability reproductions](../research/reliability-audit.md) for the separate reference-project evidence.

## Evidence record

Every claimed passing requirement needs: requirement ID, application commit, packaged artifact digest, OS/build, hardware/architecture, Electron version, provider/model/mode, language/source/display/capture configuration, fixture ID, procedure, expected result, actual result, timestamp, and evidence path. Use pass/fail/blocked/experimental; blocked is not pass. Record failures as well as successful runs.

Reference parity records additionally identify product/version/plan, observed state, and whether it came from a native observation, public UI, documentation, or source. Generated wording can differ; correctness and behavior are assessed against the specified contract.

## Finite certification matrix

Freeze the exact matrix after W02. Before freezing, the candidate coverage below is a test obligation, not a promise of support. If a row cannot be tested, narrow the stated support explicitly rather than assuming it passes.

W02 produces a registry of exact configuration tuples with stable row IDs: OS/build, hardware/architecture, Electron/artifact, source/device, display arrangement, capture application/version/mode, provider/model/mode, and language. Freeze **N** claimed-support rows and report pass/fail/blocked out of N. Certified scope contains zero failed or blocked rows. Specify deliberate pairwise coverage and which combinations require a full cross-product; privacy claims require every exact claimed capture application/mode tuple and cannot be inferred from a neighboring row. The exact tuples and N remain release-certification outputs; the current local artifact has not completed the physical-device matrix.

| Axis | Candidate coverage | Certification rule |
| --- | --- | --- |
| macOS | Minimum candidate 14.4; capture-regression boundary 15.4; current shipping release/build at implementation time | Physical-device packaged tests at minimum/current; boundary tests where available; untested OS versions remain outside certified rows |
| Architecture | arm64 first; x64 planned | Name CPU/RAM/machine for each; x64 remains experimental until its full relevant suite passes |
| Displays | Built-in Retina, external display, mixed scale, disconnect/reconnect | Source identity/crop/scale and on-screen overlay recovery checked |
| Audio | Built-in mic, wired device, Bluetooth route change, default-output loopback | Known distinct source signals, actual audio frames/energy, independent failure recovery |
| Privacy/capture | Full-screen and window sharing in named Zoom/Teams versions, Meet/browser version; native screenshot and ScreenCaptureKit recording harness | Store exact capture mode/settings; capability unsupported/fail is reported; no blanket invisibility badge |
| Inference | Initial chosen chat/vision model and streaming speech provider; custom compatible endpoint via local fixture | Pin tested endpoint/model/capabilities; other model IDs experimental; localhost fixture does not prove real local model quality |
| Languages | Initial certified coding language(s), audio input language(s), response language(s) | Publish exact tested combinations; UI distinguishes available from certified |
| Network | Normal, offline, disconnect, timeout, restricted credentials, rate limit, quota exhausted | No silent retries/dispatch loops or late context mutations |
| Distribution | Fresh dev build, installed release artifact, update from prior schema/artifact | Signed identity/notarization verified for public release; ad-hoc dev behavior documented separately |

Windows follows in D1 with Windows 11 x64, mixed-DPI displays, real microphone/loopback, named capture applications/modes, sleep/device changes, installer/update, credential vault, and migration tests. Remote sessions/VMs are separate configurations; results are never extrapolated from physical-console tests.

## Layered validation

### Contract and state tests

Use deterministic clock, transport, permission, and storage doubles. Test meaningful invariants instead of mirroring source text:

- Start twice creates one capture generation. Stop before permission resolution disposes the late stream and every track. Resume allocates a new generation.
- Stop freezes admitted speech request IDs; only their matching sequence bounds finalize within five seconds. Unsent audio is dropped visibly. Clear/reset advances transcript epoch and rejects all old final/partial events.
- Capture Stop does not pretend to cancel an independently requested answer. Answer Cancel aborts its real transport, produces one terminal event, and cannot replace later output.
- Request disposal completes or quarantines/terminates the worker by its deadline; a stuck provider cannot prevent the next eligible request forever.
- Partial revisions replace one segment; duplicate final events commit once; reconnect preserves sequence IDs and does not duplicate turns.
- Quota/auth failure transitions the persistent channel-provider state. Multiple new utterances produce no new calls until explicit permitted recovery. No timer bypasses the circuit state.
- Transcript/source/session isolation survives reset, resume, new session, and history retrieval. Prior assistant answers are included only in the correct bounded conversation.
- Invalid sender/frame/origin, unknown channel, oversize payload, unsupported MIME/model, and stale request are rejected before privileged work.

### Transport and persistence integration

Run adapters against local mock HTTP/WebSocket servers that support partial output, malformed events, delayed completion, connection loss, 401/403/429, exhausted quota, hanging sockets, and cancellation. Observe server-side disconnect rather than only UI status. No paid request is needed for these tests.

Inject disk-full/denied/corrupt-database/save-failure conditions. Commit acknowledgements must match durable repository status. Terminate the process around transaction boundaries and verify acknowledged segments survive under the selected SQLite durability configuration. Test migrations on versioned fixtures, partial migration rollback, private file paths, backup restoration, and deletion across transcript/answers/notes/attachments/search/trash/backups.

Verify that raw/decrypted secret values never appear in backend settings responses, logs, error strings, diagnostic bundles, backups of nonsecret settings, or renderer API readback. Ciphertext also stays out of surfaces that do not need it. Transient user key entry is distinct from backend secret retrieval; clear entry buffers after secure submission and never refill the field from the vault. Test vault unavailable/locked states. Secret-protection claims reflect the OS threat model rather than assuming protection against every same-user process.

Import fixtures include valid PDF/DOCX/TXT, unsupported MIME, malformed archive, excessive expansion, large files, embedded links/resources, and prompt-like instructions. The parser makes no network requests, returns inert text, times out within budget, and leaves no temporary sensitive files after completion/failure.

### UI and end-to-end workflows

Test real Electron windows with a deterministic fixture provider for predictable flow assertions; run a small separately authorized live-provider smoke for capability validation. Label the two modes clearly.

| Test | Mapped requirements | Pass condition |
| --- | --- | --- |
| T01 Fresh install/onboarding/denial | F01/F25/F33/F37 | No capture/request before action; independent permission recovery; usable idle state with truthful missing capabilities |
| T02 Overlay controls/keymap | F02–F05/F34/F42 | Move/resize/collapse/hide/scroll/click-through/recovery; conflicts shown; all controls keyboard accessible and bounds recover |
| T03 Selected screenshot/problem tray | F06/F07/F20/F21 | Correct display/crop/scale, readable code, import/reorder/remove, capture failure stops request, problem reset scope correct |
| T04 Dual-source live session | F08–F12/F40 | Known mic/system signals stay distinct; partial/final changes stable; source failure/hotplug is visible and recoverable |
| T05 Meeting assistance | F13–F19/F32/F41 | Each quick action uses the correct selected context; answer history is bounded; cancellation and usage shown accurately |
| T06 Interview flows | F20–F24 | Coding/debug/system-design/behavioral presets reachable; correct language/profile; missing facts disclosed; follow-up retains selected solution |
| T07 Notes and library | F23/F28–F32 | Save independently of generation; template/edit/search/copy/export/trash/restore/resume; opt-in history retrieval and deletion respected |
| T08 Settings and diagnostic export | F25/F33–F36/F41 | Preferences survive restart or error is shown; secrets absent; export contains only defined metadata |
| T09 Stop, clear, quota and races | F10/F19/F31/F35/F40 | No late capture leak, old transcript mutation, repeat quota loop, timeout wedge, or hidden background inference |
| T10 Installed artifact and long session | All D0 | Same workflows outside dev tree; packaged dependencies present; clean restart/recovery and measured resource bounds |

## Physical macOS tests

Capture two distinct known speech tracks: one through a microphone route and one through the system output route. Check the resulting channel audio and transcript; a zero meter alone is not evidence of silence or denied access. Revoke permissions mid-session, select unavailable devices, unplug outputs, change default routing, sleep/wake, and relaunch the installed artifact after permission changes.

Run Stop during pending OS acquisition and prove tracks close, the OS indicator clears as expected, and no frames/dispatch continue. Test every owned window for the stated visibility mode, including settings/library/dialogs. Record captured frames from the exact target application and mode; do not use a content-protection getter as the test oracle. Modern ScreenCaptureKit capture must be included because the documented limitation is material.

Keep accurate process identity and a reachable menu/shortcut stop action. Observe OS recording indicators and system process tools as part of limitation reporting. No test claims a process is absent simply because a Dock icon is hidden.

## Quality benchmarks

**Coding:** 50 versioned public/original problems per certified language/provider/mode, stratified easy/medium/hard and by algorithm family. Independently authored expected tests include constraints and edge cases. Compile errors, invalid code, wrong complexity when material, timeouts, and non-solutions count as failures. Execute generated code only in an isolated test runner with resource/network limits; the desktop product does not execute it. Report each combination and difficulty band, not just aggregate accuracy.

**Notes:** 20 scripted meetings with ground-truth decisions, actions, owners/dates, open questions, and intentionally ambiguous statements. Two independent reviewers label outputs; disagreements are adjudicated. Count omissions and unsupported facts separately. Test selected templates and long-session coverage. An invented owner/date fails the gate even when overall recall is high.

**Behavioral grounding:** fixtures with missing accomplishments, contradictory profile data, absent dates, and prompted exaggeration. Outputs must remain tied to supplied material; uncertainty is acceptable, fabrication is failure.

**System design:** fixed prompts with load/capacity constraints and explicit units. Review arithmetic, assumptions, bottlenecks, trade-offs, and consistency of follow-up changes. This is a rubric, not a claim to match a proprietary model.

**Speech:** audio corpus with ground-truth text, silence, overlapping channels, background noise, accents, and tested languages. Report word error rate for relevant languages, character error rate where appropriate, partial/final latency, duplicate/revision counts, and dropped audio. The reference's marketing accuracy percentage has no shared published denominator and is not treated as directly comparable.

**Research citations in D1:** validate URLs, claim support, stale sources, cancel, and no fabricated citations; separately assess search latency and data transmission.

## Performance measurement

Use a named baseline machine and a pinned artifact/provider/model. Warm idle 10 minutes; active dual-source sessions 60 minutes, with representative assistance and coding requests. Collect at least 100 samples for each latency percentile claimed. Report p50/p95/max, failures/timeouts, sample count, input/output lengths, and network conditions. Include failed requests in reliability statistics rather than quietly excluding them.

Measure action-to-first-useful-output and its stages: capture, context, transport, provider first content, render. Do not report connection acknowledgement as useful output. Timestamp audio frames and actual transcript events. Record queue high-water marks, byte/duration bounds, dropped work, average/peak RSS and CPU. Optional local model memory is reported separately, never hidden.

Use the thresholds in the [PRD release-target table](../prd.md#release-targets). Targets apply to certified configurations. If the sample set is too small or a provider outage prevents a result, mark it unverified and preserve the observation.

## Security and release signoff

No unresolved high-severity issue on a reachable trust boundary. Dependency advisories are assessed for shipped/runtime reachability and remediation; a raw advisory count alone is not an exploit count. IPC validation, renderer isolation, safe output rendering, external-link policy, vault behavior, import isolation, native-helper scope, signed artifact provenance, and data deletion have explicit evidence.

The release report lists every D0 requirement and its evidence, all failed/blocked/experimental combinations, measured targets, known limitations, artifact digest, and reproducible demo procedure. Publishing claims use only that report. D1 features and exact-parity unknowns remain open even when D0 passes.

## Current next verification actions

Follow the [interview acceptance sequence](release-readiness.md#native-acceptance-sequence) after a replacement key is entered in app Settings and the Mac is unlocked. Freeze the supported physical-device matrix, measure live latency and answer quality, and verify a signed distribution artifact. The procedures in this plan remain obligations until their outcomes appear in the build verification record.
