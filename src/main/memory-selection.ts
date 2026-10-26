import { MEMORY_LIMITS, selectMemoryCandidates, resolveMemorySnippets, validateMemorySnippets, type MemoryCandidate, type MemorySnippet, type PriorSessionContext } from './context-memory'
import type { Session } from '../shared/types'

/** Select the exact preview; a removal cannot be blocked by another stale excerpt. */
export function prepareMemorySelection(sessionId: string, ids: readonly string[], prior: readonly MemorySnippet[], displayed: readonly MemoryCandidate[], getSession: (id: string) => Session): MemorySnippet[] {
  if (!Array.isArray(displayed) || displayed.length > MEMORY_LIMITS.candidates) throw new Error('Refresh the bounded prior-session search.')
  if (!Array.isArray(prior) || prior.length > MEMORY_LIMITS.selected || !Array.isArray(ids) || ids.length > MEMORY_LIMITS.selected || new Set(ids).size !== ids.length) throw new Error('Choose at most four distinct prior-session excerpts.')
  const selected = ids.map(id => {
    const existing = prior.filter(item => item.id === id)
    if (existing.length > 1) throw new Error('Refresh the selected prior-session excerpts.')
    if (existing.length === 1) return existing[0]
    const matches = displayed.filter(item => item.id === id)
    if (matches.length !== 1) throw new Error('An excerpt is unavailable or ambiguous. Search again before selecting it.')
    return selectMemoryCandidates(sessionId, [id], matches)[0]
  })
  // Apply the budget to the retained edits, rather than to refreshed original previews.
  const validated = validateMemorySnippets(sessionId, selected)
  const additions = validated.filter(item => !prior.some(old => old.id === item.id)), sources = new Map<string, Session>()
  const resolved = resolveMemorySnippets(sessionId, additions, id => {
    const saved = getSession(id)
    if (saved.persistent === false) throw new Error('Choose a saved prior-session source.')
    sources.set(id, saved)
    return saved
  })
  for (let index = 0; index < additions.length; index++) checkAttribution(additions[index], resolved[index], sources.get(additions[index].sessionId)!)
  return validated
}

function checkAttribution(snippet: MemorySnippet, current: PriorSessionContext, session: Session): void {
  let label: string
  if (snippet.sourceKind === 'notes') label = 'Saved notes'
  else if (snippet.sourceKind === 'transcript') {
    const turn = session.transcript.find(item => item.id === snippet.sourceId && item.sessionId === session.id)!
    label = turn.channel === 'microphone' ? 'Microphone transcript' : turn.channel === 'system' ? 'System audio transcript' : 'Written context'
  } else label = `Saved ${session.answers.find(item => item.id === snippet.sourceId && item.sessionId === session.id)!.action} answer · generated text`
  if (snippet.sessionTitle !== current.sessionTitle || snippet.sessionMode !== current.mode || snippet.truncated !== current.truncated || snippet.label !== label) throw new Error('A displayed prior-session excerpt has invalid source attribution. Search again before selecting it.')
}
