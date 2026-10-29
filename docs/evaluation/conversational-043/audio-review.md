# Synthetic speech acceptance review — 2026-10-27–28

The unchanged natural waveform replayed with 600 ms endpoints produced the correct 0–1 BFS answer, including deque ordering, distance relaxation, the corrected 50,000-edge count and the change to mark-on-enqueue. Three intermediate provider-final chunks remained held until the final endpoint transcript. The strict lexical report still records `passed: false`; recognition was not verbatim and that result has not been changed.

The earlier 320 ms natural run failed materially: recognition split “zero or one” into “weight zero.” and “Our one rather than …”, and the completed answer confidently described an all-zero graph with a FIFO queue. The failed evidence remains available. The later outcome is a successful targeted semantic observation, not proof of universal recognition accuracy or perfect delivery.

These are engineering/model-assisted judgments of public synthesized speech, not independent human ratings or physical microphone/conferencing validation. No speech was played aloud. The question was rendered to mono PCM16 at 24 kHz with the configured macOS voice at 165 words/minute, then replayed in 20 ms frames through the actual `VoiceActivity`, Realtime transcriber, reply coordinator, prompt compiler and Luna response decoder. Private profile/session content was excluded.

## Retained runs

| Run | Outcome | Scope |
| --- | --- | --- |
| [Initial bounded experiment](audio-initial-bounded-abort.json) | Aborted at the third dispatch attempt after two allowed provider calls | Natural TTS pauses produced multiple physical endpoints. The initial two-call cap was too small. Its older measurement fields cannot establish the stricter endpoint assertions. |
| [Natural speech](audio-natural-failed.json) | Completed; failed technical acceptance | Five physical endpoints, five provider calls, four interrupted calls with no visible text, one completed answer. |
| [Attempted continuous transport](audio-continuous-uncovered.json) | Aborted at the third attempt after two provider calls; continuation scenario uncovered | Near-zero gap compression removed **zero bytes**. Original/transformed PCM hashes are identical, no quiet gaps were classified, and no six-second provider continuation was observed. This is not evidence for continuous-transport acceptance. |
| [Unchanged natural speech, 600 ms](audio-natural-600.json) | One completed provider call; materially correct answer; strict lexical `passed: false` retained | One physical endpoint, three continued provider-final chunks held, final question and corrected count included. |
| [Derived continuous transport, 600 ms](audio-continuous-600.json) | One completed conditional answer; strict lexical `passed: false` retained | Two continued provider-final chunks held. Artificial VAD-quiet compression retained all frames at or above RMS 0.004; recognition artifacts remain. |

The primary natural input lasted 18.106 seconds. Recognition preserved “do not assume unit weights,” 10,000 vertices, and the correction from fifteen thousand to fifty thousand edges. It did not preserve the zero-or-one choice. Its finalized passages were:

> Because every edge has weight zero.
>
> Our one rather than arbitrary positive weights in a graph with ten thousand vertices.

The final answer opened:

> For zero-weight edges, keep BFS but the distance to every vertex reachable from the source is zero.

It later said a FIFO queue and mark-on-enqueue remained safe. This follows the incorrectly narrowed all-zero interpretation rather than the intended zero-or-one question. The source fragments were uncertain enough that a focused clarification would have been safer than a confident narrowing.

## Endpoint, source and cancellation evidence

For all five natural-mode provider starts, `candidateEndpointObserved` is true and `providerContinuationUnsettled` is false. The one completed response therefore satisfies both required endpoint conditions. Four earlier calls began while audio belonging to a later physical utterance was already being admitted; subsequent partial speech interrupted them before visible text. These are canceled intermediate attempts, not four successful answers. Their final provider usage is unavailable and must not be counted as zero cost.

The three invalid offers—provisional text, microphone source and foreign session—were tested independently and did not dispatch. Local PCM admission checks observed monotonic frame order without duplicate frames and exact admitted bytes. These checks validate the synthetic local handoff, not remote recognition correctness or physical capture. The natural run observed no provider-final continued chunk because every TTS pause ended an utterance before six seconds. The attempted continuous fixture likewise supplies no continued-chunk evidence.

## Observed natural-mode timings

| Measurement | Result |
| --- | ---: |
| Transcription connection readiness | 637 ms |
| First partial from start of PCM replay | 807 ms |
| First finalized passage from start of replay | 5,018 ms |
| Commit-to-final transcript, five passages | median 613 ms; range 480–655 ms |
| Last endpoint commit to final transcript | 480 ms |
| Last final transcript to reply dispatch | 120 ms |
| Final generation request to first visible body text | 904 ms |
| Last endpoint commit to first visible body text | 1,505 ms |
| Last endpoint commit to completed answer | 3,004 ms |

