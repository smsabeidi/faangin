import { createServer } from 'node:http'
import { once } from 'node:events'

/** Deterministic local transport fixture. This service does not perform inference. */
export async function startSmokeProvider() {
  const requests = [], sockets = new Set()
  const server = createServer((request, response) => {
    let raw = '', oversized = false
    request.on('data', chunk => { raw += chunk; if (raw.length > 300_000) { oversized = true; request.destroy() } })
    request.on('end', () => {
      if (oversized) return
      let body
      try { body = JSON.parse(raw) } catch { response.writeHead(400); response.end(); return }
      if (request.method !== 'POST' || request.headers.authorization || body.stream !== true || !['fixture-fast', 'fixture-smart'].includes(body.model)) { response.writeHead(400); response.end(); return }
      const item = { route: request.url, model: body.model, cancelled: false, memory: JSON.stringify(body.messages).includes('APPROVED_PRIOR_EXCERPT') }
      try {
        const content = body.messages.at(-1)?.content
        const source = JSON.parse(Array.isArray(content) ? content.find(part => part.type === 'text')?.text : content)
        item.automatic = typeof source.liveReplyTarget === 'string'; item.decisionProtocol = item.automatic && !!source.interviewConversation
      } catch { item.automatic = false }
      if (request.url === '/draft') {
        const parts = body.messages.at(-1)?.content
        let source
        try { source = JSON.parse(Array.isArray(parts) ? parts.find(part => part.type === 'text')?.text : parts) } catch { /* Recorded as a failed fixture below. */ }
        item.draftSources = source?.action === 'draft' && source.transcript?.length === 1 && source.transcript[0].sourceLink === '#source-T1' && source.transcript[0].text === 'Stored baseline transcript.' && !source.transcript[0].provisional && source.selectedImages?.length === 0 && source.selectedPriorSessionContext?.length === 0 && Object.keys(source.background ?? {}).length === 0 && body.messages.length === 2
        if (!item.draftSources) { requests.push(item); response.writeHead(400); response.end(); return }
      }
      if (request.url === '/reply') {
        const parts = body.messages.at(-1)?.content
        let source
        try { source = JSON.parse(Array.isArray(parts) ? parts.find(part => part.type === 'text')?.text : parts) } catch { /* Recorded as a failed fixture below. */ }
        item.replySources = source?.action === 'reply' && source.mode === 'interview' && source.transcript?.length === 1 && source.transcript[0].text === 'What is binary search?' && source.selectedImages?.length === 0 && source.userRequest === ''
        if (!item.replySources) { requests.push(item); response.writeHead(400); response.end(); return }
      }
      if (request.url === '/spoken-continuity') {
        const parts = body.messages.at(-1)?.content
        let source
        try { source = JSON.parse(Array.isArray(parts) ? parts.find(part => part.type === 'text')?.text : parts) } catch {}
        item.spokenContinuity = source?.action === 'reply' && source.mode === 'interview' && source.selectedImages?.length === 0 && source.currentInterviewSolution?.source === 'current_session_generated_response' && body.messages.some(message => message.role === 'assistant' && message.content === 'LOCAL FIXTURE: suggested spoken reply.')
        if (!item.spokenContinuity) { requests.push(item); response.writeHead(400); response.end(); return }
      }
      if (request.url === '/automatic') {
        const parts = body.messages.at(-1)?.content
        let source
        try { source = JSON.parse(Array.isArray(parts) ? parts.find(part => part.type === 'text')?.text : parts) } catch {}
        item.automaticSources = source?.action === 'reply' && source.mode === 'interview' && source.liveReplyTarget &&
          source.transcript?.some(turn => turn.id === source.liveReplyTarget && turn.channel === 'system' && turn.text === 'Explain a hash table.') &&
          source.transcript.every(turn => !turn.provisional) && !JSON.stringify(source).includes('UNFINISHED_FOLLOWUP') && source.selectedImages?.length === 0 && source.userRequest === ''
        if (!item.automaticSources) { requests.push(item); response.writeHead(400); response.end(); return }
      }
      if (request.url === '/interview-solve' || request.url === '/interview-followup') {
        const parts = body.messages.at(-1)?.content
        let source
        try { source = JSON.parse(Array.isArray(parts) ? parts.find(part => part.type === 'text')?.text : parts) } catch {}
        if (request.url === '/interview-solve') {
          item.interviewSolution = source?.action === 'solve' && source.mode === 'interview' && source.selectedImages?.length === 1 && parts.filter(part => part.type === 'image_url').length === 1 && source.interview?.problem.includes('unweighted graph')
          if (!item.interviewSolution) { requests.push(item); response.writeHead(400); response.end(); return }
        } else {
          item.interviewContinuity = source?.action === 'reply' && source.mode === 'interview' && source.currentInterviewSolution?.answerId && source.selectedImages?.length === 0 && body.messages.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('Use BFS with a queue')) && source.transcript?.some(turn => /Why BFS|edges have weights/.test(turn.text))
          if (!item.interviewContinuity) { requests.push(item); response.writeHead(400); response.end(); return }
        }
      }
      if (request.url === '/interruption') {
        const parts = body.messages.at(-1)?.content
        let source
        try { source = JSON.parse(Array.isArray(parts) ? parts.find(part => part.type === 'text')?.text : parts) } catch {}
        item.interruptionStage = source?.userRequest === 'Explain the current implementation while I review the code.' ? 'manual-old' : source?.liveReplyTarget?.endsWith(':auto-old') ? 'automatic-old' : source?.liveReplyTarget ? 'automatic-new' : 'manual-new'
        if (item.interruptionStage.endsWith('new')) {
          const situation = source?.interviewSituation
          item.interruptionContext = situation?.interruptedDrafts?.some(draft => draft.status === 'interrupted_draft' && draft.excerpts.some(part => part.text.includes('UNFINISHED_PLAN'))) && body.messages.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('Use BFS with a queue')) && source.selectedImages?.length === 0 && situation.questionFocus?.latestFinalizedUtterance?.excerpts?.some(part => /nonnegative|negative edges/.test(part.text))
          if (!item.interruptionContext) { requests.push(item); response.writeHead(400); response.end(); return }
        }
      }
      requests.push(item)
      if (request.url === '/quota' || (request.url === '/automatic-failure' && item.automatic)) { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'PRIVATE_FIXTURE_ERROR_TEXT' } })); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frame = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
      const id = `fixture-${requests.length}`, model = body.model
      const chunk = (text, finish = null) => ({ id, model, choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish }] })
      if (request.url === '/automatic-late-context') {
        const content = body.messages.at(-1)?.content
        const source = JSON.parse(Array.isArray(content) ? content.find(part => part.type === 'text')?.text : content)
        item.freshCandidateContext = source.interviewConversation.recentObservations.some(turn => turn.excerpts.some(part => part.text.includes('LATE_CANDIDATE_ANSWER')))
        const delayed = setTimeout(() => {
          frame(chunk(item.freshCandidateContext ? 'WAIT\n' : 'ASSIST\nSTALE_REPLY_MUST_NOT_APPEAR'))
          frame(chunk('', 'stop')); response.write('data: [DONE]\n\n'); response.end()
        }, item.freshCandidateContext ? 10 : 1_000)
        response.on('close', () => { clearTimeout(delayed); item.cancelled = !response.writableEnded }); return
      }
      if (request.url === '/automatic-wait') {
        const content = body.messages.at(-1)?.content
        const source = JSON.parse(Array.isArray(content) ? content.find(part => part.type === 'text')?.text : content)
        item.quietContext = item.decisionProtocol && source.interviewConversation.capturedAudioChannels.includes('microphone') && source.interviewConversation.recentObservations.some(turn => turn.relativeToTarget === 'observed_after_trigger' && turn.excerpts.some(part => part.text.includes('CANDIDATE_ALREADY_ANSWERED')))
        frame(chunk('WA')); frame(chunk('IT\n')); frame({ ...chunk('', 'stop'), usage: { prompt_tokens: 11, completion_tokens: 2 } }); response.write('data: [DONE]\n\n'); response.end(); return
      }
      if (request.url === '/automatic-malformed') {
        frame(chunk('unframed output must stay hidden')); frame(chunk('', 'stop')); response.write('data: [DONE]\n\n'); response.end(); return
      }
      if (item.decisionProtocol) { frame(chunk('AS')); frame(chunk('SIST\n')) }
      frame(chunk('LOCAL FIXTURE: '))
      if (item.interruptionStage?.endsWith('old')) frame(chunk('UNFINISHED_PLAN: Use BFS with a queue.\n```python\ndef shortest_path(graph, start):\n    queue = [start]\n'))
      const timer = setTimeout(() => {
        frame(chunk(request.url === '/slow' ? 'late output' : request.url === '/draft' ? 'follow-up draft. [T1](#source-T1)' : request.url === '/reply' ? 'suggested spoken reply.' : request.url === '/automatic' ? 'automatic spoken suggestion.' : request.url === '/interview-solve' ? 'Use BFS with a queue to find the shortest path in an unweighted graph. Track visited nodes and parents. Time O(V + E), space O(V).' : request.url === '/interview-followup' ? 'BFS explores by distance, so the first path found has the fewest edges. DFS does not guarantee that ordering. Weighted edges require a suitable weighted shortest-path algorithm.' : request.url === '/interruption' ? 'UPDATED_SCENARIO: Recheck the edge-weight assumptions before choosing the shortest-path algorithm. Preserve the unaffected graph representation and revise the frontier and distance updates.' : 'transport connected.'))
        frame({ ...chunk('', 'stop'), usage: { prompt_tokens: 11, completion_tokens: 7 } })
        response.write('data: [DONE]\n\n'); response.end()
      }, item.interruptionStage?.endsWith('old') ? 8_000 : request.url === '/slow' ? 2_000 : 15)
      response.on('close', () => { clearTimeout(timer); item.cancelled = !response.writableEnded })
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const { port } = server.address()
  return { endpoint: `http://127.0.0.1:${port}/chat/completions`, requests, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
