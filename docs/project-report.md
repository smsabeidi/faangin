# Faangin project report

Date: October 12, 2026  
Status: public-source research complete; macOS 0.2.0 candidate packaged and undergoing acceptance  
Platform sequence: macOS first, Windows second

## Executive assessment

The references describe two related products. Cluely centers on assistance during meetings and the notes that follow them. InterviewCoder centers on screenshot and audio context for technical and behavioral interviews. Cue provides an inspectable implementation of the shared desktop pattern: a floating panel with screen, microphone, and system-audio inputs.

A comprehensive implementation is feasible as a desktop product. A claim of complete equivalence is premature. Public documentation cannot establish commercial prompt behavior, model routing, native capture behavior, account limits, pixel geometry, or private service contracts. The specification therefore separates documented features, source-confirmed behavior, and open verification questions. Each release needs evidence for the exact feature and platform it claims to support.

The first implementation milestone is a complete macOS application spanning onboarding, capture, transcription, meeting assistance, coding practice, personalization, session history, and packaging. Windows follows with the same domain contracts and a separate native validation gate. Calendar integration, hosted sharing, accounts, billing, mobile, and ancillary web tools remain explicit parity workstreams; completing the first desktop milestone does not complete every reference surface.

## Research method and limits

Three specialist reviews cover product evidence, desktop source, and reliability/security. The integrated design and delivery plan establish ownership and review gates. This is a working engineering team for the project, rather than a claim that external employees have been hired.

The source review uses Cue commit `8dfe7165e845bf1d6e02b31a8bb67b80452cd56c` and its checked-in dependency lock. The product review uses official sites, help pages, and release material retrieved October 11, 2026. Cluely's public demo controls and InterviewCoder's thumbnail/brief playback sample were inspected in the browser; InterviewCoder's full demo was not viewed. These establish layout and advertised interactions, rather than desktop operation.

No commercial account was created, paid plan purchased, commercial binary executed, or user meeting recorded. No live AI-provider request was made. Firecrawl was unavailable, so the public research used the available web and browser tools. Native app behavior and commercial plan entitlements remain untested. Detailed sources and contradictions are in the [product evidence ledger](research/product-parity.md).

The workspace began with an MIT license and no application files. The initial research produced this report and the implementation specification. The subsequent desktop implementation adds Meeting and Interview workspaces, streamed OpenAI assistance, separate audio sources, screen context, personalization, notes, local sessions, and macOS packaging. Its checked behavior and remaining release gates are recorded in the [build verification record](engineering/build-status.md).

## What the references establish

| Reference | Core product pattern | Evidence strength | Important uncertainty |
| --- | --- | --- | --- |
| Cluely | Meeting context, quick assistance, notes, customization, and calendar preparation | Official public UI and help documentation | Commercial app behavior, exact layouts, routing, entitlements, and private service APIs |
| InterviewCoder | Interview-oriented assistance, screenshot workflows, audio, prompt controls, and keyboard operation | Official public pages, help, and change history | Exact screenshot state flow, output format, latency, private models, and cross-platform equivalence |
| Cue | Electron overlay, separate input channels, provider adapters, local transcription, and meeting memory | Source inspection and unit-suite execution at a pinned commit | Physical-device audio, packaged macOS local runtime, real capture exclusion, and UI exposure of backend capabilities |

The references overlap in their primary loop: gather context, request an answer, stream useful output, then continue without losing the active task. The proposed product unifies those loops into Meeting and Interview workspaces. It does not force the user to manage separate applications.

## Findings that change the design

