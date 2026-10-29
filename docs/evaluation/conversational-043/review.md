# Conversational response evaluation: 0.4.3

This is a model-assisted engineering review of actual provider outputs, completed October 28, 2026. The final chosen Sol configuration completed both 12-case suites with all expected decisions and valid structured framing. No material factual, grounding, contextual-intent or code-behavior failure was identified in the 24 revised answers in those runs. Earlier failures remain below. This is not an independent human interview study, an untouched generalization estimate or a guarantee about future responses; human rating fields remain unscored.

## Final chosen-model structured comparison

The final [development](typed-sol-development.json) and [holdout](typed-sol-holdout.json) reports each contain 24 completed generations: one pinned-baseline and one current answer for each of twelve cases. Both baseline and current disposition gates pass in both suites. The current seven automatic interview requests use the strict JSON schema and streaming JSON decoder; baseline automatic requests retain their original line protocol. Manual requests remain plain answer text. The production normal model is Sol Smart; the separate [Luna Fast intent probe](typed-luna-intent.json) also uses structured framing.

The current Sol answers preserve all reviewed critical properties:

- Both BFS and DFS have explicit shared time/worst-case-space bounds; weighted corrections use distance relaxation, parent updates and a deque, and reject permanent first-enqueue visitation.
- The actual retry question receives assistance while preserving 50 as the configured retry limit, excluding HTTP 401, and retaining `request_id`; it does not reinterpret the count as total attempts. The payment correction preserves 80 milliseconds and the no-retry rule. Incomplete speech returns WAIT.
- Tenant eligibility is acquired before a scarce global permit; cancellation releases partial acquisition. The original global eight-operation cap remains intact.
- Thumbnail Design explicitly uses 75 source jobs/s and 225 outputs/s, computes 450 MB/s, labels the per-image processing-time assumption and preserves unknown output byte sizes/retention. Webhook Design labels a 200 ms service-time assumption before deriving 400 in-flight initial attempts and handles durable handoff, duplicate effects, fair scheduling and SSRF.
- Personal stories use only supplied roles, actions and completion outcomes. Missing experience prompts a request for a real example. The TLS and unique-constraint controls preserve supported qualifications in two direct sentences.
- The code explanations distinguish written prefixes from allocating slices, and searched indices from a returned sentinel boundary. The sampled implementations pass the bounded checks below.

The 193-word thumbnail explanation fits approximately 90 seconds at 129 words/minute; the 242-word webhook explanation fits two minutes at 121 words/minute. These are planning estimates, not measured speech. Structured code retains useful headings, invariants, complexity and edge cases. Naturalness was assessed from text by engineering agents, not scored by people listening to answers.

### Complete-suite usage and callback timings

| Suite | Variant | Input tokens | Output tokens | First-text median, ms (n=11) | Completion median, ms (n=12) | Generation duration sum, ms | Words |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development | Baseline |20,136|2,347|1,657.7|3,425.5|66,433.1|1,585|
| Development | Current |21,028|1,851|1,716.2|4,074.1|57,878.8|1,217|
| Holdout | Baseline |18,922|1,587|1,507.6|3,004.6|46,547.2|1,118|
| Holdout | Current |18,495|1,437|1,675.6|2,660.7|44,555.0|926|

First text excludes the one WAIT in each variant. These mixed-question medians are exploratory; completion medians and duration sums move differently because distributions and output lengths differ. They do not establish a universal latency improvement. Token totals include the actual request protocol; they are not estimates from characters. The evaluator does not retain a reasoning/cache-token breakdown.

### Protocol-specific observations

| Suite | Variant/protocol | Requests | Input tokens | Output tokens | First-text median, ms (visible n) | Completion median, ms |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Development | Baseline line |4|9,965|277|1,674.1 (3)|3,132.6|
| Development | Current JSON |4|12,325|338|2,207.1 (3)|3,919.2|
| Development | Baseline plain |8|10,171|2,070|1,624.5 (8)|7,184.5|
| Development | Current plain |8|8,703|1,513|1,588.2 (8)|5,043.2|
| Holdout | Baseline line |3|7,254|134|1,742.9 (2)|2,404.6|
| Holdout | Current JSON |3|8,651|194|1,806.9 (2)|2,673.8|
| Holdout | Baseline plain |9|11,668|1,453|1,485.4 (9)|3,102.5|
| Holdout | Current plain |9|9,844|1,243|1,480.0 (9)|2,647.5|

