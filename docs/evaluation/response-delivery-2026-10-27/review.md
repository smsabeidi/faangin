# Response delivery: model-assisted engineering review

October 27, 2026. This is an engineering review assisted by a language model, **not a human interview study**. No interviewer or candidate rated these outputs. Human rubric fields in the machine reports remain `null`.

The final implementation produces substantially shorter answers in these samples, while the saved `gpt-4.1-mini` model still shows material grounding and correctness failures. A separate `gpt-6-luna` experiment follows the revised delivery and grounding instructions more reliably on this small fixture set. The app’s saved model configuration was not changed. These observations do not establish perfect naturalness or correctness across models and real conversations.

## Evidence and method

The baseline compiler is pinned to commit `6fd27174f03690b6c24d73b2db5da5d8ab3738e9`. Each full run contains 12 public synthetic fixtures, with one baseline and one revised response per fixture. Request order alternates by fixture. Full action output budgets are preserved: Solve and Design retain 4,096 tokens; other evaluated actions retain 2,048. There is no added generation or rewrite pass.

The final scoped runs used the saved `gpt-4.1-mini` model and an explicitly selected `gpt-6-luna` experiment. They ran concurrently. Two further Luna repeats cover four critical cases, providing three current samples per critical case. Compiled prompt hashes match across those repeats for each current case.

Reports contain actual streamed answers, provider-reported input/output token usage, callback timings and compiled prompt hashes. Fixture illustrations are explicitly hand-authored; they are not substituted for measured model output. Automated phrase checks and quantitative indicators support review and do not establish semantic correctness by themselves.

The offline comparison requires exact input equality, except for one narrowly allowed adjustment: removing an empty derived `interviewSituation` when there is no finalized speech, included working answer, interrupted draft, or saved problem/constraints/attempt. All other serialized input, including the explicit request and factual profile, must remain byte-for-byte equal. Meaningful situations and altered source wording fail the audit. Output limits are checked separately.

Artifacts: [saved-model paired run](paired-scoped.json), [Luna paired run](paired-luna.json), [critical repeat 1](repeat-1.json), [critical repeat 2](repeat-2.json), [saved-model code check](code-scoped.json), [Luna code check](code-luna.json). Earlier iteration reports preserve failures that motivated the final revision.

## Separate quality dimensions

| Dimension | Saved `gpt-4.1-mini`, final scoped output | `gpt-6-luna`, final scoped output |
| --- | --- | --- |
| Factual accuracy and grounding | Not a clean pass. Behavioral story still claims the rollout completed “successfully without measurable negative impact,” which the profile does not establish. Webhook answer incorrectly equates 2 MB/s with about 172 Mbps; the correct decimal conversion is 16 Mbps. | No comparable material factual or invented-outcome error was identified in these samples. Behavioral wording preserves completion only. Webhook throughput of 2 MB/s and about 173 GB/day is consistent with decimal KB, excluding overhead. This is a sampled review, not a correctness guarantee. |
| Technical completeness | Weighted follow-up names 0-1 BFS and a deque but omits the necessary distance relaxation and change to permanent enqueue-time visitation. Correct binary-search implementation and a materially clearer boundary invariant are retained. | Weighted follow-up explicitly updates improved distances and parents and rejects permanent first-enqueue visitation. Binary-search invariant and sentinel result are preserved. BFS/DFS comparison omits an explicit DFS time/space statement present in its baseline. Webhook response compresses some API/data-model and specific outbound-endpoint security details. |
| Conversational naturalness | Shorter overall, with fewer long document sections. Some stock summary language and mechanical behavioral wording remain. | Replies generally start with the answer, use ordinary spoken phrasing and contractions where useful, and avoid routine offers to expand. Structured code and design detail remains where useful. Naturalness was reviewed from text, not rated by people listening to speech. |
| Contextual fit | Follow-up and corrected-transcript context is preserved. The Redis question receives another question rather than an explicit “No,” making the response less directly useful than its baseline. | Focused follow-ups remain focused; the missing-story case asks for a real example; uncertainty is proportional to absent evidence. The approximately two-minute design cue yields 312 whitespace-separated words, which needs an actual spoken pacing check. |
| Consistency | All expected ASSIST/WAIT outcomes pass in the final 12-case run; the saved model’s broader response quality remains variable. | All expected ASSIST/WAIT outcomes pass. Four critical cases also behave appropriately in three samples each. This is a small exploratory consistency check, not an error-rate estimate. |