1. **Visibility is a platform capability, not an absolute product promise.** Current Electron documentation explicitly says newer macOS applications using ScreenCaptureKit can capture a protected window. Its Windows implementation also has timing and platform conditions. Faangin will report tested combinations and unsupported states. A protected flag is insufficient proof. [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable).
2. **macOS audio is a first-order dependency.** Current Electron documents a newer CoreAudio Tap capture path and a required usage-description key; missing metadata can produce a dead audio stream. The capture spike must validate a packaged app before the renderer is built around assumptions. [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer).
3. **Cue is a useful reference, not a drop-in complete product.** Backend profile and history capabilities do not automatically imply usable product flows. Its audit identifies packaging, cancellation, and durability gaps. The implementation should retain the architectural lessons while independently establishing end-to-end behavior. See [source audit](research/cue-audit.md) and [reliability audit](research/reliability-audit.md).
4. **Public claims conflict.** Product download pages, support requirements, and older documentation do not always agree. The parity ledger preserves those contradictions instead of selecting whichever claim is most convenient.
5. **Feature access is part of the operation.** The reference products distinguish download access, model access, and premium capabilities. A local bring-your-own-provider release is a deliberate delivery choice; it does not reproduce their commercial entitlement systems.
6. **The difficult work is lifecycle correctness.** Permission revocation, source changes, pending capture completion after Stop, provider timeouts, disk failures, and packaged-runtime availability can break a polished overlay. These are release gates.

## Cue verification result

The source engineer ran Cue's locked unit suite: **292 passed, 0 failed, 0 skipped** under Node 26.7.0 after installing dependencies with lifecycle scripts disabled. This validates the tested source contracts. It does not validate a running overlay, signed package, real microphone, live provider, local model inference, or screen-share compatibility.

Dependency-audit details, commands, environment limitations, and source findings belong in the [Cue audit](research/cue-audit.md). These are reference-project results. Faangin's separate implementation tests are reported in the [build verification record](engineering/build-status.md).

## Product direction

The application should feel familiar through its interaction pattern: compact movable overlay, streaming answer panel, transcript sidebar, screenshot tray, quick actions, keyboard controls, and a full settings/library window. Proposed geometry and visual tokens are implementation decisions until measurements from the target apps are available.

Two primary workflows share the same capture and context engine:

- **Meeting:** start capture, inspect channel health, request assistance or follow-ups, recap, end the session, review and edit notes.
- **Interview practice:** prepare background and prompts, collect screenshots or spoken context, extract the problem, select a language, generate an explanation and solution, follow up, reset the problem independently of the whole session.

Personalization supplies factual context. It must not invent employment history, experience, or accomplishments absent from the user's material. Model output remains editable and attributable to its input context. Useful uncertainty handling belongs in both workflows.

## Ownership and handoff

| Workstream | Accountability | Required review |
| --- | --- | --- |
| Product and interaction | Evidence ledger, requirement IDs, workspace flows, visual baseline | Platform and quality review |
| Desktop platform | Permissions, windows, shortcuts, screen/audio capture, packaging | Security and physical-device review |
| Context and inference | Speech events, prompt construction, streamed responses, provider adapters | Reliability and quality evaluation |
| Data and privacy | Credentials, session transactions, retention, import/export, recovery | Security and migration review |
| Reliability and release | Test harness, native matrix, metrics, failure injection, artifact provenance | All component owners |
| Technical lead | Shared contracts, dependency sequencing, scope control, final release decision | Independent findings resolved or accepted explicitly |

The detailed [delivery plan](engineering/delivery-plan.md) converts these responsibilities into implementable work packages. Engineering reviewers receive the same PRD, source audits, and release gates. A second review should challenge the design before implementation begins.

## Readiness

Ready: evidence ledger, initial macOS scope, requirement inventory, process boundaries, failure model, first-build work packages, and validation criteria.

OpenAI is selected for the first build. The user will enter a replacement key through the app's encrypted Settings; no key from chat is saved in the repository. The application uses Electron 44.7.0. Needed before public release: live provider and physical macOS capture/audio verification, signing/distribution, quality evaluation, and measured resource/latency results. Needed before exact parity signoff: hands-on access to the reference desktop apps and versioned observations of the relevant commercial features.

## Portfolio presentation

The public repository should contain concise product documentation, genuine design decisions, reproducible setup, meaningful tests, measured demos, and accurate feature status. Original work keeps its existing license. Third-party reuse requires the applicable attribution and license notices. Commit history should describe actual changes; contributors and results should reflect work that happened.

Use Faangin branding and original visual assets. Reference comparisons should identify the features reproduced and the remaining limitations. A strong portfolio claim is supported by a working demo and a reproducible engineering result. An unsupported claim of 100% equivalence is not a substitute for either.