This is a complete-policy comparison: instructions, scoped context guidance and wire format changed together. The automatic-row difference therefore cannot be attributed solely to JSON syntax. Both schema and body still use one provider call, with no rewrite pass. Schema framing adds real request/output overhead; it is not free. Concurrent experiments and uncontrolled provider load limit timing conclusions. Physical capture, IPC, rendering and visible paint are excluded.

### Exact provenance and generated-code checks

The [source consistency audit](typed-source-consistency.json) recompiled every baseline/current request and matched all 48 recorded compiled-prompt hashes to the current checkout or pinned baseline as appropriate. Both catalog hashes also match. All 24 baseline hashes match the preceding Sol experiment, establishing that baseline evidence was not changed while the wire protocol was integrated.

| Report | File SHA-256 |
| --- | --- |
| typed-sol-development.json | `57a7e929c0ec6508103199d595da7351873769a9e22059b74f05997c86a200df` |
| typed-sol-holdout.json | `cd2eabc4f44da7aafa55d04bae252c5635644c5a84c6786677b65757f4ef08fb` |

The actual final [deduplication functions](code-typed-holdout.json) pass 19,452 bounded cases each, checking the returned count and mutated unique prefix. The actual final [binary-search functions](code-typed-development.json) pass 58,344 cases each against `bisect_left`. Both baseline and current variants were inspected before isolated execution with a ten-second timeout. These checks validate these samples on finite inputs, not arbitrary future generated code.

The separate Sol structured speech report is complete with one endpoint and one generation call, and its answer correctly uses 0–1 BFS, improved distances/parents, a deque, corrected 50,000 edges and O(V+E) time. Its machine `passed` flag remains false because a lexical transcript regex does not bridge “zero Zero. Or one”; the raw punctuation/repetition is retained. Engineering review recognizes the disjunction and correct answer without weakening the original check. See the [speech review](audio-review.md) for timing, raw evidence and remaining physical-device limits.

## Scope and independence

The baseline compiler is pinned to `6fd27174f03690b6c24d73b2db5da5d8ab3738e9`. The 12 development fixtures remain separate from 12 new public synthetic holdout fixtures. The new cases use different technical subjects, names, quantities and mutable code: mutex/semaphore comparison; per-tenant database concurrency; a supported incident narrative; absent management evidence; image-processing design; missing safety context; corrected payment-policy speech; unfinished rate-limit speech; uncertain memory-leak evidence; in-place sorted deduplication; an already-strong TLS answer; and expected versus worst-case hash-table lookup.

The holdout fixtures were not used to develop the initial 0.4.3 prompt. Their first results then informed fixes. Consequently, later runs of those same cases are regression checks, not untouched estimates of generalization. The fixture catalog, source wording and checks were not changed to conceal observed failures.

Each baseline/current pair uses the same factual synthetic source snapshot. Holdout fixture model IDs are explicit; development fixture settings inherit the app defaults, while the source-hash audit verifies the actual compiled evidence. Historical Luna runs explicitly selected Luna; the final chosen-model comparisons explicitly selected Sol. Each report records its selected model. Raw source payloads must remain identical except for the already documented narrow omission of an empty derived interview-situation field; original source words, identifiers, negation, corrections, provisional exclusions and output budgets remain checked.

In the historical Luna policy, full Design requests use low reasoning while focused replies retain none. Final chosen-model Sol requests use Sol’s low-reasoning policy, including focused replies. Each new trial records its actual resolved reasoning. These comparisons measure the complete model and response policy rather than isolating style alone. Explicit none/low experiments are labeled separately.

## Failures retained before fixes

The [initial holdout run](iteration-1-holdout.json) and [initial development run](iteration-1-development.json) aborted on malformed automatic output. The [protocol probes](protocol-holdout.json) and [development probe](protocol-development.json) retained raw prefixes: revised output began `ASSIST Preserve` or `ASSIST The`, with a space instead of the required newline. Baseline outputs used `ASSIST\n`. The strict decoder correctly rejected the prefix before displaying body text. Evaluation now preserves the decoder error separately from the transport layer’s wrapping `malformed_response` error.

Other initial holdout failures were substantive:

- Thumbnail sizing correctly computed 450 MB/s but then claimed about 36 terabits/day. The decimal sustained rate is 38.88 TB/day, or 311.04 terabits/day. The extra estimate was wrong by a factor of 8.64.
- Its 270 words would require 180 words/minute to fit 90 seconds; at 150 words/minute it would take about 108 seconds. No spoken timing was measured.
- A missing-experience answer changed “no people-management experience has been supplied” into a claim that the person has no such experience. Absence of supplied evidence does not establish absence of experience.

