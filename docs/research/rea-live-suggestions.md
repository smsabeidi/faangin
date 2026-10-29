# Static investigation of live answer suggestions

Investigation date: October 13, 2026. Audience: desktop, audio, inference, and application engineers.

REA was actually run against Cue and selected files recovered from the publicly downloadable Cluely and InterviewCoder clients. It recovered application graphs and Electron boundaries without starting any of these applications. The useful finding is that automatic live insights and a requested full answer are distinct operations. InterviewCoder's client contains a transcript-driven insights request and a separate answer request. This supplies a concrete architectural reference for adding explicit automatic assistance to Faangin; it does not expose the proprietary server's model or full prompt.

## Scope and provenance

The [REA repository](https://github.com/morluto/rea) is a local reverse-engineering CLI/MCP tool, not a speech recognition or answer-generation engine. REA-authored code is MIT licensed, with third-party licenses retained separately. No REA server was registered globally, no commercial analysis provider was installed, and no target application was installed or launched. No account login, user recording, credentials, private application data, or live model request was used. Proprietary client files remain in an isolated temporary audit directory and were not copied into Faangin.

| Input | Exact identity | What it establishes |
|---|---|---|
| REA source checkout | `94072364c7f8410b0e86e72c912c2611572b278f`, package metadata `6.4.0` | Current source documentation and tool contracts. |
| Executed published REA runtime | `rea-agents@6.4.0`; registry `gitHead` `a56f7bb668ab23fec8d33f7af353ac7ed2fe1895` | Exact CLI version used for the observations below; it is not identical to repository HEAD. |
| Cue source | `8dfe7165e845bf1d6e02b31a8bb67b80452cd56c`, package `0.2.4` | Public reference source, not a Cluely or InterviewCoder implementation. |
| Cluely public macOS client | `Cluely (New)` version `2.1.24`; bundle `com.cluely.app.april22` | Downloaded client implementation for this build only. |
| InterviewCoder public macOS client | Version `3.0.1`, Apple Silicon; bundle `com.interviewcoder.app` | Downloaded client implementation for this build only. |

Cluely's current [download page](https://cluely.com/download) loads a public JavaScript chunk containing the macOS link `https://api.v2.cluely.com/desktop-download/mac/latest.dmg?glass=bisect`. That route resolved to [Cluely (New) 2.1.24](https://desktop-glass-releases.v2.cluely.com/Cluely%20(New)%202.1.24.dmg). The InterviewCoder [homepage](https://www.interviewcoder.co/) loads public download-route definitions; [its macOS Silicon route](https://www.interviewcoder.co/downloads/mac-silicon) resolved to [InterviewCoder 3.0.1](https://downloads.v2.interviewcoder.co/downloads/interviewcoder-3.0.1-arm64.dmg). These are observed routes rather than guessed URLs. Releases and routing can change.

| Downloaded artifact | Bytes | SHA-256 |
|---|---:|---|
| Cluely DMG | 230,923,857 | `dbf0066cbe068a7c1de1b92f1e57f2b1b9c97be8b0878f0d3d1f18b5eebbd44a` |
| Cluely `app.asar` | 28,442,561 | `5ed201e85fc9de452b338887bffadca2a5dd1eef1f12fd101db81be02b0b28a0` |
| InterviewCoder DMG | 208,355,488 | `676fd1c8ea70636d26974d4dfc5be57e492c26d3fd06df183a0cf9e5b93485cf` |
| InterviewCoder `app.asar` | 206,100,163 | `528ea903d8dc6a1b42331ae7658689ab39e37fe63c09eef242475b2fa978fd78` |

Published REA package integrity: `sha512-Vj1zWfSlna5bphGoaoI/TcVBuYvze9u+OyPC3Shz8YkBqaCTqB4COnnRoX7XDwMpwI24ZlFEel2yEj0k8LTWEQ==`. The tool was installed under `/private/tmp/faangin-rea-runtime-20261013` with dependency lifecycle scripts disabled.

## Actual analyzer runs and their limits

The evidence directory is `/private/tmp/faangin-rea-evidence-20261013`. It contains the downloaded HTML, public website assets with URL/hash provenance, download redirects, original ASARs and unpacked companions, selected-source extraction manifests, source-offset probes, CLI results, and progress logs.

```sh
npm install --prefix /private/tmp/faangin-rea-runtime-20261013 \
  --ignore-scripts --no-audit --no-fund rea-agents@6.4.0

# Each public disk image was mounted at a temporary mountpoint using:
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint <temporary-path> <downloaded.dmg>
# Resources were copied, then the image was detached. No app executable ran.

node /private/tmp/faangin-rea-runtime-20261013/node_modules/rea-agents/scripts/rea.mjs \
  analyze-javascript-application <selected-source-directory> --format json --full-output

node /private/tmp/faangin-rea-runtime-20261013/node_modules/rea-agents/scripts/rea.mjs \
  inspect-artifact <copied-app.asar> --integrity-policy record-and-continue \
  --format json --full-output
```

Cue's input was a tracked-file export of the exact source commit, excluding installed dependencies and local test artifacts. Cluely's selected input contains 17 files: package metadata, main/preload, renderer HTML, and named chat/session/transcription modules. InterviewCoder's selected input contains 12 files: package metadata and all non-dependency application JavaScript/preload/HTML files recovered from its archive. Extraction used the existing `@electron/asar` package as a reader; it did not execute archive contents. Every selected file's path, byte count, and SHA-256 is recorded in `selected-source-provenance.json` beside its archive.

| Successful analysis | Parsed JavaScript files | Findings | Parse failures | REA evidence ID |
|---|---:|---:|---:|---|
| Cue | 97 | 655 | 0 | `ev_04f04dbb37128a71621a50c904f736a8c70ab3f6639f75bc4e6f25f3e6857aba` |
| Cluely selected files | 15 | 1,325 | 0 | `ev_1d1d86f92b9e5202ad7420dc8305fa3d5446702ca774d71818c3f7b70ec1b5e0` |
| InterviewCoder selected files | 8 | 332 | 0 | `ev_c55e222894ff3c884fd6522f994a43397f9008ee3f1f754521c2827cf5bba03c` |

All three successful results explicitly report **partial graph coverage**. Selected scope, dynamic IPC expressions, bundled aliases, and the analyzer's semantic result budget limit completeness. Zero parse errors establishes syntactic analysis of those files, not runtime reachability or product correctness. REA output was followed by direct inert-source reading to trace the feature.

The first Cue run failed because REA's internal macOS process-ownership helper invokes `xcrun swiftc`, whose default module cache was blocked by the sandbox. Rerunning with approved local compiler access succeeded; no target execution was involved. This published runtime predates HEAD's configurable temporary module-cache path.

The default whole-Cluely-ASAR run refused an integrity contradiction in the unpacked `electron-app-universal-protocol-client` ARM64 native addon: declared `bcd5c3203ecb79ab193381e4afe07d9d40f8677c83db8ca76ccdc3c39ba71f90`, observed `8328a184444a903ce947b1263a2317ce4da8cfcd238ad488120e71b6b0f17e69`. REA notes that signing or stripping after archive creation can produce this; the cause was not proven here. The original failure is retained in `cluely-asar-analysis.json`. Selected-source analysis must not be presented as a verified complete archive or native-code audit.

Whole-archive inventory subsequently succeeded with the explicit `record-and-continue` policy for both targets. It retained **two** Cluely and **109** InterviewCoder integrity contradictions, all in unpacked native files, as `observed-untrusted` bytes. This policy records discrepancies rather than bypassing them or claiming the metadata matches. Results are `cluely-asar-inventory.json` (evidence `ev_5e557e1482643f0d58e859f943f0780dcc6cba43202ca0a53b244b0118587b27`) and `interviewcoder-asar-inventory.json` (evidence `ev_75576e65bedd85a15922867c3789520ad96a5972f42145deca246f9eb580c443`). Inventory coverage is complete within its single inventory substep; semantic coverage remains limited to the selected-source analyses.

## InterviewCoder: automatic insights are a separate pipeline

The following are **static client findings** in the exact downloaded `3.0.1` build. Its packaged dependencies include Deepgram, AssemblyAI, and Recall's desktop SDK. Inclusion alone does not establish which provider a particular account uses.

1. Separate microphone and system capture services feed transcript objects containing source role, text, timestamp, and partial/final status. The Deepgram client requests a temporary session token from the platform, sends mono linear16 audio with its configured sample rate, and requests interim results, punctuation, and speech events. Interim text stays in a buffer; final text emits a transcript entry.
2. A transcript observer automatically posts an insights request when context changes. Its small-entry gate skips only when **fewer than five new entries** have accumulated **and every new entry contains at most two words**. One longer entry can qualify; five short entries can also qualify. This is a transcript-volume gate, not proof of semantic question detection.
3. The insights request includes session ID, transcript, previously processed entry count, previous action text, model/variant settings, and microphone/system transcription-provider headers. A local flag prevents concurrent insights requests. Push events named `live-session-insights-update` add returned actions to the active session, with deduplication and timestamp ordering.
4. A suggestion click calls the separate `aiResponsesService.triggerAi` path. That path first commits pending microphone and system transcriptions, creates a response using available context and selected screenshots, and streams backend response events. This avoids answering solely from a stale finalized transcript when the user requests help mid-utterance.
5. A distinct feature-gated branch can turn an incoming suggestion into a short streamed spoken word track automatically. The observed default flag for this branch is false. Its suggestion admission also considers the processed transcript count. Feature flags and account/server settings prevent treating this branch as universal product behavior.

The normal automatic insights request goes through `desktop.sessions.emit_live_session_insights`; a separate per-paragraph endpoint updates summary state in a language-dependent path. Full answers go through `desktop.ai.trigger.v2`, whose client parser handles streamed text deltas and errors. These identifiers are observations about the distributed client, not reusable credentials or an invitation to call a proprietary backend.

Primary local source anchors, recorded as Unicode code-point offsets in `feature-source-offsets.json`:

- `out/renderer/assets/main-CLCIkAdW.js`: push listener around offset 29,697; insights endpoint around 30,671; suggestion-click event around 501,044.
- `out/renderer/assets/window-DsQ9GEov.js`: gated word-track method around 693,120; manual answer trigger around 716,823; Deepgram setup around 809,253.
- `out/main/index.js`: native and Recall capture IPC contracts.

The server's question classifier, actual prompts, model selection, retrieval, rate limiting, retry policy, production latency, and quality are unknown. No authenticated endpoint or live push event was exercised.

## Cluely: the current glass client differs

Cluely's downloaded `2.1.24` client contains a different observed path from the InterviewCoder build above:

- Its main process captures microphone PCM and system PCM separately, broadcasting role-labelled audio through `chat-audio-data`. System recording wraps the bundled `audiotee` helper; microphone recording uses `node-record-lpcm16`.
- The renderer maintains separate `me` and `them` voice activity, resamples 48 kHz input to 16 kHz frames, and uses a local Silero VAD implementation with **300 ms redemption** and **300 ms pre-speech padding**. A timer ends long segments at **20 seconds**. The application bounds concurrent utterance-transcription work at **four**.
- On an admitted speech-end segment it packages WAV data and calls the platform's `transcription.transcribe` operation with language and `wavBase64`. Session transcript entries transition through a transcribing state into ready text. In the observed microphone path, system voice activity can replace microphone frames with zeros to reduce capture overlap.
- The chat client uses a persistent secure WebSocket connection to a named `ChatAgent`, with state synchronization and reconnection handling. A submitted message includes ready transcript content newer than the prior message's transcript watermark. Pending audio can also be uploaded for an answer request.
- The observed main chat submission occurs through user action handlers. The selected-source audit did not establish an always-on automatic full-answer trigger in this build. That is a coverage-limited result, not proof that every Cluely version or server mode lacks automatic assistance.

Relevant local anchors are `dist-electron/main.js` (`chat-audio-data` around offsets 504,512 and 505,145), `dist/assets/transcription-D8utNpim.js` (VAD setup around 421,215; transcription request around 422,223), and `dist/assets/chat-DIvku-qQ.js` (WebSocket configuration around 277,413; transcript watermark around 752,231). Their extraction hashes are recorded next to the artifact.

Cluely's [public download page](https://cluely.com/download) describes meeting notes and real-time assistance. Public positioning and a distributed client do not reveal the hosted model, prompts, backend state, or measured latency. The two inspected products should not be treated as one shared architecture merely because both expose a floating answer interface.

## Cue: readiness does not mean automatic generation

The public [Cue renderer at the audited commit](https://github.com/Blueturboguy07/cue/blob/8dfe7165e845bf1d6e02b31a8bb67b80452cd56c/renderer/renderer.js) accumulates the remote speaker's transcript into the composer. English-pattern heuristics assign question readiness and a **1,800 ms** idle timer updates the ready state. The timer prompts the user to submit; it does not invoke the answer endpoint. Enter submits an STT-filled question through `answerThis`; the separate `say` action uses recent conversation for wording. This matters when diagnosing a user who hears speech but expects an answer without a click.

Cue is GPL-3.0-or-later. The audit supplies behavioral evidence and architectural lessons; no Cue application code is being copied into Faangin. See [the earlier Cue audit](cue-audit.md) for full provider, platform, quality, and licensing limits.

## Application to Faangin

The common useful structure is independent audio channels, evolving transcript state, a bounded context manager, an explicit trigger policy, cancellable streamed generation, and an interface that displays partial text immediately. REA is a development-time analysis tool; it does not belong in the interview runtime.

Faangin's 0.2.3 implementation adds an **explicitly enabled product mode** that dispatches a transcript-based Reply after an admitted utterance on the chosen audio source. It coalesces finalized fragments for 350 ms, rejects blank or punctuation-only finals, suppresses replayed transcript IDs and older delayed targets, keeps one generation active and the latest pending target, and invalidates pending work on stop, pause, source/session change, or manual takeover. Starts are spaced by at least three seconds and capped at six per rolling minute. It uses finalized context at the target utterance and sends no screenshots automatically. These are Faangin policy decisions, not a claim to have recovered the competitors' private classifier. Statements and short meaningful follow-ups can trigger; there is no language-dependent question or filler classifier.

Manual Reply remains available when the user wants to request help directly, including while an automatic reply is running. Remote calls normally use the system channel; in-person speech can use the microphone channel, which cannot independently distinguish candidate from interviewer. Settings state that limitation and explain provider usage. Live suggestions remain off by default; the engineering checks did not enable them in the primary workspace.

For latency, measure the path from speech end to finalized transcript, trigger dispatch, provider first token, and first paint separately. Local VAD and batching can reduce avoidable waiting, but silence alone cannot prove a question has ended. Preserve contextual correctness through bounded finalized context, explicit speaker source, request cancellation, and stale-session protection. The numbers recovered above are client constants; this audit establishes no competitor timing SLO or nanosecond response claim.

Acceptance should exercise fragmented questions, filler, duplicate finals, a new question during generation, source choice, manual takeover, pause/stop/restart, session changes, failure recovery, and absence of unsolicited requests when disabled. Real microphone/loopback accuracy, live provider latency, and spoken-answer quality need separate controlled tests; static analysis and fixture transport cannot certify them.
