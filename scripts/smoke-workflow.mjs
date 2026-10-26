/** Runs only against a credential-free, isolated smoke workspace. */
export async function runDesktopWorkflow(api, providerEndpoint, options = {}) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const rejected = async (operation, pattern, label) => {
    try { await operation() } catch (error) {
      check(pattern.test(String(error)), `${label} failed with an unexpected error.`)
      return
    }
    throw new Error(`${label} unexpectedly succeeded.`)
  }
  const initial = await api.getState()
  check(initial.keyConfigured === false, 'Smoke must start without an OpenAI credential.')
  await api.updateSettings({ historyEnabled: true })
  const baseline = await api.createSession('interview')
  await api.updateSession(baseline.id, { title: 'Smoke persisted baseline', notes: 'Stored baseline notes.' })
  await api.appendTranscript(baseline.id, 'Stored baseline transcript.')

  await rejected(() => api.startCapture(baseline.id), /OpenAI API key.*Settings/i, 'Missing-key capture')
  const failed = await api.getState()
  check(failed.capture.active === false && failed.capture.sessionId === null && failed.currentSession?.id === baseline.id && failed.currentSession.status === 'ended', 'Missing-key capture left a live capture intent or a nonterminal session.')
  const endedAt = failed.currentSession.endedAt
  await api.pauseCapture(); await api.pauseCapture(); await api.stopCapture(); await api.stopCapture()
  const stopped = await api.getState()
  check(stopped.capture.active === false && stopped.capture.sessionId === null && stopped.capture.microphone === 'Off' && stopped.capture.system === 'Off' && stopped.currentSession.status === 'ended' && stopped.currentSession.endedAt === endedAt, 'Repeated pause or stop changed an already-ended capture.')
  const awaitAnswer = async (requestId, predicate) => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const answer = (await api.getState()).currentSession?.answers.find(answer => answer.requestId === requestId)
      if (answer && predicate(answer)) return answer
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error('Local fixture answer did not settle.')
  }
  await api.updateSettings({ chatProvider: 'compatible', compatibleChatEndpoint: providerEndpoint, compatibleChatModel: 'fixture-fast', compatibleChatSmartModel: 'fixture-smart', compatibleChatVision: false })
  const source = await api.createSession('meeting')
  await api.updateSession(source.id, { title: 'Approved prior source', notes: 'APPROVED_PRIOR_EXCERPT: a saved public fixture decision.' })
  await api.selectSession(baseline.id)
  const displayed = await api.memoryCandidates(baseline.id, 'APPROVED_PRIOR_EXCERPT')
  check(displayed.length === 1, 'Saved prior context was not discoverable.')
  await api.selectMemory(baseline.id, [displayed[0].id], displayed)
  const admission = []
  const stopObserving = api.onEvent(event => {
    if (event.type === 'answer-started') admission.push({ type: event.type, requestId: event.answer.requestId, bytes: JSON.stringify(event).length, text: event.answer.text, status: event.answer.status })
    else if (event.type === 'answer-delta') admission.push({ type: event.type, requestId: event.requestId })
  })
  let fastRequest, fast
  try {
    fastRequest = await api.generate({ sessionId: baseline.id, action: 'ask', prompt: 'Public fixture request.', smart: false })
    fast = await awaitAnswer(fastRequest.requestId, answer => answer.status !== 'streaming')
  } finally { stopObserving() }
  const fastAdmission = admission.filter(event => event.requestId === fastRequest.requestId)
  check(fastAdmission[0]?.type === 'answer-started' && fastAdmission[0].status === 'streaming' && fastAdmission[0].text === '' && fastAdmission[0].bytes < 5_000 && fastAdmission.filter(event => event.type === 'answer-started').length === 1 && fastAdmission.some(event => event.type === 'answer-delta'), 'Narrow answer admission was missing, duplicated or arrived after the first streamed text.')
  check(fast.status === 'complete' && fast.text === 'LOCAL FIXTURE: transport connected.' && fast.model === 'fixture-fast' && fast.inputTokens === 11 && fast.outputTokens === 7 && fast.context.memorySourceIds.length === 1 && fast.firstTokenMs >= 0, 'The complete main-process provider route lost text, usage, timing, or selected context.')
  const renderDeadline = Date.now() + 2_000
  const renderedFirstAnswer = () => [...document.querySelectorAll('.answer-card .markdown')].some(element => element.textContent?.includes(fast.text))
  while (!renderedFirstAnswer() && Date.now() < renderDeadline) await new Promise(resolve => setTimeout(resolve, 15))
  check(renderedFirstAnswer(), 'The first admitted answer did not reach the actual workspace renderer.')
  await api.selectMemory(baseline.id, [])
  const smartRequest = await api.generate({ sessionId: baseline.id, action: 'ask', prompt: 'Public Smart fixture request.', smart: true })
  check((await awaitAnswer(smartRequest.requestId, answer => answer.status !== 'streaming')).model === 'fixture-smart', 'Explicit Smart policy did not reach its configured provider model.')
  await api.selectMemory(baseline.id, [displayed[0].id], displayed)
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/draft'), includeHistory: true })
  const draftRequest = await api.generate({ sessionId: baseline.id, action: 'draft', prompt: '' })
  const followupDraft = await awaitAnswer(draftRequest.requestId, answer => answer.status !== 'streaming')
  check(followupDraft.status === 'complete' && followupDraft.text === 'LOCAL FIXTURE: follow-up draft. [T1](#source-T1)' && followupDraft.transcriptReferences?.length === 1 && followupDraft.transcriptReferences[0].text === 'Stored baseline transcript.' && followupDraft.transcriptReferences[0].label === 'T1' && followupDraft.context.transcriptIds[0] === followupDraft.transcriptReferences[0].turnId && followupDraft.context.priorAnswerIds.length === 0 && followupDraft.context.memorySourceIds.length === 0 && (await api.getState()).currentSession.notes === 'Stored baseline notes.', 'Follow-up drafts lost their source snapshots or changed saved notes.')
  await api.selectMemory(baseline.id, []); await api.updateSettings({ includeHistory: false })
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/slow') })
  const cancelRequest = await api.generate({ sessionId: baseline.id, action: 'ask', prompt: 'Public cancellation fixture request.' })
  await awaitAnswer(cancelRequest.requestId, answer => !!answer.text)
  await api.cancelGeneration(cancelRequest.requestId)
  const cancelled = await awaitAnswer(cancelRequest.requestId, answer => answer.status !== 'streaming')
  check(cancelled.status === 'cancelled' && cancelled.text === 'LOCAL FIXTURE: ', 'Cancelled fixture output was not retained as incomplete.')
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/quota') })
  const quotaRequest = await api.generate({ sessionId: baseline.id, action: 'ask', prompt: 'Public quota fixture request.' })
  const quota = await awaitAnswer(quotaRequest.requestId, answer => answer.status !== 'streaming')
  check(quota.status === 'failed' && /quota/i.test(quota.error) && !quota.error.includes('PRIVATE_FIXTURE'), 'Provider quota errors were not safely surfaced.')

  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/reply') })
  const spokenSession = await api.createSession('interview')
  const spokenTurn = await api.appendTranscript(spokenSession.id, 'What is binary search?')
  const replyButton = () => document.querySelector('.transcript-panel .transcript-scroll')?.textContent?.includes('What is binary search?') && [...document.querySelectorAll('.transcript-panel .capture-card button')].find(button => /^Answer (follow-up|latest)$/.test(button.textContent?.trim() ?? '') && !button.disabled)
  const replyDeadline = Date.now() + 2_000
  while (!replyButton() && Date.now() < replyDeadline) await new Promise(resolve => setTimeout(resolve, 15))
  check(replyButton(), 'Interview conversation did not expose a usable Reply control.')
  let replyRequestId
  const stopReplyObserving = api.onEvent(event => { if (event.type === 'answer-started' && event.answer.sessionId === spokenSession.id && event.answer.action === 'reply') replyRequestId = event.answer.requestId })
  let spokenReply
  try {
    replyButton().click()
    const requestDeadline = Date.now() + 2_000
    while (!replyRequestId && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 15))
    check(replyRequestId, 'The Interview Reply control did not dispatch a request.')
    spokenReply = await awaitAnswer(replyRequestId, answer => answer.status !== 'streaming')
  } finally { stopReplyObserving() }
  check(spokenReply.status === 'complete' && spokenReply.text === 'LOCAL FIXTURE: suggested spoken reply.' && spokenReply.prompt === '' && spokenReply.context.transcriptIds.includes(spokenTurn.id) && spokenReply.context.attachmentIds.length === 0, 'Conversation Reply did not use transcript-only context without typed text or screenshots.')
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/spoken-continuity') })
  await api.appendTranscript(spokenSession.id, 'Why does that approach work?')
  const spokenContinuationRequest = await api.generate({ sessionId: spokenSession.id, action: 'reply', attachmentIds: [] })
  const spokenContinuation = await awaitAnswer(spokenContinuationRequest.requestId, answer => answer.status !== 'streaming')
  check(spokenContinuation.status === 'complete' && spokenContinuation.context.priorAnswerIds.includes(spokenReply.id) && spokenContinuation.context.attachmentIds.length === 0, 'Audio-only follow-up lost its preceding response with history off.')

  const liveProxy = window.faanginSmoke?.liveFixture
  check(typeof liveProxy === 'function', 'Isolated finalized-speech proxy was unavailable.')
  // Composite interview: selected screenshot -> real Solve button -> manual and
  // automatic spoken follow-ups with history off and no automatic image upload.
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/interview-solve'), compatibleChatVision: true, includeHistory: false, systemAudio: true, microphone: false, liveSuggestions: false, liveSuggestionSource: 'system' })
  const interviewFlow = await api.createSession('interview')
  await api.updateSession(interviewFlow.id, { title: 'Interview workflow verification', interview: { company: '', role: '', round: 'coding', stage: 'approach', problem: 'Find the shortest path in an unweighted graph.', constraints: 'The graph can contain cycles.', candidateAttempt: '' } })
  const problemImage = await liveProxy({ type: 'image', sessionId: interviewFlow.id })
  const solveButton = () => [...document.querySelectorAll('.interview-flow button')].find(button => button.textContent?.trim() === 'Solve selected' && !button.disabled)
  let deadline = Date.now() + 2_000
  while (!solveButton() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15))
  check(solveButton(), 'Selected interview image did not expose Solve selected.')
  solveButton().click()
  const awaitInterviewAnswer = async action => {
    const until = Date.now() + 5_000
    while (Date.now() < until) {
      const answer = (await api.getState()).currentSession?.answers.find(answer => answer.action === action && answer.status !== 'streaming')
      if (answer) return answer
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error('Interview fixture answer did not settle.')
  }
  const solution = await awaitInterviewAnswer('solve')
  check(solution.status === 'complete' && solution.context.attachmentIds.length === 1 && solution.context.attachmentIds[0] === problemImage.id && solution.context.interviewContextKey, 'Selected-image solve lost its admitted screenshot or problem identity.')
  await api.selectAttachments(interviewFlow.id, [])
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/interview-followup'), compatibleChatVision: false })
  await liveProxy({ type: 'start', sessionId: interviewFlow.id })
  const permissionProbe = await liveProxy({ type: 'permission-probe' })
  check(permissionProbe.reachedDisplayHandler === true && permissionProbe.observedLegacyDisplay === true && permissionProbe.streamGranted === false, 'Electron 44 display capture was rejected by the app permission gate before source selection.')
  const nativeAudio = options.nativeAudio ? await liveProxy({ type: 'native-audio-probe' }) : undefined
  if (options.nativeAudio) check(nativeAudio && nativeAudio.streamGranted === true && nativeAudio.audioTrackCount > 0 && nativeAudio.audioTrackLive === true && nativeAudio.videoTracksEnded === true && nativeAudio.contextState === 'running' && nativeAudio.sampleCount > 0 && nativeAudio.contextClosed === true && nativeAudio.allTracksEnded === true && !nativeAudio.error, `Native system audio did not provide a live track, bounded analysis, and complete cleanup: ${JSON.stringify(nativeAudio)}`)
  await liveProxy({ type: 'final', itemId: 'bfs-followup', channel: 'system', text: 'Why BFS instead of DFS for this solution?' })
  const flowReply = () => [...document.querySelectorAll('.interview-flow button')].find(button => /^Answer (follow-up|latest)$/.test(button.textContent?.trim() ?? '') && !button.disabled)
  deadline = Date.now() + 2_000
  while (!flowReply() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15))
  check(flowReply(), 'Interview flow did not expose a spoken follow-up action.')
  flowReply().click()
  const explanation = await awaitInterviewAnswer('reply')
  check(explanation.status === 'complete' && explanation.origin === 'manual' && explanation.context.priorAnswerIds.includes(solution.id) && explanation.context.attachmentIds.length === 0, 'BFS follow-up lost the working solution with general history off.')
  await api.updateSettings({ liveSuggestions: true })
  await liveProxy({ type: 'final', itemId: 'weighted-followup', channel: 'system', text: 'What changes if the edges have weights?' })
  deadline = Date.now() + 5_000
  let automaticExplanation
  while (Date.now() < deadline) {
    automaticExplanation = (await api.getState()).currentSession.answers.find(answer => answer.origin === 'automatic' && answer.status !== 'streaming')
    if (automaticExplanation) break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check(automaticExplanation?.status === 'complete' && automaticExplanation.context.priorAnswerIds.includes(solution.id) && automaticExplanation.context.priorAnswerIds.includes(explanation.id) && automaticExplanation.context.attachmentIds.length === 0, 'Automatic follow-up did not retain the solution and preceding explanation without screenshots.')
  await api.stopCapture()
  await api.updateSettings({ liveSuggestions: false, compatibleChatVision: false })
  // Real local streams are cancelled when the selected source revises a scenario.
  // Manual mode stays quiet until the explicit Answer latest takeover.
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/interruption'), microphone: true, systemAudio: true })
  await liveProxy({ type: 'start', sessionId: interviewFlow.id })
  const manualOldRequest = await api.generate({ sessionId: interviewFlow.id, action: 'ask', prompt: 'Explain the current implementation while I review the code.', attachmentIds: [] })
  await awaitAnswer(manualOldRequest.requestId, answer => answer.text.includes('UNFINISHED_PLAN'))
  await liveProxy({ type: 'final', itemId: 'wrong-interruption-source', channel: 'microphone', text: 'Do not interrupt the remote source for this local speech.' })
  check((await api.getState()).currentSession.answers.find(answer => answer.requestId === manualOldRequest.requestId).status === 'streaming', 'An unselected input interrupted the manual interview answer.')
  await liveProxy({ type: 'final', itemId: 'manual-twist', channel: 'system', text: 'Correction: all edge weights are nonnegative; some are zero. Update the code for this scenario.' })
  const manualInterrupted = await awaitAnswer(manualOldRequest.requestId, answer => answer.status !== 'streaming')
  check(manualInterrupted.status === 'cancelled' && manualInterrupted.interruption?.reason === 'new-question' && manualInterrupted.text.includes('UNFINISHED_PLAN'), 'A new finalized scenario did not stop and preserve the manual draft.')
  await new Promise(resolve => setTimeout(resolve, 80))
  check((await api.getState()).currentSession.answers.length === 4, 'Manual mode issued an unsolicited replacement response.')
  const latestButton = () => [...document.querySelectorAll('.interview-flow button')].find(button => button.textContent?.trim() === 'Answer latest' && !button.disabled)
  deadline = Date.now() + 2_000
  while (!latestButton() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15))
  check(latestButton(), 'Interrupted interview did not expose a usable Answer latest takeover.')
  let replacementId
  const stopReplacementObserving = api.onEvent(event => { if (event.type === 'answer-started' && event.answer.sessionId === interviewFlow.id && event.answer.action === 'reply') replacementId = event.answer.requestId })
  let manualUpdated
  try {
    latestButton().click()
    deadline = Date.now() + 2_000
    while (!replacementId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15))
    check(replacementId, 'Answer latest did not dispatch the replacement.')
    manualUpdated = await awaitAnswer(replacementId, answer => answer.status !== 'streaming')
  } finally { stopReplacementObserving() }
  check(manualUpdated.status === 'complete' && manualUpdated.text.includes('UPDATED_SCENARIO') && manualUpdated.context.priorAnswerIds.includes(solution.id) && manualUpdated.context.interruptedAnswerIds?.includes(manualInterrupted.id), 'Replacement lost the complete code baseline or labelled interrupted draft.')
  await api.updateSettings({ liveSuggestions: true })
  await liveProxy({ type: 'final', itemId: 'auto-old', channel: 'system', text: 'Explain the revised priority queue invariant.' })
  deadline = Date.now() + 6_000
  let automaticOld
  while (Date.now() < deadline) {
    automaticOld = (await api.getState()).currentSession.answers.find(answer => answer.origin === 'automatic' && answer.status === 'streaming' && answer.text.includes('UNFINISHED_PLAN'))
    if (automaticOld) break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check(automaticOld, 'Automatic interrupted-stream fixture did not start.')
  await liveProxy({ type: 'partial', itemId: 'auto-twist', channel: 'system', text: 'Instead, now allow negative edges' })
  const automaticInterrupted = await awaitAnswer(automaticOld.requestId, answer => answer.status !== 'streaming')
  check(automaticInterrupted.status === 'cancelled' && automaticInterrupted.interruption?.reason === 'new-speech', 'Continuing question speech left obsolete automatic output streaming.')
  await new Promise(resolve => setTimeout(resolve, 80))
  check((await api.getState()).currentSession.answers.length === 6, 'An unfinished scenario started a replacement generation.')
  await liveProxy({ type: 'final', itemId: 'auto-twist', channel: 'system', text: 'Instead, now allow negative edges. Would the current shortest-path choice still be correct?' })
  deadline = Date.now() + 6_000
  let automaticUpdated
  while (Date.now() < deadline) {
    automaticUpdated = (await api.getState()).currentSession.answers.find(answer => answer.origin === 'automatic' && answer.status === 'complete' && answer.text.includes('UPDATED_SCENARIO'))
    if (automaticUpdated) break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check(automaticUpdated?.context.priorAnswerIds.includes(solution.id) && automaticUpdated.context.interruptedAnswerIds?.includes(automaticInterrupted.id) && (await api.getState()).liveSuggestions.phase !== 'paused', 'Automatic scenario replacement lost context or treated intentional interruption as provider failure.')
  await api.stopCapture()
  await api.updateSettings({ liveSuggestions: false })
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/automatic'), systemAudio: true, microphone: true, liveSuggestions: false, liveSuggestionSource: 'system' })
  const liveSession = await api.createSession('interview')
  await liveProxy({ type: 'start', sessionId: liveSession.id })
  await liveProxy({ type: 'final', itemId: 'disabled', channel: 'system', text: 'This must not request an answer while disabled.' })
  await new Promise(resolve => setTimeout(resolve, 450))
  check((await api.getState()).currentSession.answers.length === 0, 'Disabled live suggestions issued a request.')
  await api.updateSettings({ liveSuggestions: true })
  await liveProxy({ type: 'final', itemId: 'wrong-source', channel: 'microphone', text: 'My explanation must not trigger the remote-source policy.' })
  await liveProxy({ type: 'final', itemId: 'automatic-question', channel: 'system', text: 'Explain a hash table.' })
  await liveProxy({ type: 'partial', itemId: 'followup', channel: 'system', text: 'UNFINISHED_FOLLOWUP' })
  await new Promise(resolve => setTimeout(resolve, 450))
  check((await api.getState()).currentSession.answers.length === 0, 'Wrong source or unfinished speech triggered an automatic answer.')
  await liveProxy({ type: 'final', itemId: 'followup', channel: 'system', text: '' })
  const autoDeadline = Date.now() + 5_000
  let automaticAnswer
  while (Date.now() < autoDeadline) {
    automaticAnswer = (await api.getState()).currentSession.answers.find(answer => answer.origin === 'automatic' && answer.status !== 'streaming')
    if (automaticAnswer) break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check(automaticAnswer?.status === 'complete' && automaticAnswer.text === 'LOCAL FIXTURE: automatic spoken suggestion.' && automaticAnswer.action === 'reply' && automaticAnswer.prompt === '' && automaticAnswer.usedPartialContext === false && automaticAnswer.context.attachmentIds.length === 0 && automaticAnswer.context.replyTargetId?.endsWith(':automatic-question'), 'Finalized speech did not produce a source-bounded automatic streamed reply.')
  const autoRenderDeadline = Date.now() + 2_000
  while (![...document.querySelectorAll('.answer-card')].some(card => card.textContent.includes('Automatic suggestion') && card.textContent.includes(automaticAnswer.text)) && Date.now() < autoRenderDeadline) await new Promise(resolve => setTimeout(resolve, 15))
  check([...document.querySelectorAll('.answer-card')].some(card => card.textContent.includes('Automatic suggestion') && card.textContent.includes(automaticAnswer.text)), 'Automatic reply did not appear in the actual renderer.')
  await liveProxy({ type: 'final', itemId: 'automatic-question', channel: 'system', text: 'Explain a hash table.' })
  await liveProxy({ type: 'final', itemId: 'cancel-on-disable', channel: 'system', text: 'This pending question must be cancelled.' })
  await api.updateSettings({ liveSuggestions: false })
  await new Promise(resolve => setTimeout(resolve, 450))
  check((await api.getState()).currentSession.answers.length === 1, 'Duplicate or disable did not suppress pending automatic work.')
  await api.updateSettings({ liveSuggestions: true })
  await liveProxy({ type: 'final', itemId: 'cancel-on-stop', channel: 'system', text: 'This pending turn must not answer after Stop.' })
  await api.stopCapture()
  await liveProxy({ type: 'final', itemId: 'late-stop', channel: 'system', text: 'Late speech after Stop must not trigger.' })
  await new Promise(resolve => setTimeout(resolve, 450))
  check((await api.getState()).currentSession.answers.length === 1 && (await api.getState()).liveSuggestions.phase === 'ready', 'Stop admitted pending or late automatic work.')

  // A one-call model disposition can keep listening without creating or saving
  // an answer card, while observing candidate speech finalized after the target.
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/automatic-wait'), liveSuggestions: true })
  const quietSession = await api.createSession('interview')
  await liveProxy({ type: 'start', sessionId: quietSession.id })
  await liveProxy({ type: 'final', itemId: 'quiet-target', channel: 'system', text: 'Why use BFS instead of DFS?' })
  await liveProxy({ type: 'final', itemId: 'candidate-answer', channel: 'microphone', text: 'CANDIDATE_ALREADY_ANSWERED: BFS explores by shortest distance in the unweighted graph.' })
  const quietDeadline = Date.now() + 5_000
  let quietObserved = false
  while (Date.now() < quietDeadline) {
    const observed = await api.getState()
    if (observed.liveSuggestions.phase === 'understanding') quietObserved = true
    if (observed.liveSuggestions.phase === 'listening' && observed.currentSession.transcript.length === 2 && Date.now() > quietDeadline - 3_500) break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check((await api.getState()).currentSession.answers.length === 0 && !document.querySelector('.answer-card'), 'WAIT disposition created an empty answer or leaked the protocol into the renderer.')
  await api.stopCapture()
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/automatic-late-context'), liveSuggestions: true })
  const lateContextSession = await api.createSession('interview')
  await liveProxy({ type: 'start', sessionId: lateContextSession.id })
  await liveProxy({ type: 'final', itemId: 'late-context-question', channel: 'system', text: 'Why does the algorithm find a shortest path?' })
  const understandingDeadline = Date.now() + 4_000
  while ((await api.getState()).liveSuggestions.phase !== 'understanding' && Date.now() < understandingDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  check((await api.getState()).liveSuggestions.phase === 'understanding', 'The new target never entered unpublished understanding.')
  await new Promise(resolve => setTimeout(resolve, 100))
  await liveProxy({ type: 'final', itemId: 'late-context-answer', channel: 'microphone', text: 'LATE_CANDIDATE_ANSWER: BFS explores by shortest distance and I have explained the invariant.' })
  await new Promise(resolve => setTimeout(resolve, 1_800))
  const lateContextState = await api.getState()
  check(lateContextState.liveSuggestions.phase === 'listening' && lateContextState.currentSession.answers.length === 0 && !document.body.textContent.includes('STALE_REPLY_MUST_NOT_APPEAR'), 'Late candidate speech did not reconsider the unpublished response with fresh context.')
  await api.stopCapture()
  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/automatic-malformed'), liveSuggestions: true })
  const malformedSession = await api.createSession('interview')
  await liveProxy({ type: 'start', sessionId: malformedSession.id })
  await liveProxy({ type: 'final', itemId: 'malformed-target', channel: 'system', text: 'Explain the invariant.' })
  const malformedDeadline = Date.now() + 5_000
  let malformedAnswer
  while (Date.now() < malformedDeadline) {
    const observed = await api.getState()
    malformedAnswer = observed.currentSession.answers.find(answer => answer.status === 'failed')
    if (malformedAnswer && observed.liveSuggestions.phase === 'paused') break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check(malformedAnswer?.text === '' && /expected reply format/i.test(malformedAnswer.error) && (await api.getState()).liveSuggestions.phase === 'paused', 'Malformed automatic protocol leaked text or retried instead of pausing safely.')
  await api.stopCapture()

  await api.updateSettings({ compatibleChatEndpoint: providerEndpoint.replace('/chat/completions', '/automatic-failure'), liveSuggestions: true })
  const failureSession = await api.createSession('interview')
  await liveProxy({ type: 'start', sessionId: failureSession.id })
  await liveProxy({ type: 'final', itemId: 'provider-failure', channel: 'system', text: 'Provider failure should pause live suggestions.' })
  const failureDeadline = Date.now() + 6_000
  let failedAutomatic
  while (Date.now() < failureDeadline) {
    const observed = await api.getState()
    failedAutomatic = observed.currentSession.answers.find(answer => answer.origin === 'automatic' && answer.status === 'failed')
    if (failedAutomatic && observed.liveSuggestions.phase === 'paused') break
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  check(failedAutomatic && /quota/i.test(failedAutomatic.error) && !failedAutomatic.error.includes('PRIVATE_FIXTURE') && (await api.getState()).liveSuggestions.phase === 'paused', 'Automatic provider failure did not pause without retry.')
  await liveProxy({ type: 'final', itemId: 'paused-no-retry', channel: 'system', text: 'No request should run while suggestions are paused.' })
  await new Promise(resolve => setTimeout(resolve, 450))
  check((await api.getState()).currentSession.answers.length === 1, 'Paused automatic mode retried after new speech.')
  const manualFallback = await api.generate({ sessionId: failureSession.id, action: 'reply', prompt: '' })
  const fallbackAnswer = await awaitAnswer(manualFallback.requestId, answer => answer.status !== 'streaming')
  check(fallbackAnswer.status === 'complete' && fallbackAnswer.origin === 'manual' && fallbackAnswer.text === 'LOCAL FIXTURE: transport connected.' && (await api.getState()).liveSuggestions.phase === 'paused', 'Manual Reply was unavailable or restarted automatic mode after provider failure.')
  await api.stopCapture()
  await api.updateSettings({ liveSuggestions: false, systemAudio: false })
  await api.selectSession(baseline.id)
  await api.updateSettings({ chatProvider: 'openai', compatibleChatEndpoint: providerEndpoint })

  const originalIds = new Set(initial.presets.presets.map(preset => preset.id))
  const draft = { name: 'Smoke response preset', kind: 'response', mode: 'interview', instructions: 'Explain the invariant before implementation.' }
  let catalog = await api.managePreset({ type: 'create', draft })
  const response = catalog.presets.find(preset => !originalIds.has(preset.id))
  check(response?.instructions === draft.instructions && response.builtIn === false, 'Custom response preset was not created.')
  await api.choosePreset(baseline.id, 'response', response.id)
  check((await api.getState()).presets.choices[baseline.id]?.responseId === response.id, 'Response preset choice was not applied.')
  const updatedDraft = { ...draft, instructions: 'Explain complexity and test duplicate values.' }
  catalog = await api.managePreset({ type: 'update', id: response.id, draft: updatedDraft, revision: response.revision })
  const updated = catalog.presets.find(preset => preset.id === response.id)
  check(updated?.instructions === updatedDraft.instructions && updated.revision === response.revision + 1, 'Preset edit was not saved.')
  await rejected(() => api.managePreset({ type: 'update', id: response.id, draft, revision: response.revision }), /changed in another window/i, 'Stale preset edit')
  check((await api.getState()).presets.presets.find(preset => preset.id === response.id)?.instructions === updatedDraft.instructions, 'A stale preset edit overwrote the saved preset.')
  const beforeDuplicate = new Set(catalog.presets.map(preset => preset.id))
  catalog = await api.managePreset({ type: 'duplicate', id: response.id })
  const duplicate = catalog.presets.find(preset => !beforeDuplicate.has(preset.id))
  check(duplicate?.id !== response.id && duplicate?.instructions === updatedDraft.instructions, 'Preset duplication lost the saved instructions.')
  const beforeNotes = new Set(catalog.presets.map(preset => preset.id))
  catalog = await api.managePreset({ type: 'create', draft: { name: 'Smoke note template', kind: 'notes', mode: 'interview', instructions: '# Observations\n# Follow-up practice' } })
  const notes = catalog.presets.find(preset => !beforeNotes.has(preset.id))
  check(notes?.kind === 'notes', 'Custom note template was not created.')
  await api.choosePreset(baseline.id, 'notes', notes.id)
  check((await api.getState()).presets.choices[baseline.id]?.noteTemplateId === notes.id, 'Note template choice was not applied.')
  catalog = await api.managePreset({ type: 'restore-defaults' })
  check(catalog.presets.some(preset => preset.id === response.id) && catalog.presets.some(preset => preset.id === notes.id) && [...originalIds].every(id => catalog.presets.some(preset => preset.id === id)), 'Restoring built-in presets discarded custom presets.')
  await api.managePreset({ type: 'delete', id: response.id })
  const choice = (await api.getState()).presets.choices[baseline.id]
  check(choice?.responseId === null && choice.noteTemplateId === notes.id, 'Deleting a response preset changed the wrong session choice.')
  await rejected(() => api.choosePreset(baseline.id, 'response', response.id), /unavailable/i, 'Deleted preset selection')
  await api.managePreset({ type: 'delete', id: duplicate.id }); await api.managePreset({ type: 'delete', id: notes.id })
  const finalPresets = (await api.getState()).presets
  check(finalPresets.choices[baseline.id]?.noteTemplateId === null && [response.id, duplicate.id, notes.id].every(id => !finalPresets.presets.some(preset => preset.id === id)), 'Deleted presets remained in the catalog or session choices.')

  const disposable = await api.createSession('interview')
  const brief = { company: 'Fixture company', role: 'Software engineer', round: 'coding', stage: 'verify', problem: 'Return the two matching indices.', constraints: 'Distinct indices.', candidateAttempt: 'return []' }
  await api.updateSession(disposable.id, { title: 'Smoke purge fixture', notes: 'Reset this note.', interview: brief })
  await api.appendTranscript(disposable.id, 'Reset this transcript.')
  await api.selectAttachments(disposable.id, []); await api.reorderAttachments(disposable.id, [])
  await api.choosePreset(disposable.id, 'response', 'builtin:interview-coach')
  const beforeReset = await api.getState()
  await api.resetContext(disposable.id)
  const reset = (await api.getState()).currentSession
  check(reset?.id === disposable.id && reset.contextEpoch === beforeReset.currentSession.contextEpoch + 1 && reset.notes === '' && reset.interview.problem === '' && reset.interview.candidateAttempt === '' && reset.transcript.length === 0 && reset.answers.length === 0 && reset.attachments.length === 0 && reset.selectedAttachmentIds.length === 0, 'Context reset did not clear the current session coherently.')
  await rejected(() => api.permanentlyDeleteSession(disposable.id), /Trash/i, 'Purge of an active session')
  await api.deleteSession(disposable.id)
  check(!(await api.listSessions()).some(session => session.id === disposable.id) && (await api.listSessions('', true)).some(session => session.id === disposable.id), 'Trash did not move the session between library views.')
  await rejected(() => api.selectSession(disposable.id), /unavailable/i, 'Trashed session selection')
  await api.restoreSession(disposable.id)
  check((await api.selectSession(disposable.id)).id === disposable.id, 'Restored session could not be selected.')
  await api.deleteSession(disposable.id); await api.permanentlyDeleteSession(disposable.id)
  check(!(await api.listSessions()).some(session => session.id === disposable.id) && !(await api.listSessions('', true)).some(session => session.id === disposable.id), 'Purged session remained in a library view.')
  await rejected(() => api.restoreSession(disposable.id), /unavailable/i, 'Purged session recovery')

  await api.selectSession(baseline.id); await api.choosePreset(baseline.id, 'response', 'builtin:interview-coach'); await api.updateSettings({ historyEnabled: false })
  await api.updateSession(baseline.id, { title: 'Temporary RAM shadow', notes: 'RAM shadow notes.' })
  await api.appendTranscript(baseline.id, 'RAM shadow transcript.')
  await api.choosePreset(baseline.id, 'response', 'builtin:system-design')
  const shadow = (await api.getState()).currentSession
  check(shadow?.id === baseline.id && shadow.persistent === false && shadow.notes === 'RAM shadow notes.' && shadow.transcript.length === 2, 'History-off editing did not use a RAM shadow of the saved session.')
  const ephemeral = await api.createSession('interview')
  await api.updateSession(ephemeral.id, { title: 'Smoke RAM-only session', notes: 'RAM-only notes.' })
  await api.appendTranscript(ephemeral.id, 'RAM-only transcript.')
  await api.choosePreset(ephemeral.id, 'response', 'builtin:interview-coach')
  const ram = await api.getState()
  check(ram.currentSession?.id === ephemeral.id && ram.currentSession.persistent === false && ram.sessions.find(session => session.id === ephemeral.id)?.persistent === false, 'A history-off session was reported as persistent.')
  await api.updateSettings({ historyEnabled: true })
  check((await api.getState()).currentSession.persistent === false && (await api.selectSession(baseline.id)).persistent === false, 'Re-enabling history silently promoted a RAM session.')
  return {
    capture: { missingKeyRejected: true, intentEnded: true, repeatedPauseStop: true, nativeDisplayPermissionReached: true, permissionProbeOpenedNoStream: true },
    inference: { fast: true, smart: true, context: true, cancellation: true, safeQuota: true, sourceLinkedDraft: true, screenshotSolve: true, interviewFollowup: true, automaticInterviewFollowup: true },
    presets: { create: true, choice: true, update: true, staleEditRejected: true, duplicate: true, restoreDefaults: true, delete: true },
    context: { reset: true, trash: true, restore: true, purge: true, purgeGuard: true },
    history: { ramShadow: true, ramSession: true, noAutomaticPromotion: true },
    ...(nativeAudio ? { nativeAudio } : {}),
    ids: { persisted: baseline.id, ephemeral: ephemeral.id, purged: disposable.id, answer: fast.id, draft: followupDraft.id, interviewFlow: interviewFlow.id, interrupted: manualInterrupted.id, automaticInterrupted: automaticInterrupted.id, latestScenario: automaticUpdated.id }
  }
}

/** Confirm disk persistence through the real preload API after an app restart. */
export async function verifyDesktopPersistence(api, ids) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const initial = await api.getState(), active = await api.listSessions(), trash = await api.listSessions('', true)
  check(initial.settings.historyEnabled === true, 'The saved history preference was not restored.')
  check([...active, ...trash].every(session => session.id !== ids.ephemeral && session.id !== ids.purged), 'A RAM-only or purged session survived application restart.')
  for (const id of [ids.ephemeral, ids.purged]) {
    let unavailable = false
    try { await api.selectSession(id) } catch (error) { unavailable = /unavailable/i.test(String(error)) }
    check(unavailable, 'A RAM-only or purged session can still be selected after restart.')
  }
  check(initial.presets.choices[ids.ephemeral] === undefined && initial.presets.choices[ids.purged] === undefined, 'A transient or purged preset choice was written to disk.')
  check(initial.presets.choices[ids.persisted]?.responseId === 'builtin:interview-coach', 'RAM edits changed the original saved session preset choice.')
  const baseline = await api.selectSession(ids.persisted)
  check(baseline.persistent === true && baseline.title === 'Smoke persisted baseline' && baseline.notes === 'Stored baseline notes.' && baseline.transcript.length === 1 && baseline.transcript[0].text === 'Stored baseline transcript.', 'History-off editing changed the saved baseline on disk.')
  check(baseline.answers.some(answer => answer.id === ids.answer && answer.status === 'complete' && answer.text === 'LOCAL FIXTURE: transport connected.' && answer.context.memorySourceIds.length === 1), 'A completed provider answer or its provenance was not durable across restart.')
  check(baseline.answers.some(answer => answer.id === ids.draft && answer.status === 'complete' && answer.text === 'LOCAL FIXTURE: follow-up draft. [T1](#source-T1)' && answer.transcriptReferences?.[0].text === 'Stored baseline transcript.' && answer.context.memorySourceIds.length === 0), 'A source-linked draft snapshot was not durable across restart.')
  const interview = await api.selectSession(ids.interviewFlow)
  check(interview.answers.some(answer => answer.id === ids.interrupted && answer.status === 'cancelled' && answer.interruption?.reason === 'new-question' && answer.text.includes('UNFINISHED_PLAN')), 'Interrupted code and its reason were not durable across restart.')
  check(interview.answers.some(answer => answer.id === ids.latestScenario && answer.status === 'complete' && answer.context.interruptedAnswerIds?.includes(ids.automaticInterrupted) && answer.context.interviewSnapshot?.problem.includes('unweighted graph')), 'The updated scenario lost its baseline snapshot or interrupted-draft provenance across restart.')
  return { savedBaseline: true, answerDurable: true, draftDurable: true, interruptedDraftDurable: true, scenarioContextDurable: true, ramSessionDiscarded: true, ramShadowDiscarded: true, transientPresetChoiceDiscarded: true, purgedSessionAbsent: true }
}