The [low-reasoning Design probe](design-reasoning-probe.json) computed 450 MB/s = 3.6 Gbps and a labeled ten-minute buffer of 45,000 source jobs correctly. This isolated Luna probe motivated a single-call reasoning choice for full Design; it does not establish correctness on all designs or the latency of focused requests on a different model. The final Sol runs separately measure that model’s low-reasoning policy.

## Historical Luna holdout regression, iteration 2

The [second holdout run](iteration-2-holdout.json) completed all 24 samples, one baseline and one revised answer per case. Both variants passed the three expected ASSIST/WAIT decisions. The revised outputs nevertheless did not meet every semantic contract:

| Dimension | Model-assisted finding |
| --- | --- |
| Factual accuracy and grounding | Revised sizing uses correct 450 MB/s = 3.6 Gbit/s and 225 renditions/s, preserves unknown output storage, and labels worker-time assumptions. The incident narrative retains supported actions and the queue-caught-up result. Missing management evidence is no longer transformed into a negative claim about the person’s history. |
| Technical completeness | Mutex/semaphore ownership, counts and uses are covered; generic hash-table expected/worst-case bounds are qualified. The concurrency follow-up preserves both caps but specifies only a consistent acquisition order; it does not explicitly prevent consuming global permits while waiting for tenant eligibility. |
| Conversational naturalness | Most focused replies are direct and short. The incident story adds a meta sentence about what “the details provided” do not establish; this is truthful but less natural as candidate wording. No human listening score is assigned. |
| Contextual fit | Payment correction preserves `retry_after_ms`, 80 milliseconds and no retry of failed payments. Unfinished speech produces WAIT. Memory evidence remains uncertain. The already-strong TLS control fails: instead of returning the provided two-sentence answer, the revised output asks, “What specific aspect of TLS are you being asked to explain?” It omits all three requested facts. |
| Consistency | Automatic framing and expected dispositions pass in this one full run. That does not establish broader response consistency, especially given earlier framing failures and the substantive TLS omission. |

The uncertainty indicator flags “leak is fixed” inside wording that explicitly says the evidence does **not** establish a fix. That is an automated false positive. The actual response is appropriately uncertain. The check is retained unchanged; semantic review distinguishes negated claims from assertions.

The TLS failure is not a false positive: the request includes the complete supported answer and explicitly asks for only that spoken answer in at most two sentences. A clarification about the absent original question discards sufficient supplied content. Later policy changes address this, so iteration 2 must remain a failed regression record rather than be relabeled a success.

### Observed usage and timing for iteration 2 holdout

| Variant | Input tokens, total | Output tokens, total | First text median, ms (n=11) | Completion median, ms (n=12) | Total generation duration, ms | Words, total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 18,922 | 1,423 | 1,744.4 | 3,537.9 | 41,199.4 | 1,002 |
| Revised | 17,805 | 1,158 | 3,109.0 | 3,634.3 | 54,246.6 | 709 |

First-text medians exclude the WAIT response; completion medians include it. These are heterogeneous exploratory samples, collected concurrently with other provider/audio work. They do not establish a fixed-workload latency distribution, p95, SLA or speedup. Lower word/token totals partly reflect the unhelpful TLS clarification, so they cannot be treated as unqualified quality gains. Provider token totals are retained without a reasoning/cache breakdown.

The revised Design response has 185 whitespace-separated words: about 90 seconds at 123 words/minute, compatible with its approximate target but not a measured spoken result. Focused replies resolve to reasoning none; full Design resolves to low.

The [second development attempt](iteration-2-development.json) stops after five records because a baseline weighted-question sample violates framing before the revised sample can run. Only the first two cases have both variants. Its partial medians cannot stand in for a full development-suite comparison. The runner was subsequently changed to record strict framing failures and continue independent samples without retrying; current failures still fail the final gate, while access/quota/transport errors still abort.

## Code behavior verified on iteration 2

Both generated `dedupe_sorted` functions were inspected before isolated execution. Each contains only a function, local variables, comparisons, list-index assignments and iteration; the baseline also calls `range` and `len`. No imports, attribute access, file/network operations or external calls were admitted. A separate Python process had a ten-second timeout.