The first finalized-passage time includes the first spoken segment and its silence endpoint; it is not a 5-second network latency measurement. The first-text callback follows protocol stripping and excludes renderer delivery and physical paint. These are individual observations, not representative latency distributions.

## Measured endpoint correction

The same public waveform was regenerated offline without playback or API calls. Its WAV SHA-256, `9246249027e43ec981aa944818cd955816748794bc2547f595d2ae1f40bd2418`, matches all three retained live experiments exactly. Frames below the actual VAD release threshold, RMS < 0.004, produced within-question quiet runs of 400, 380, 340, 320, 220, 140 and 100 ms. The earlier near-zero compression threshold of 0.0001 missed this voice's quiet frames, whose RMS remained above that value.

The [offline comparison](audio-vad-offline.json) replayed the unchanged PCM through the actual VAD with several endpoint settings:

| Silence endpoint | Physical endpoints | Continued transport chunks | Final endpoint offset from PCM replay |
| --- | ---: | ---: | ---: |
| 320 ms | 5 | 0 | 18,360 ms |
| 400 ms | 2 | 2 | 18,440 ms |
| 420 ms | 1 | 3 | 18,460 ms |
| 500 ms | 1 | 3 | 18,540 ms |
| 600 ms | 1 | 3 | 18,640 ms |
| 700 ms | 1 | 3 | 18,740 ms |

420 ms is the smallest measured setting that keeps this single voice's question in one VAD utterance. The approved production setting is **600 ms for both sources**, allowing 200 ms beyond its longest observed internal pause. Relative to the prior defaults, this adds 280 ms for computer audio and 200 ms for microphone at a final silence endpoint. Six-second transport chunks, RMS thresholds, source separation and recognized text remain unchanged. This is a measured tradeoff on one input, not a universal endpoint optimum or a guarantee of accurate recognition.

The synthetic continuous fixture now classifies quiet frames using the same strict RMS < 0.004 release criterion. On this waveform it removes 57,600 bytes (1,200 ms) of quiet runs, reducing 18.106 seconds to 16.906 seconds. Hashes of all original and transformed frames at or above RMS 0.004 match exactly. Frames below that threshold can still contain low-level speech, so this transformation is explicitly artificial and supplementary. Offline replay with the former 320 ms endpoint then produces one endpoint and two six-second continuation chunks; the unchanged natural waveform remains the primary acceptance case.

Typecheck and 83 focused tests pass after tuning. Tests preserve admitted PCM identity and order across 400/380 ms internal pauses, independently endpoint both sources, retain six-second chunking, and dispatch a seven-second synthetic utterance at 7,720 ms (7,000 ms speech + 600 ms endpoint + 120 ms settling).

## Independent review of the 600 ms provider replays

The [natural replay](audio-natural-600.json) uses exactly the original waveform hash above, with no PCM transformation. It produces three six-second transport-final transcripts and a blank final endpoint transcript. All three intermediate finals arrive before the physical endpoint, yet no generation starts until the blank endpoint final completes. Its single actual dispatch records both `candidateEndpointObserved: true` and `providerContinuationUnsettled: false`; `vadSpeechInProgress` is also false. Source, partial and foreign-session probes stay rejected. The blank endpoint correctly releases the earlier meaningful question without creating another stored transcript passage.

Recognition remains imperfect. Across chunks, “weight zero” is followed by “Zero. Or one …”, repeating zero and inserting punctuation. The strict `zeroOrOne` phrase indicator therefore remains false. The fifteen-thousand figure and subsequent “Sorry, fifty thousand edges” correction remain in the transcript; the answer uses the final 50,000 value. Its substantive answer is:

> Since edge weights are 0 or 1, replace the FIFO queue with a deque and use 0–1 BFS. Keep a distance array initialized to infinity; whenever `dist[u] + w` improves `dist[v]`, update it and its parent, then push `v` to the front for weight 0 or the back for weight 1. Don’t mark vertices permanently visited on enqueue, since a later route can improve their distance.

That algorithm and its O(V + E) time bound answer the intended question correctly. Its O(V) auxiliary-space statement excludes the supplied adjacency-list graph. The later wording “O(60,000)” is imprecise asymptotic notation: 10,000 + 50,000 describes the input-size scale, not an exact runtime or exact operation count. This is a minor explanatory issue, not a wrong shortest-path algorithm. The answer has not been edited in the retained report.

The [derived continuous replay](audio-continuous-600.json) has two intermediate continuation finals and one endpoint final. It likewise makes one actual provider call only after both endpoint conditions are satisfied; no dispatch occurs during observed speech. Its transcript contains “Are one rather than …” and “fifty thousand” followed by “As an edges …”. Accordingly, both the `zeroOrOne` and `finalFiftyThousandEdges` lexical indicators remain false. It is not verbatim-recognition acceptance.

