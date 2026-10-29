# Conversational responses: installed 0.4.3

Verified October 28, 2026. Faangin 0.4.3 is installed at `/Applications/Faangin.app`. The saved normal selection is **GPT-6.1 Sol in Smart mode, with Prefer Smart enabled**; **GPT-6 Luna is the Fast alternative**. The installed version, saved choices and “All changes saved” state were verified in the app. A readback confirmed that all other settings were unchanged. This completes implementation and the engineering verification below; it does not establish perfect future answers or human-rated naturalness.

## Diagnosed causes

The [initial pipeline investigation](response-delivery.md) traced separate microphone/computer capture through mono 24 kHz PCM, VAD, ordered Realtime transcription, source-aware context, prompt construction, streaming generation and Markdown rendering. The product has no generated-speech/TTS stage. Audio channels identify sources, not individual people; speaker identity is not inferred.

Rigid prompt contracts were the main delivery problem: fixed short Reply lengths, mandatory Solve sections and spoken STAR labels encouraged rehearsed or essay-like answers. Follow-up guidance could introduce unrelated coding checklists. The user feedback was qualitative; no original feedback corpus or independent human listening scores was available.

Two additional failures affected relevance and reliability. Six-second transport finals were treated as completed questions, and short silence endpoints split a natural synthesized “zero or one” question into misleading fragments. Separately, live model runs repeatedly violated the automatic `ASSIST` line header despite prompt refinements. Earlier failed runs remain in the evidence directory.

## Implemented behavior

- A shared delivery policy asks for direct, sayable language, natural contractions, proportional depth and useful transitions. It removes stock openings, routine closing offers, artificial hesitation and compulsory spoken labels. Code, equations and helpful structure retain their substance.
- Context and follow-up guidance respect the actual round and saved working state. Grounded behavioral stories use supplied facts; missing experience triggers a request for a real example. Corrections, negation, identifiers, uncertainty, complexity bounds and design units receive explicit protection. Explicit spoken time limits guide prose planning without truncating required technical material.
- `utteranceComplete` follows capture, validated IPC, the ordered transcriber and the reply coordinator. Continued transport chunks remain available as evidence while automatic generation waits for the endpoint final, including blank/small final tails. Stale, provisional, foreign-session and wrong-source guards remain enforced.
- Both silence endpoints are now **600 ms**, while six-second chunking and admitted audio bytes remain unchanged. On the unchanged public waveform, the former 320 ms setting split the question five ways; 600 ms retained one utterance with three continued chunks. This deliberately adds 280 ms versus the prior computer-audio endpoint and 200 ms versus microphone.
- Automatic OpenAI interview replies on the two selected models use a strict ordered schema, `{disposition, answer}`, in the same generation call. A bounded incremental decoder streams the decoded answer before JSON completion and suppresses WAIT. Malformed, truncated, extra-field and refusal outputs fail closed. Manual answers remain plain text; other models and compatible services retain the established line protocol. There is no rewrite call, hidden retry or silent model substitution.

