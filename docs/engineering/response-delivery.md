# Conversational interview responses

October 27, 2026. Baseline: `6fd2717` (Faangin 0.4.2 source).

This records the initial response-delivery checkpoint. The [0.4.3 follow-up](conversational-043.md) adds model selection, protocol and semantic safeguards, design reasoning, and a 600 ms silence endpoint. Historical measurements below are retained as observed rather than rewritten to match the newer implementation.

The target is a capable professional answering the actual question aloud: direct, grounded, technically complete, and responsive to the conversation. Natural delivery must not change the algorithm, evidence, qualifications, or candidate history.

## Pipeline investigation

| Stage | Actual implementation | Finding |
| --- | --- | --- |
| Capture | `src/capture/index.ts`, `pipeline.ts`, `pcm-worklet.js` | Microphone and computer audio have separate tracks, processing, VAD and transports. PCM is mono, 24 kHz, 16 bit in 20 ms frames. There is no generated speech/TTS stage. |
| Segmentation | `src/capture/vad.ts` | This checkpoint used 320 ms for computer audio and 400 ms for microphone; the 0.4.3 follow-up uses 600 ms for both after measuring a real recognition failure at shorter pauses. Continuous speech is committed in 6 second transport chunks. The baseline did not distinguish a transport chunk from a completed utterance downstream. |
| Transcription | `src/main/inference.ts`, `transcription-context.ts` | Realtime transcription uses client commits and ordered final publication. Existing instructions preserve technical vocabulary, negation, numbers and corrections. No transcript paraphraser or cleanup model is used. |
| Attribution | `interview-conversation.ts`, `live-reply-context.ts` | Audio sources are explicitly unverified role hints. Multiple people can share either source. No reliable speaker diarization is claimed. |
| Dispatch | `live-replies.ts`, `src/main/index.ts` | Finalized selected-source speech triggers a bounded coordinator; partials defer/cancel stale work. Manual spoken answers flush admitted audio. Automatic interview output makes an ASSIST/WAIT decision in the same model call. |
| Context | `prompts.ts`, `interview-working-context.ts`, `interview-situation.ts` | Bounded working solutions, supported profile, quoted scenario revisions and prior exchanges preserve continuity even when general history is off. Explicit corrections override generated assumptions. Partial speech is marked as provisional. |
| Generation | `prompts.ts`, `inference.ts`, `compatible-chat.ts` | Both supported chat transports receive the compiled policy. Baseline guidance emphasized fixed formats and brevity, with little explicit spoken-language guidance. |
| Presentation | `interview-response.ts`, `answer-stream.ts`, `AnswerText.tsx` | The decoder strips only automatic decision framing. The renderer presents the answer as Markdown, publishes the first useful text immediately and batches later updates. There is no answer rewriting, artificial typing cadence, or speech prosody control. |

## Diagnosed causes

The user supplied consistent qualitative feedback about scripted delivery. There is no checked-in corpus of those users' original answers or independent human naturalness ratings. Historical synthetic evaluation in `hands-free-interview.md` establishes five routing/correctness examples, not a naturalness benchmark.

The strongest actionable evidence is in the prompts: spoken Reply defaults to two to four sentences even when the question needs more; Solve mandates named essay sections; Behavioral mandates STAR labels; and explicit direct-delivery guidance is concentrated in Fast mode. These constraints can produce rigid, repetitive language or compress a behavioral story too aggressively. Missing guidance on contractions, conversational transitions, supported first-person wording, question depth and follow-up continuity leaves delivery to model defaults.

A separate real-time defect can cause a polished answer to the wrong fragment. The six-second VAD commit exists to bound transport latency, but the baseline passes each chunk's provider-final transcript into the same automatic reply path as a silence endpoint. A provider final means recognition finished for those bytes; it does not mean the person finished asking. The existing settling delay cannot reliably bridge a long ongoing utterance.

Existing context grounding and source boundaries are substantial and remain necessary. The investigation did not establish a need for transcript rewriting, new speech models, fine-tuning, or a second generation pass. There is no suitable training corpus in the repository to justify fine-tuning.

## Delivery acceptance criteria

