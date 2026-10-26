# Answer a spoken interview question

**October 16 update — 0.2.4:** Use **Capture & solve → Listen → Answer follow-up** in Interview. Choose remote computer audio or an in-person microphone directly in Conversation; the selected preset enables that input. Replies retain the current generated solution even with additional history off, and manual Reply finalizes accepted speech before compiling. Stop now finalizes already accepted speech. Quiet-speech admission and source readiness have been repaired. See [current setup and verification](interview-reliability.md). The older version-specific records below are historical.

October 13, 2026 · Faangin 0.2.3 Live suggestions candidate; preserved 0.2.2 manual workflow evidence

Listening adds conversation context. Choose **Reply** for a manual response, or enable **Live suggestions** in 0.2.3 for automatic spoken replies after eligible finalized speech. The mode is off by default and automatic requests incur provider usage. **Capture screen** takes a screenshot; it does not start audio capture.

Live suggestions is currently available in the 0.2.3 source build; no 0.2.3 bundle or installer has been produced. `dist/live-candidate/mac-arm64/Faangin.app` is the planned output. Final native smoke/package verification awaits approval-review availability; see the [0.2.3 checkpoint](build-status.md#live-suggestions-candidate-023). The latest verified installer is 0.2.2 at `dist/spoken-candidate`, which supports manual Reply. When an updated bundle is ready, save/export needed data, including RAM-only sessions, and quit the previous instance before opening it; a second normal instance focuses the old workspace.

## Choose the right source

| Interview setup | Source to enable |
| --- | --- |
| Remote interviewer heard through computer/headphones | **System audio**, which captures the default computer output when supported by the OS |
| Interviewer speaking in the same room | **Microphone**, using the input that can hear them |
| Both your voice and a remote call | **Microphone** and **System audio**, with separate source health/transcript channels |

Microphone alone will not reliably capture a remote voice playing only through headphones. The selected screenshot display/window does not select the audio output. Physical devices, call routing and OS permissions still require verification on your machine.

1. If listening is active, choose **Stop listening**.
2. Open **Settings → Audio sources**, enable the appropriate source, and choose **Save changes**. For a remote call, enable **System audio**. Select the intended microphone when it is needed.
3. Return to the workspace, open **Conversation**, and choose **Start listening** or **Resume listening**. Grant requested OS permissions and restart listening if necessary.
4. Verify that the interviewer’s words appear under the expected source in **Conversation**. A moving meter or “Listening” status alone does not establish recognized speech.
5. Choose **Reply** in Conversation. This opens **Assistance** and requests a suggested spoken response. No typed question or screenshot is required once conversation text exists. Review the response before using it.

**Reply** is also available in Meeting and Interview quick actions and the expanded overlay. Conversation’s Reply button is disabled while another request/desktop operation is busy or when eligible conversation text is missing. It accepts finalized/manual current-session text, or nonblank live provisional speech from the actively captured current session. Paused/stopped uncommitted text is excluded from requests. Replies that use provisional speech carry a notice because that text can change.

Reply uses normal context admission: explicitly selected images, factual background, saved brief, opted-in prior answers and selected prior-session excerpts can still be included. It is not a transcript-only action. Unselect images when isolating the spoken-question path. Toolbar/overlay Reply also uses any current composer wording; Conversation Reply uses an empty prompt.

## Enable automatic Live suggestions

1. Stop or pause listening before changing audio sources. In **Settings → Audio sources**, enable the source that carries the interviewer’s voice.
2. Turn on **Live suggestions**, choose **Live suggestion source → System audio** for a remote call or **Microphone** for speech in the room, then choose **Save changes**. The selected source must also be enabled. Settings explain that this mode sends context automatically and incurs provider usage.
3. Start/resume listening in the same selected session and verify finalized words in Conversation. Saving the mode alone does not dispatch a request.
4. Watch **Automatic replies** status: Off, Listening, Waiting for speech to settle, Preparing a reply or Paused, with the reason displayed. Generated cards are labelled **Automatic suggestion**. Review suggestions before using them.
5. Turn off **Live suggestions** in Conversation to stop automatic requests, or stop/pause listening. Manual Reply remains available. On provider failure, correct the problem and explicitly toggle the mode off/on, reconfigure it or start a new capture to resume; a manual Reply does not clear the automatic failure pause.

The trigger accepts finalized selected-source utterances containing letters or numbers, including statements and follow-ups. It does not classify questions, infer speaker identity or guarantee semantic usefulness. Choosing Microphone can therefore trigger on your own speech. Empty/punctuation-only finals do not create requests; use manual Reply when an automatic suggestion is missed or unsuitable.

The coordinator settles adjacent finals for a nominal 350 ms, waits at least three seconds between automatic starts and allows at most six automatic starts in a rolling 60 seconds. One request runs at a time, with only the latest pending target retained. Rate history survives toggling/resetting; these are automatic-dispatch limits, not total provider usage caps or response-time promises. Manual requests and speech transcription have separate usage. Continuing selected-source partial speech defers the next suggestion until it settles.

Automatic context is frozen at the finalized target and excludes later unfinished speech and all images. Bounded finalized conversation can include other enabled channels; the chosen source controls the trigger, not an exclusive transcript-upload filter. Normal admitted background can include profile/job context, saved notes/interview brief, opted-in answers and selected prior-session excerpts. Your composer wording is preserved and is not consumed by an automatic request. A suggestion can reveal Assistance when you are not actively editing; editor drafts remain mounted and focus is preserved while typing.

Disable, Stop/Pause, sleep, source failure, session change/reset, key removal and relevant provider/settings changes invalidate automatic work. Manual actions take priority. Failure pauses the mode with no automatic retry. The mode does not automatically capture screenshots, run code or send a message to another person.

## Locate the failure

| What you see | Next check |
| --- | --- |
| No interviewer words in Conversation | Confirm the correct source is enabled and saved, listening actually started, the expected output/input is active, and permissions/source health are healthy |
| Words appear but no answer starts | Choose manual Reply, or check that Live suggestions is enabled/saved, the selected source is connected, speech is finalized and the displayed waiting/paused reason is resolved |
| Reply is disabled | Wait for nonblank eligible current-session text and for active work to finish; stopped uncommitted text is not eligible |
| A provider error appears after Reply | Review the displayed connection/quota/model error. Screenshot/Solve working does not prove that live transcription is configured or healthy |
| A response appears but is incomplete or inaccurate | Review transcript finalization, the included context and the actual model response; source channels identify capture origins, not named speakers |

The new status **Low audio level — raise the source volume if speech is playing.** indicates that frames contain some energy but have not sustained the existing admission-level signal. It is a conditional diagnostic, not proof that speech is present. **Silent — check the source if speech is playing.** and **No audio frames — reconnect this source.** remain separate conditions. These notices do not lower the voice-activity threshold, add automatic gain or change which audio is sent. Three consecutive adequate frames recover the listening indication; recognized words must still be verified in Conversation.

With an empty focused composer, **⌘/Ctrl+Enter** requests **Assist** from existing context when the matching native shortcut is unavailable. Typed text requests **Ask**, and adding Shift requests **Solve**. Busy/working guards and native-shortcut ownership prevent duplicate dispatch. The empty **Send question** button remains disabled; use Reply, Assist or the shortcut for conversation-only context.

## Historical 0.2.2 evidence

The user reported that screenshot capture and Solve worked, while spoken questions produced no response. A read-only metadata inspection found microphone enabled, system audio disabled, and seven microphone turns with no system turns in the latest saved transcript. No transcript text or credentials were inspected, and primary settings were not changed. This supports checking remote-audio configuration; it does not establish the physical source, current live stream or the complete cause of the report.

The source changes expose manual Reply, distinguish screenshot/listening controls, repair the empty-composer fallback and add audio-health diagnostics. The final source suite passed 343 tests with no failures/skips, including four composer and five audio-health regressions; typecheck/production build, separate 0.2.2 packaging and final packaged smoke passed. Finished checksums, build provenance and four verification logs are saved at `dist/spoken-candidate`.

Both source smoke and the final packaged smoke exited 0; the packaged log is `/private/tmp/faangin-spoken-packaged-smoke.log`. Six localhost requests include the public manual transcript “What is binary search?” as a proxy for a captured question, then a click on the actual Interview Conversation **Reply** button with an empty composer and no images in an isolated hidden renderer. The request reached the main API and `/reply` fixture with that sole transcript context and rendered its answer. The other fixture paths include draft sources retained across restart. This verifies explicit dispatch/context/persistence, not real speech capture, audio routing, provider quality or physical visible interaction. No live recording or paid API request was performed for these checks. Enabling and saving System audio remains a deliberate user action; the engineering checks did not change primary settings.

See the preserved [0.2.2 build evidence](build-status.md#spoken-question-candidate-022), [release acceptance](release-readiness.md#spoken-question-candidate-022) and [requirement status](feature-status.md#spoken-question-candidate-022). Automatic generation was not present in that version; this manual-only record remains historical.

## Live suggestions 0.2.3 evidence and limits

The final integrated suite passed 385 tests with no failures/skips, and typecheck/production build passed after the failure-pause correction. An earlier seven-request source smoke passed. The expanded final nine-request smoke, which adds failure-pause/manual fallback checks, was not executed: Codex automatic approval review failed because its account usage limit was reached. This was a review-capacity rejection, not a finding that the action was unsafe. Packaging, packaged smoke and finished checksums remain pending; no 0.2.3 installer exists. The isolated automatic fixture uses the same final-ingestion callback as transcription with public text proxies and localhost responses. It does not establish real audio, provider quality or physical visible interaction. No primary preferences, keys, paid calls or recordings were changed/used.

[Actual Rea analysis](../research/rea-live-suggestions.md) examined public client files and reports partial coverage, versioned findings and unknown hosted behavior. It is development research, not part of Faangin’s runtime and not private-backend reverse engineering. This implementation applies an explicit Faangin trigger/cost policy; it does not establish exact Cluely/InterviewCoder operational parity.

See [0.2.3 build evidence](build-status.md#live-suggestions-candidate-023), [release acceptance](release-readiness.md#live-suggestions-candidate-023) and [requirement status](feature-status.md#live-suggestions-candidate-023). The full PRD backlog, live speech/model quality, physical device acceptance, signing and Windows remain open.