Both variants passed [19,452 cases](code-iteration-2.json): all nondecreasing arrays of lengths zero through ten over integers -3 through 3, plus four long or integer-boundary cases. Checks cover the returned integer prefix length and mutation of the same list to the correct unique sorted prefix. Tail contents are deliberately unconstrained, as requested. Engineering inspection also found constant auxiliary state and a valid written-prefix invariant. This finite check does not prove correctness for arbitrary code or inputs, and the application still does not execute users’ code.

## Historical Luna comparison before structured framing

The [holdout acceptance run](holdout-acceptance.json) and [development acceptance run](development-acceptance.json) each collected all 24 independent baseline/current samples. “Acceptance” is the artifact name, not a claim that every quality requirement passed. The holdout ASSIST/WAIT gate passes for both variants; the development current gate is **false** because the corrected retry-policy question receives WAIT.

The already-strong TLS control is now answered in two direct sentences, preserving transport encryption, certificate validation and the post-decryption boundary. The concurrency follow-up now admits tenant eligibility before consuming a global permit and cleans up a tenant permit if global acquisition fails or is canceled. The unsupported negative claim about management experience is absent. Both full Design cases resolve to low reasoning; focused cases resolve to none, with no explicit evaluation override.

Separate semantic findings remain:

- **Grounding and accuracy:** Supported behavioral actions and completion-only outcomes are preserved. Memory and Redis diagnoses remain uncertain. Thumbnail ingress is correctly 450 MB/s = 3.6 Gbit/s. Its workflow, however, queues one message per upload whose worker generates all three variants, while calling the queue arrival rate 225 thumbnail jobs/s and sizing its backlog at 225 times the window. That describes 75 source jobs/s and 225 rendition operations/s unless jobs are explicitly split per variant. The units of queued work need to be consistent.
- **Technical completeness:** The 0–1 BFS answer explicitly relaxes improved distances and parents and rejects permanent enqueue-time visitation. Both sampled code functions and stated invariants are correct on inspection and the bounded checks below. Mutex/semaphore and hash-table comparisons cover the requested dimensions. The BFS-versus-DFS development answer still states only BFS complexity rather than explicitly repeating DFS’s shared worst-case time/space bounds.
- **Conversational fit:** The supplied TLS answer is retained without a coaching preamble. Focused responses are generally direct. However, the complete imperative/question “Set maxRetries to fifteen—sorry, fifty. Do not retry HTTP 401. Use request_id, not requestId. Why?” receives **WAIT**, suppressing a clear opportunity for assistance. This is a substantive intent false negative, not a framing error or an automated phrase-match artifact.
- **Pacing:** Thumbnail Design is 210 whitespace-separated words, requiring 140 words/minute to fit its approximate 90-second target. Webhook Design is 213 words, compatible with about two minutes at 107 words/minute. These are planning estimates, not measured speech. Required code and equations are not shortened to satisfy prose estimates.
- **Consistency:** Current framing is valid in both complete runs. The expected unfinished-question cases correctly return WAIT. The unexpected WAIT on the complete retry question prevents a blanket automatic-assistance consistency claim.

| Suite | Variant | Input tokens, total | Output tokens, total | First text median, ms | Visible-response n | Completion median, ms (n=12) | Generation duration sum, ms | Words, total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Holdout | Baseline | 18,922 | 1,386 | 978.8 | 11 | 1,739.8 | 27,331.1 | 988 |
| Holdout | Revised | 18,830 | 1,178 | 1,190.5 | 11 | 2,256.5 | 34,549.4 | 729 |
| Development | Baseline | 20,136 | 1,989 | 900.7 | 11 | 1,931.3 | 31,856.2 | 1,325 |
| Development | Revised | 21,356 | 1,384 | 980.5 | 10 | 2,000.6 | 31,963.5 | 818 |

The revised development first-text median uses ten responses because the unexpected WAIT has no visible text. Its smaller output total therefore includes an unhelpful suppression. Current policy does not show a latency improvement in these runs. Additional source/prompt guards also make development input usage higher than baseline. Concurrent provider/audio activity and uncontrolled provider load remain confounders; these aggregates are not fixed-workload latency distributions.

Full Design current first-text/total durations are 3,148.6/6,167.6 ms for thumbnails and 3,118.8/6,792.8 ms for webhooks. Those requests use low reasoning, whereas their frozen baseline uses none. The latency trade-off belongs to the complete policy comparison; it should not be attributed solely to wording changes.

### Sampled code from the complete comparisons