Sol was selected after reviewing the actual technical and contextual outputs. Luna remains available for focused Fast requests. Sol uses low reasoning; Luna uses none except low for full Design. Model support was checked with real synthetic provider requests and the [official Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [structured-output](https://developers.openai.com/api/docs/guides/structured-outputs) documentation. New installations receive both model IDs; existing/custom choices are preserved. New-install mode preference remains unchanged. This machine's explicit selection is recorded separately below.

## Representative final before/after examples

These are excerpts from the final paired Sol runs, with the baseline compiler pinned to `6fd27174f03690b6c24d73b2db5da5d8ab3738e9`. Full questions and unedited answers are in the [development](../evaluation/conversational-043/typed-sol-development.json) and [holdout](../evaluation/conversational-043/typed-sol-holdout.json) reports.

**Grounded disagreement story.** The baseline ended with an unsupported personal takeaway: “My takeaway was that resolving a disagreement isn’t about winning the argument—it’s about making the options concrete enough to find a path both people can support.” The revised answer stops at supported actions and outcome:

> At Cedar, I was an engineer on the billing team, and a teammate and I disagreed about how to release a change. They preferred a large release, while I proposed a phased rollout.
>
> I wrote a rollback checklist to make the phased approach concrete. We agreed to release in phases, which resolved the disagreement, and the rollout completed.

**Changed shortest-path assumptions.** Both versions correctly selected 0–1 BFS. The revision explicitly explains why the previous rule must change: “First discovery no longer guarantees the shortest distance, so I’d remove permanent visited-on-enqueue marking and relax an edge only when it improves the recorded distance, updating the parent too.” It retains deque ordering, O(V+E) time and O(V) auxiliary space and explains why strict improvement avoids endless updates around zero-weight cycles.

**Already-strong control.** The baseline unique-constraint answer already used two direct sentences. The revision stays at two: “A database unique constraint prevents duplicate key values according to the database’s comparison and NULL-handling rules. It doesn’t guarantee that those values are accurate or meaningful.” No coaching introduction or closing offer is added. Both baseline and current return WAIT on the unfinished question.

## Completed verification

| Check | Observed result |
| --- | --- |
| `npm run verify` | 702 tests passed; zero failures/skips; typecheck and production build passed; 21 isolated desktop fixture requests passed |
| Packaged desktop workflow | The same 21 fixture requests passed against the packaged 0.4.3 app |
| Final paired provider evaluation | 24 current and 24 baseline generations; all expected disposition decisions passed; all seven current automatic requests used valid structured framing |
| Technical/grounding review | No material factual, grounding, contextual-intent or code-behavior error identified in the 24 current outputs by engineering agents |
| Generated-code checks | Each actual baseline/current binary-search function passed 58,344 finite cases; each deduplication function passed 19,452 |
| Exact prompt provenance | All 48 compiled-prompt hashes and both fixture catalogs match; all 24 baseline hashes match the preceding experiment |
| Selected Sol speech replay | One endpoint, three continued finals held, one generation call; correct 0–1 BFS and corrected 50,000 edges |
| Installed app/configuration | 0.4.3 visible in native menu and workspace; saved Sol/Luna IDs and Smart preference verified; other-settings hash identical |

The final paired measurements are below. First text is the decoded generation callback, excluding rendering/physical paint. Each suite has twelve requests per variant; first text excludes one WAIT per variant. These heterogeneous one-trial samples do not establish a universal speedup or a latency distribution.

| Suite/variant | Input/output tokens | Median first text | Median completion |
| --- | ---: | ---: | ---: |
| Development baseline | 20,136 / 2,347 | 1,657.7 ms | 3,425.5 ms |
| Development current | 21,028 / 1,851 | 1,716.2 ms | 4,074.1 ms |
| Holdout baseline | 18,922 / 1,587 | 1,507.6 ms | 3,004.6 ms |
| Holdout current | 18,495 / 1,437 | 1,675.6 ms | 2,660.7 ms |

Schema framing adds measured token overhead. The comparison includes the complete prompt/context/protocol policy; it cannot isolate the cost of JSON syntax. The [detailed review](../evaluation/conversational-043/review.md) includes protocol-specific timing and usage, failures and provenance.

The selected Sol speech replay observed 402 ms from final endpoint commit to final transcript, 120 ms from that transcript to dispatch, and 2,522 ms from generation request to first decoded text: approximately 3,044 ms from endpoint commit to first text. These are individual callback measurements on public synthesized PCM, with no audible playback or physical capture. The answer preserves the intended meaning, but the raw speech report correctly retains **`passed: false`** because recognition repeats/punctuates “zero Zero. Or one” and fails its original lexical regex. See the [speech review](../evaluation/conversational-043/audio-review.md); the check was not relaxed to manufacture a pass.

All live evaluation inputs were public synthetic examples. The isolated runtime reused the existing encrypted connection in memory and excluded saved profiles, private sessions, screenshots and physical voices. Human rating fields remain unscored. Initial holdout results informed later fixes, so final reruns are regression evidence, not an untouched generalization estimate. No fine-tuning was justified by the available evidence or training data.

## Installation, settings and rollback

The candidate is `dist/conversational-043/mac-arm64/Faangin.app`; the normal launch copy is `dist/mac-arm64/Faangin.app`. Both and `/Applications/Faangin.app` have identical `app.asar` SHA-256:

`4d8597e4590c7d77ffb90b93a9a61a8e0d4fcbed776e804f8917dad954231885`

These are local development artifacts, without a signed/notarized release claim. [Verification manifest](../evaluation/conversational-043/verification-manifest.json) retain source hashes and build/test logs.

Before selection, this machine used Fast `gpt-4.1-mini`, Smart `gpt-4.1`, Prefer Smart enabled. The saved selection now uses Fast `gpt-6-luna`, Smart `gpt-6.1-sol`, Prefer Smart enabled. Readonly [before](../evaluation/conversational-043/model-selection-before.json) and [after](../evaluation/conversational-043/model-selection-after.json) records confirm the same hash of all remaining settings. Credentials, profile, privacy and history settings were not changed.

To roll back model selection, set those two earlier IDs in Settings → Connection & models and save, keeping Prefer Smart enabled. To roll back the installed application, quit Faangin and restore the preserved `dist/installation-backup/Faangin-before-0.4.3-20261028.app` to `/Applications/Faangin.app`. The prior normal-launch bundle is also preserved at `dist/pre-conversational-043/Faangin.app`. Restoring a bundle does not reverse saved settings or database changes; keep the normal workspace backup/export practices.

## Remaining acceptance limits

The installed app's optional “Test chat generation” was started after version/settings verification. The Mac then locked before its final status could be read, so that UI test has no claimed result. Separate final provider evaluations above completed successfully.

Single-voice synthesis does not validate accents, noisy rooms, overlapping people, hardware capture, conferencing integration or long sessions. An observed silence endpoint does not prove semantic completion. Independent human listening judgments and physical-device trials remain unperformed. The observed changes improve the tested delivery and correctness cases; they do not certify perfection, universally correct recognition or arbitrary future generated code.

## GitHub publication — October 29, 2026

The source folder was found at `/Users/admin/Desktop/Desktop - Unknown/faangin` after the earlier path moved. Cloud-offloaded files were restored into an isolated local publishing checkout. All 39 source/test/package hashes match the verified 0.4.3 manifest. The five previously unpublished application commits are preserved, followed by the 0.4.3 change on `codex/conversational-responses-043`. Publication excludes credentials, dependencies, installers, machine state and generated launch/review media. The versioned synthetic evidence remains included. Main is left unchanged for pull-request review.