- Answer the present question directly, with enough depth for its wording, role, seniority, format and explicit time budget. Focused follow-ups should explain the change rather than repeat the entire prior answer.
- Use sayable sentences, ordinary transitions, natural contractions where appropriate, varied sentence lengths and a composed professional tone. Preserve the selected output language.
- Avoid repeated openings, stock praise, unnecessary question restatements, forced signposting, corporate jargon and essay conclusions. Do not insert filler, fake hesitation, errors or slang.
- Preserve correctness, assumptions, causal reasoning, uncertainty, trade-offs, complexity, equations, identifiers, code and meaningful verification cases. Structure remains appropriate for code and longer design explanations.
- Ground personal claims in the supplied profile or conversation. Generated suggestions are not proof of actual experience or a statement the candidate spoke. Ask for a real example when evidence is missing.
- Preserve uncertain or corrected transcript details. Ask one concise clarification or state a conditional assumption when ambiguity materially changes the answer. Do not confidently complete an unfinished question.

## Implementation

The response compiler uses a compact action-sensitive delivery policy in `src/main/response-delivery.ts`. It applies to interview assistance in Fast and Smart modes and to spoken meeting replies. Notes, recaps, source-linked drafts and generated follow-up-question lists retain their document contracts. Requested code, equations and useful structure remain supported; output token ceilings are unchanged. User response presets remain intact.

Revision guidance is scoped by the saved interview round, with explicit Behavioral, Design, Solve and Debug actions taking precedence. A standalone typed question without scenario evidence no longer receives an empty interview-situation ledger and its unrelated revision checklist. The original request, factual background, role and round remain intact. Source-equivalence evaluation permits only that empty derived-field omission; it rejects changes to raw evidence or a meaningful situation.

The implementation removes mandatory introductory Solve labels and spoken STAR labels, makes reply length proportional to the question, and preserves source-grounded narrative facts. It discourages routine closing offers and self-review when the requested deliverable is the answer itself. Technical scenario changes still require rechecking the invariant rather than copying a previous algorithm's state rules. System design must identify what its retry, consistency and deduplication mechanisms can actually guarantee and check quantitative conversions.

Automatic conversation excerpt truncation now propagates to the overall context metadata. The UI can accurately report omitted context even when the ordinary transcript and situation excerpts fit their budgets.

VAD commit metadata now distinguishes continuous-speech transport chunks from utterance endpoints. That distinction follows the existing validated capture IPC, ordered transcription commit queue and automatic reply coordinator. Continuing chunks remain available as transcript evidence but hold automatic dispatch until the utterance ends. This does not rewrite recognized words, infer a speaker, add an LLM classifier, or add a post-generation style pass.

The streaming renderer and automatic framing decoder are unchanged. Generated text and code still arrive as produced; the app does not replace words, inject filler, alter code, or artificially pace the display.

## Evaluation method

`npm run eval:delivery` compares the frozen baseline compiler at `6fd27174f03690b6c24d73b2db5da5d8ab3738e9` with the current compiler. Twelve synthetic fixtures cover technical explanation, focused follow-up, corrected weights, supported and absent personal experience, system design, ambiguity, corrected transcript numbers/negation/identifiers, unfinished speech, uncertain diagnosis, executable coding output, and an already-strong concise answer. It checks source preservation, partial exclusion, context provenance, output budgets and local compilation cost. Character/byte counts are not presented as token usage.

The opt-in provider runner uses a disposable Electron runtime and the existing encrypted connection in memory. It loads only the saved Fast model name, not private sessions or profile text. The actual saved Fast model was `gpt-4.1-mini`; the evaluation did not silently switch models. Each case is generated once per variant, alternating order across cases. The report retains full answers, actual provider token usage, total duration and the first visible generation callback after protocol stripping. These timings exclude physical capture, IPC-to-renderer time and screen paint.

```sh
npm run eval:delivery
FAANGIN_DELIVERY_LIVE=1 npm run eval:delivery:live
```

Live evaluation sends synthetic public text and incurs provider usage. Default reports are `/private/tmp/faangin-response-delivery-offline.json` and `/private/tmp/faangin-response-delivery-live.json`. Use `FAANGIN_DELIVERY_REPORT` to retain a new live iteration separately; `FAANGIN_DELIVERY_CASES` can select comma-separated fixture IDs. The live runner fails on provider/transport errors without silent retry or model substitution.

