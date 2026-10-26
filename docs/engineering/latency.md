# Interview response latency

October 12, 2026 · Faangin 0.2.1 latency candidate

Nanosecond-scale end-to-end cloud answers are not achievable. Network transit, provider processing, token generation and screen rendering all take time. This release reduces repeated local work and prioritizes the first useful response. It has no measured cloud speedup or guaranteed response deadline.

The user reports entering a replacement key in the app. Its saved state, account access and quota have not been independently verified. No live provider request or paid benchmark was run for this change; tests use controlled transports and disposable workspaces.

## What changed

| Change | Behavior |
| --- | --- |
| Compile the admitted request once | OpenAI and compatible chat use the same compiled context snapshot established at admission; OpenAI no longer recompiles it before sending |
| Narrow request admission event | After the streaming answer is saved, `answer-started` delivers that answer before text deltas. Admission no longer serializes and broadcasts the full application state, including image payloads |
| Avoid a duplicate state refresh | Sending a request does not initiate an extra renderer `getState` refresh. The answer admission event establishes the card |
| Smaller storage existence check | `saveAnswer` checks active-session existence through its epoch lookup instead of reloading every transcript and answer. Main-process epoch fencing still prevents stale requests from publishing |
| Lead with useful interview text | Fast interview assistance, excluding Notes/Recap/Draft, asks for one useful sentence or necessary clarification first, followed by the action’s required explanation, code, assumptions, constraints, complexity and edge cases |
| Separate delivery from rendering | The first non-whitespace delta of a newly admitted empty answer updates React state immediately. Subsequent deltas are accumulated in order and flushed on one animation frame, with a nominal 32 ms timer fallback |
| Reuse unchanged answer bodies | Unchanged answer objects retain identity during stream updates. Answer bodies and source-label validation are memoized; streaming Markdown still parses the accumulated text when it changes |

Leading whitespace is retained with the response, but does not count as first text or force the first non-whitespace content to wait for a later frame. “First text” does not establish that the opening is semantically useful or correct. The 32 ms fallback is a scheduling interval, not a visible-paint guarantee. A busy or throttled event loop can delay either callback. Existing answers that already contain text batch later deltas. Completion or state reconciliation can deliver buffered text sooner.

Cancellation exposes all received buffered text before suppressing later deltas. Canonical completion replaces partial output. Session/context changes and unmount clear pending work; generation and callback-revision guards reject stale flushes. Strict Mode cleanup disposes the old stream instance and subscriptions.

The existing Fast/Smart choices and saved provider/model settings remain authoritative. The saved brief, selected-source boundaries and context budgets are preserved. Fast interview context remains bounded to 60 recent turns and 8,000 transcript characters; other requests retain their established budgets. Solve/Debug/Design still allow up to 4,096 output tokens. This change adds no hard response-length cap, automatic model switch, speculative background generation or paid retry. Fast’s concise opening is prompt guidance, not a factuality or quality guarantee.

OpenAI’s guidance identifies model choice and generated output length as major latency factors, and recommends streaming to make useful text available before the full answer finishes. Those are general principles, not a measured Faangin performance claim. [Official OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization)

## What the displayed timings mean

| Display | Measurement | Excluded work |
| --- | --- | --- |
| **First text** | Rounded elapsed time from entry to main-process request generation until the first accepted non-whitespace text callback, including admission, context preparation, initial persistence and provider transport | Earlier UI-to-main IPC, subsequent main-to-renderer IPC, React commit and physical screen paint |
| **Finished in** | Elapsed time from the same main-process start through generation completion/error cleanup | Terminal answer persistence/emission and visible final paint |

These values are not pure model latency or stopwatch measurements from the click to visible pixels. The timing origin now includes preparation that the previous 0.2.0 timing omitted, so direct before/after numbers can increase even when repeated work was removed. First text is absent if no accepted non-whitespace callback arrives before termination; a whitespace-only prefix does not start this metric.

## Measure with your configured provider

Use the tested `dist/latency-candidate/mac-arm64/Faangin.app`; its completed build/package checkpoint and finished-artifact hashes are recorded in [build status](build-status.md#latency-candidate-021). The older 0.2.0 bundle and hashes remain separate historical evidence.

1. Open an Interview workspace and choose **Fast** using the existing toggle. Check the displayed model and intended provider destination; keep your saved model IDs unchanged for this comparison.
2. Prepare a dedicated test session with public sample context. Review the saved profile, brief and selected context before dispatch. For example, ask: “Explain binary search and its time complexity in at most four sentences.” Capture and images are unnecessary for this text comparison.
3. Submit the question once and note **First text**, **Finished in**, actual returned model, usage and whether the first displayed sentence is useful. Record visible delay separately if you need a click-to-paint measurement.
4. Repeat with the same context in fresh test sessions, alternating Fast and Smart until you have three trials per mode. Fresh sessions avoid changing the comparison through accumulated prior answers. These are six explicit provider requests and may incur charges; the app does not run this benchmark automatically.
5. Compare each mode’s median with correctness and completeness. If Fast and Smart map to the same model ID, this compares prompt modes rather than different models. Three trials are exploratory and cannot establish p95, an SLA or universal model superiority. Later, evaluate representative coding/Hint/Review inputs, images and real audio separately; their processing costs differ.

Keep context, action, provider, model, connection and test conditions in the record. A shorter but incorrect answer is not a latency success. Broader acceptance needs representative samples, first-text/total p50/p95, visible-paint measurements and a physical device/network matrix.

## Verification and release limits

The integrated suite passed 334 tests with no failures or skips, including 18 deterministic stream regressions for leading-whitespace delivery, stale admission/state snapshots, cancellation, canonical terminal replacement and disposal, plus prompt, storage and single-compilation regressions. The final 0.2.1 production build, separate candidate packaging and packaged smoke passed with exit 0. Finished DMG/ZIP hashes, build-input provenance and four verification logs are saved under `dist/latency-candidate`.

The final packaged smoke at `/private/tmp/faangin-latency-packaged-smoke.log` verified narrow admission before the first delta, first answer text in the actual workspace Markdown DOM, five localhost requests and saved draft sources across restart. It ran the final compiled source, including the whitespace correction. An earlier source smoke preceded that last correction and is not substituted for the final packaged result. Hidden DOM assertions establish a renderer path; they do not certify physical visible pixels or real cloud latency.

Apple Developer ID signing/notarization, live provider/audio quality, native physical acceptance, Windows and the complete PRD backlog remain separate gates. See [release readiness](release-readiness.md#latency-candidate-021) and [requirement status](feature-status.md#latency-candidate-021).