No numerical naturalness score is assigned. Reduced length alone is not evidence that an answer sounds human or preserves every requested detail.

## Critical-case repeats on Luna

| Current case | Full run + repeat 1 + repeat 2 | Review finding |
| --- | --- | --- |
| Zero/one weighted correction | 3/3 explicit useful replies | All three use distance relaxation and a deque and explain why marking a vertex permanently visited on first enqueue is no longer valid. Parent handling and complexity are preserved. |
| Grounded behavioral story | 3/3 grounded outcomes | All three use supplied Cedar/billing/phased-rollout/checklist facts and end at the supported completion. None claims success, incident-free delivery, impact or measured savings. |
| Unfinished question | 3/3 WAIT, no visible answer | The question remains unfinished; no sample invents the missing database condition. |
| Already-strong unique-constraint answer | 3/3 two-sentence responses | All retain the database-dependent NULL qualification and distinguish uniqueness from semantic validity. No coaching preamble, invented correction or routine upsell is added. |

The repeated prompts have identical compiled hashes within each case. These are fresh provider samples, not repeated scoring of one answer.

## Quantitative results

The table reports totals across the 12 matched cases and medians across those heterogeneous requests. First-text medians exclude the WAIT response, so they use 11 visible responses; total medians use all 12. Timings begin after prompt compilation and end at the generation callback/completion. They exclude transcription, IPC, renderer commits and physical paint.

| Model | Variant | Input tokens, total | Output tokens, total | First text median, ms (n=11) | Total median, ms (n=12) | Total generation time, ms | Output words, total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gpt-4.1-mini | Baseline | 20,144 | 2,583 | 666.7 | 1,579.2 | 30,260.2 | 1,768 |
| gpt-4.1-mini | Revised | 17,954 | 1,637 | 738.6 | 1,237.8 | 22,904.7 | 1,103 |
| gpt-6-luna | Baseline | 20,136 | 1,872 | 663.5 | 1,519.2 | 25,163.7 | 1,259 |
| gpt-6-luna | Revised | 17,946 | 1,283 | 715.3 | 1,373.7 | 21,107.5 | 900 |

Revised input usage is about 10.9% lower for each model. Output usage is about 36.6% lower for the saved model and 31.5% lower for Luna in these samples. First text was slower in both revised runs; total medians were lower. These results support the measured local change in prompt/output size; they do not establish a universal provider latency improvement, an SLA, a p95, or model superiority. Concurrency, provider load, caching, request order and stochastic output length are uncontrolled. Do not infer cross-model speed from these concurrent runs.

## Generated-code verification

Each final baseline and revised `lower_bound` function was inspected before execution. The extracted function contains ordinary arithmetic, comparisons, local variables and `len`; annotated versions use only `list` and `int`. No imports, attribute access, file/network operations or external calls were admitted. Each ran in an isolated Python process with a 10-second timeout.

Every function matched Python’s `bisect_left` on **58,344 cases**: all nondecreasing arrays of lengths zero through seven drawn from integers -3 through 3, with targets from -4 through 4 in half-unit steps. Both variants on both final models passed. This finite check validates the sampled generated code on those cases; the application still does not execute users’ code, and this does not prove all possible inputs.

The current Luna explanation uses the correct before-`left`/at-or-after-`right` invariant and correctly permits `len(nums)`. One explanatory phrase says `mid` “remains in the search range” when `right = mid`; in a half-open interval, `mid` remains a possible boundary/result, not an element of the next interval. That phrasing remains imprecise even though the invariant, return behavior and code are correct.

## Remaining verification

Completed work includes deterministic source-preservation and context-boundary checks, full paired synthetic provider runs, critical-case repeats, semantic inspection of the actual outputs by engineering agents, and finite generated-code checks. Human listening judgments, candidate/interviewer acceptance, live microphone/system-audio conversations, accents/noise, actual interruption timing, transcription word/identifier error rates and physical visible latency have not been established by this evaluation.

The saved model’s invented outcome, missing weighted-distance update and bit-rate arithmetic error remain observed limitations. The stronger-model experiment is evidence of better instruction adherence on these fixtures, not a substitute for validating the user’s configured model. No fine-tuning dataset was available or justified by these observations.