The new [deduplication check](code-holdout-acceptance.json) validates both sampled implementations on **19,452 cases each**, including returned count and mutation of the original list’s unique prefix. The [binary-search regression check](code-development-acceptance.json) validates both sampled implementations on **58,344 cases each** against `bisect_left`: sorted arrays of lengths zero through seven over integers -3 through 3 and half-integer targets from -4 through 4. Each function was inspected before execution in a separate Python process with a ten-second timeout.

The current binary-search explanation now distinguishes the half-open searched interval `[left, right)` from the inclusive answer-boundary range `[left, right]`, correctly permitting the sentinel `len(nums)`. This repairs the earlier explanatory imprecision without changing the verified algorithm.

## Speech evidence remains separate

The [speech review](audio-review.md) documents the natural-speech failure: “zero or one” was transcribed across segments as “weight zero.” and “Our one rather than …”; the completed answer confidently solved the all-zero case. Endpoint/source checks did not compensate for changed meaning. A first artificial continuous fixture removed zero bytes and therefore did not actually exercise a distinct continuous-transport scenario. The later 600 ms endpoint and structured Sol results are reported separately in the opening section and speech review; the failed observations remain retained.

## Historical Sol line-protocol experiment and Luna intent probe

The pre-structured `gpt-6.1-sol` experiment collected all 24 samples in each suite. Its line-protocol failures remain separate from the final chosen Sol configuration’s structured results. Sol’s development disposition gate passes; its holdout gate fails because the current concurrency-follow-up response omits the framing header entirely: the observed raw prefix is `Keep`. The decoder rejects it before visible body text. This failure is retained and is not classified as a formatting success.

Reviewed Sol outputs preserve the supported incident facts, complete TLS qualification, corrected payment identifier/value/negation, unfinished WAIT, and uncertainty about memory. Its thumbnail design explicitly chooses one source job per image, distinguishes **75 jobs/s** from **225 outputs/s**, and sizes worker concurrency consistently as 75 times per-image processing duration. Its BFS/DFS comparison explicitly provides both options’ time and worst-case auxiliary-space bounds. Its generated code and explanations use correct invariants, including the binary-search sentinel.

| Suite | Variant | Successful samples | Known input tokens | Known output tokens | First-text median, ms (visible n) | Completion median, ms (successful samples) | Known output words |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| Holdout | Baseline | 12 | 18,922 | 1,589 | 1,410.1 (11) | 3,011.5 | 1,123 |
| Holdout | Revised | 11 | 15,717 | 1,374 | 1,325.7 (10) | 2,497.2 | 872 |
| Development | Baseline | 12 | 20,136 | 2,393 | 1,457.2 (11) | 3,511.3 | 1,601 |
| Development | Revised | 12 | 21,584 | 1,859 | 1,215.5 (11) | 3,091.7 | 1,246 |

The failed Sol holdout call has unavailable usage; the revised holdout row is therefore an **incomplete sum**, not a matched twelve-case cost comparison. An unavailable token count is not zero cost. Runs overlapped other experiments, so no cross-model speed ranking follows from these numbers.

Sol’s generated deduplication functions each passed 19,452 bounded cases, and its binary-search functions each passed 58,344 comparisons, after the same source inspection and isolated timeout-limited execution. This validates the sampled code’s tested behavior, not automatic framing reliability or arbitrary future code.

The earlier unstructured Luna retry-policy probe returned ASSIST after the unexpected WAIT. Its wording, however, equates `maxRetries = 50` with “at most 50 attempts” without the API’s counting convention. Retry limits and total-attempt limits need not be identical; the safe statement preserves the configured retry limit without inventing that convention. This is a technical-precision caveat for that historical sample, not a claim about a particular API or the final Sol wording. The final Sol answer preserves the configured retry limit without equating it to total attempts.

## Verification boundaries

Completed local evaluation tests cover strict source equivalence, correction/identifier/negation preservation, partial exclusion, suite separation, unchanged action budgets, explicit reasoning override validation, effective reasoning reporting, raw decoder diagnostics, bounded continuation after framing errors and immediate abort on access/quota/transport errors. These tests validate application and evaluation behavior; they do not substitute for reviewing model answers.

Human naturalness ratings, physical microphone/conferencing behavior, accents/noise, overlapping speakers and visible screen-paint timing remain unverified. Final post-fix suite results appear in the opening section with their own exact artifacts and coverage; they do not replace the failure history.

The installed 0.4.3 app and saved Sol Smart preference with Luna Fast were verified during closeout. An installed-UI model test was started, but the screen locked before its final result could be read. This review does not claim that test passed; successful synthetic provider requests and source checks do not establish that unread UI result.