The model handles that ambiguity explicitly: “Assuming each edge has weight 0 or 1, use 0-1 BFS,” followed by the correct deque, relaxation and visited-state changes. It also gives a separate all-zero alternative. The conditional 0/1 explanation is technically correct and avoids the earlier confident narrowing to all-zero edges; the extra alternative reflects uncertainty in the damaged transcript. Its “O(60,000) traversal work” wording has the same input-scale versus exact-work qualification. Because the source audio was deliberately transformed, this is supplementary transport/uncertainty evidence rather than natural-pacing acceptance.

Both replays satisfy every recorded structural invariant and every required-answer phrase indicator. Those indicators support this engineering review; they are not independent factual or naturalness scores. Their overall machine `passed` fields remain false exactly as generated because the strict transcript phrase checks failed. No score or source transcript was rewritten to turn them into automated passes.

| Observed measurement | Natural, unchanged PCM | Derived continuous PCM |
| --- | ---: | ---: |
| Actual provider calls / dispatch attempts | 1 / 1 | 1 / 1 |
| Intermediate provider-final chunks held | 3 | 2 |
| Transcription connection readiness | 686 ms | 1,327 ms |
| First partial from start of replay | 802 ms | 805 ms |
| First final from start of replay | 6,685 ms | 6,706 ms |
| Commit-to-final transcript median | 564 ms | 640 ms |
| Last endpoint commit to final transcript | 547 ms | 615 ms |
| Endpoint final transcript to dispatch | 121 ms | 121 ms |
| Generation request to first visible body text | 981 ms | 1,092 ms |
| Last endpoint commit to first visible body text | 1,649 ms | 1,829 ms |
| Last endpoint commit to completed answer | 2,868 ms | 3,413 ms |
| Completed provider input / output tokens | 4,139 / 135 | 4,128 / 156 |

These two replays overlapped and each has one completed answer. Network/provider load was uncontrolled. Their first-final timing includes a six-second transport chunk; it is not a six-second network delay. Timings follow the generation callback after protocol stripping and exclude physical capture, renderer delivery and physical paint. The observed request-count reduction from five starts to one on this waveform must not be presented as a universal cost or latency improvement; the earlier canceled calls lack final usage measurements.

## Final selected Sol model with structured framing

The final [Sol natural replay](audio-sol-typed.json) uses the unchanged waveform and the production 600 ms endpoints, now with the strict JSON decision/body protocol. It observes one physical endpoint, three intermediate provider-final chunks held and one actual generation call. At dispatch, `candidateEndpointObserved` is true, `providerContinuationUnsettled` is false and no observed speech remains active. Every recorded structural invariant passes.

The answer correctly switches to 0–1 BFS, uses distance relaxation and parent updates, places zero-weight improvements at the deque front and one-weight improvements at its back, and rejects permanent visited-on-enqueue state. Strict improvement prevents endless updates around zero-weight cycles. It uses the corrected 50,000 edges and O(V+E) time with O(V) auxiliary space, without the earlier imprecise “O(60,000)” wording.

Recognition again inserts “zero Zero. Or one” across transport chunks. Its `zeroOrOne` lexical indicator and overall **`passed: false`** remain unchanged. This run supports a correct observed semantic answer and endpoint behavior, not verbatim ASR acceptance or an independent human naturalness score.

| Observed measurement | Selected Sol / JSON |
| --- | ---: |
| Transcription connection readiness | 1,089 ms |
| First partial from start of replay | 740 ms |
| First final from start of replay | 6,622 ms |
| Commit-to-final transcript median | 563 ms |
| Last endpoint commit to final transcript | 402 ms |
| Endpoint final transcript to dispatch | 120 ms |
| Generation request to first decoded body text | 2,522 ms |
| Last endpoint commit to first decoded body text | 3,044 ms |
| Last endpoint commit to completed answer | 5,566 ms |
| Completed provider input / output tokens | 4,204 / 159 |

This is one sample with uncontrolled provider/network load. It does not establish a cross-model speed ranking. Timing excludes physical capture, renderer delivery and physical paint. No saved private context was loaded and no speech was played aloud.

## Remaining work

The unchanged natural waveform now has a materially correct observed answer with the required endpoint holds. Verbatim recognition is still imperfect, and the machine reports correctly retain their strict lexical failures. More unseen questions and independent human judgments are required before claiming broad semantic fidelity or naturalness. The earlier failed natural run and unsuccessful transport fixture remain failed evidence. No transcript rewriting was introduced, and the separately labeled derived transport fixture cannot substitute for natural pacing acceptance.

Single-voice synthesis does not cover accents, noise, overlapping speakers, interruptions by another person, microphone/system-audio hardware, conferencing compatibility, long sessions, or independent human naturalness judgments. A physical silence endpoint is an observed pause, not proof that a question is semantically finished.