Factual accuracy, technical completeness, conversational naturalness, contextual fit and consistency are separate review dimensions. Automatic phrase checks are supporting evidence and can both miss failures and flag valid paraphrases. Human rating fields remain unscored: engineering/model-assisted review is not an independent human study.

## Failed first iteration

The first paired provider run completed all 24 requests and exposed issues that deterministic compiler tests could not establish:

- The revised answer to an unfinished cache question invented its continuation and answered it; the baseline correctly returned WAIT.
- The revised 0–1 BFS explanation incorrectly said visited/parent arrays worked the same after a baseline solution using permanent enqueue-time visited state. Distance relaxation is necessary when zero-weight paths can improve a queued vertex.
- Both behavioral answers added unsupported claims such as a rollout completing without impact. The source established only that the rollout completed.
- The baseline webhook estimate used 7.2 million events/day at 2,000 events/second. The correct value is 172.8 million/day; both versions inadequately handled delivery guarantees and duplicate effects.
- Several revised answers still added summaries, unsolicited follow-up offers or commentary about an already-strong answer despite a two-sentence limit.

These were treated as release blockers. The policy was revised to make incomplete-turn and source boundaries take priority over delivery, require supported outcome wording, preserve changed-algorithm invariants, and answer only the requested deliverable. The failed run is retained separately from subsequent checks; it is not reported as a success.

## Completed verification

| Check | Observed result |
| --- | --- |
| Initial repository suite | 626 tests passed |
| Final integrated suite/build | 651 tests passed, no failures or skips; typecheck and production build passed |
| Source desktop workflow | 21 isolated localhost fixture requests passed, including actual preload/IPC, audio-source guards, streaming, interruption, context continuity and restart persistence |
| Packaged Apple Silicon app | Local unsigned candidate built using the installed Electron runtime; the packaged app also passed all 21 isolated desktop requests |
| Offline paired compiler audit | 12/12 cases preserve raw source context and output budgets; only the explicitly allowlisted empty derived-ledger omission differs |
| Local compiler cost | Current per-case median 0.006–0.026 ms and p95 0.007–0.037 ms across 120 samples/case; excludes all cloud, audio and display latency |
| Continuous-speech regression | Zero early requests during 7 seconds of continuous synthetic speech; dispatch at 7,440 ms = speech + existing 320 ms silence endpoint + existing 120 ms settling delay |
| Code behavior | Each baseline/current generated `lower_bound` implementation in the final two-model comparison passed 58,344 bounded comparisons against Python `bisect_left`; evaluator inspection preceded isolated execution |
| Live generation | Three prompt iterations on saved `gpt-4.1-mini`, a separate final-policy `gpt-6-luna` comparison, and two Luna critical-case repeat sets: 112 completed requests total |
| Critical-case consistency | Luna current: three samples each for corrected weights, grounded behavioral story, unfinished WAIT and already-strong concise answer; all retained the reviewed critical properties |

The final 651-test suite was repeated successfully after the evaluation-only arithmetic-indicator refinements. No live request included private session text, screenshots, a saved profile or recorded voices. No credentials were printed or persisted in evaluation artifacts. The app's saved model selection was not changed.

Final full comparisons, one generation per case and variant:

| Measured quantity | Saved GPT-4.1 mini baseline → current | GPT-6 Luna baseline → current |
| --- | --- | --- |
| Provider input tokens, sum of 12 cases | 20,144 → 17,954 (−10.9%) | 20,136 → 17,946 (−10.9%) |
| Provider output tokens, sum of 12 cases | 2,583 → 1,637 (−36.6%) | 1,872 → 1,283 (−31.5%) |
| Median first visible callback, non-WAIT answers | 667 → 739 ms | 664 → 715 ms |
| Median completion duration, all 12 cases | 1,579 → 1,238 ms | 1,519 → 1,374 ms |
| Total answer words | 1,768 → 1,103 | 1,259 → 900 |

These are exploratory aggregates of different questions, not latency distributions for a fixed workload. The two final model runs and local checks overlapped, and network/provider load is uncontrolled. First-text medians did not improve. Fewer words or tokens alone do not establish better naturalness, correctness or completeness; no universal speedup is claimed.

## Representative observed answers

These excerpts come from the same-model paired Luna evaluation. They are actual provider outputs, not the hand-authored illustrations included in fixture metadata. Full text, prompts' hashes, usage and timing remain in the linked reports.

**Behavioral grounding.** The source established a disagreement, a proposed phased rollout, a written rollback checklist, agreement on phases, and only that the rollout completed.

Before, the answer ended with an unsupported retrospective: “The experience showed me that a practical plan can help turn a disagreement into a decision we can move forward with.”

After: “At Cedar, I was an engineer on the billing team, and a teammate preferred releasing the work all at once. I proposed a phased rollout and wrote a rollback checklist so we’d have a clear plan if we needed to reverse a phase. We discussed the approach and agreed to roll it out in phases. The rollout completed.”

**Focused uncertainty.** Asked whether Redis was definitely responsible for a latency increase without traces or metrics, the baseline supplied a multi-paragraph diagnostic checklist. The revised answer was: “No. Without traces or metrics, Redis is only one hypothesis. What changed in the deploy, and can you compare latency or error rates before and after it?” It retains uncertainty and asks for discriminating evidence.

**Changed algorithm.** The revised 0–1 weighted follow-up explicitly preserved the necessary implementation change: “Use 0-1 BFS with a deque and relax distances, rather than marking each vertex visited on first enqueue. For every edge, update a neighbor only if the new distance is smaller; push it to the front for a zero-weight edge and to the back for a weight-one edge, updating its parent on improvement. The unit-weight BFS invariant that first discovery is shortest no longer holds; 0-1 BFS runs in O(V + E) time and uses O(V) auxiliary space.” The baseline Luna answer was already technically strong and also mentioned relaxation; the revision made the affected prior invariant and parent update more explicit.

**Already-strong control.** The baseline's two-sentence unique-constraint answer stayed a two-sentence answer: “A unique constraint prevents duplicate values in the constrained key, though how it treats `NULL` varies by database. It doesn’t ensure a value is valid or correct.” The revision did not add a coaching preamble or close with an offer.

## Acceptance limits

The saved `gpt-4.1-mini` did not meet the grounding/correctness quality bar in the final samples: it still embellished the behavioral outcome, omitted the required 0–1 BFS distance-relaxation change, and wrote an incorrect 2 MB/s ≈ 172 Mbps conversion (the decimal conversion is 16 Mbps). It also sometimes over-explained or asked an unnecessary clarification. Prompt changes alone did not establish compliance for that model. These failures are retained in the report rather than averaged away by style scores.

Luna's reviewed critical samples were materially better, but the sample is small and was used during development. Its design response is 312 words, about 2.1 minutes at 150 words/minute; one coding sentence describes retaining `mid` in the search range when it is more precisely retained as a possible answer boundary. The code and its stated predicate invariant are correct, and the BFS comparison could state DFS's shared complexity more explicitly. This is not a perfect semantic guarantee.

Independent human judgments, unseen interview sets, accents/noise, overlapping speakers, conferencing/headset combinations, physical capture/paint latency and long-session behavior remain unverified. A silence endpoint is an observed pause, not proof of semantic completion; the model can still misread intent. Very short audible corrections that cannot be finalized stay held rather than releasing an older fragment; manual Reply or a new completed utterance remains the explicit recovery path. No fine-tuning was performed.

Evidence: [engineering review by dimension](../evaluation/response-delivery-2026-10-27/review.md), [offline compiler report](../evaluation/response-delivery-2026-10-27/offline.json), [final saved-model pairs](../evaluation/response-delivery-2026-10-27/paired-scoped.json), [final Luna pairs](../evaluation/response-delivery-2026-10-27/paired-luna.json), [first failed iteration](../evaluation/response-delivery-2026-10-27/iteration-1.json), [second iteration](../evaluation/response-delivery-2026-10-27/iteration-2.json), [repeat 1](../evaluation/response-delivery-2026-10-27/repeat-1.json), [repeat 2](../evaluation/response-delivery-2026-10-27/repeat-2.json), [code checks](../evaluation/response-delivery-2026-10-27/code-luna.json).

The launchable local candidate is `dist/response-delivery-candidate/mac-arm64/Faangin.app`. Quit an older Faangin instance before opening it; the normal single-instance behavior can otherwise focus the older app. This is an unsigned development build. Source hashes, the packaged `app.asar` hash and local verification logs are retained with the candidate in `dist/response-delivery-candidate/verification`.
