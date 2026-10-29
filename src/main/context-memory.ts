import type { Session, WorkspaceMode } from '../shared/types'

export type MemorySourceKind = 'notes' | 'transcript' | 'answer'
export interface MemoryCandidate {
  id: string
  sessionId: string
  sessionTitle: string
  sessionMode: WorkspaceMode
  contextEpoch: number
  sourceUpdatedAt: number
  sourceKind: MemorySourceKind
  sourceId: string
  sourceTimestamp: number
  label: string
  excerptStart: number
  text: string
  truncated: boolean
}
export interface MemorySnippet extends MemoryCandidate { originalText: string; edited: boolean }
export interface PriorSessionContext {
  source: 'selected_prior_session_excerpt'
  trust: 'untrusted_reference_data'
  id: string
  sessionId: string
  sessionTitle: string
  mode: WorkspaceMode
  contextEpoch: number
  sourceKind: MemorySourceKind
  sourceId: string
  timestamp: number
  text: string
  userEdited: boolean
  truncated: boolean
}
export const MEMORY_LIMITS = { sessions: 500, transcriptSourcesPerSession: 200, answerSourcesPerSession: 99, candidates: 50, selected: 4, snippetCharacters: 2_000, totalCharacters: 6_000, queryCharacters: 200 } as const

function clipped(value: string, max: number): string {
  const result = value.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result
}
function validText(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (nonempty && !value.trim())) throw new Error(`Enter text of at most ${max} characters.`)
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid prior-session source revision or timestamp.')
  return value
}
function sourceKey(sessionId: string, kind: MemorySourceKind, sourceId: string): string { return JSON.stringify([sessionId, kind, sourceId]) }
function candidate(session: Session, kind: MemorySourceKind, sourceId: string, text: string, timestamp: number, label: string, excerptStart = 0): MemoryCandidate | null {
  if (!text.trim() || excerptStart >= text.length) return null
  // Keep an excerpt boundary out of the middle of a UTF-16 surrogate pair.
  if (excerptStart > 0 && /[\uDC00-\uDFFF]/.test(text[excerptStart])) excerptStart--
  const excerpt = clipped(text.slice(excerptStart), MEMORY_LIMITS.snippetCharacters)
  return { id: sourceKey(session.id, kind, sourceId), sessionId: session.id, sessionTitle: clipped(session.title, 200), sessionMode: session.mode, contextEpoch: session.contextEpoch, sourceUpdatedAt: session.updatedAt, sourceKind: kind, sourceId, sourceTimestamp: timestamp, label, excerptStart, text: excerpt, truncated: excerptStart > 0 || excerpt.length < text.length }
}
function source(session: Session, kind: MemorySourceKind, sourceId: string, excerptStart = 0): MemoryCandidate | null {
  if (session.deletedAt !== undefined) return null
  let text: string, timestamp: number, label: string
  if (kind === 'notes') { text = session.notes; timestamp = session.updatedAt; label = 'Saved notes' }
  else if (kind === 'transcript') {
    const turn = session.transcript.find(item => item.id === sourceId && item.sessionId === session.id && !item.provisional)
    if (!turn) return null
    text = turn.text; timestamp = turn.timestamp; label = turn.channel === 'microphone' ? 'Microphone transcript' : turn.channel === 'system' ? 'System audio transcript' : 'Written context'
  } else {
    const answer = session.answers.find(item => item.id === sourceId && item.sessionId === session.id && item.status === 'complete')
    if (!answer) return null
    text = answer.text; timestamp = answer.createdAt; label = `Saved ${answer.action} answer · generated text`
  }
  return candidate(session, kind, sourceId, text, timestamp, label, excerptStart)
}

/** Local discovery only. Nothing is selected or sent by searching the library. */
export function memoryCandidates(input: { currentSessionId: string; sessions: readonly Session[]; query?: string; limit?: number }): MemoryCandidate[] {
  validText(input.currentSessionId, 128)
  const query = validText(input.query ?? '', MEMORY_LIMITS.queryCharacters, false).trim().toLocaleLowerCase()
  const limit = input.limit ?? MEMORY_LIMITS.candidates
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_LIMITS.candidates) throw new Error('Invalid prior-session search limit.')
  const tokens = query.split(/\s+/).filter(Boolean)
  const candidates: MemoryCandidate[] = []
  const compare = (a: MemoryCandidate, b: MemoryCandidate) => b.sourceTimestamp - a.sourceTimestamp || a.id.localeCompare(b.id)
  const add = (session: Session, kind: MemorySourceKind, sourceId: string, text: string, timestamp: number, label: string) => {
    const lowered = text.toLocaleLowerCase(), haystack = `${session.title.toLocaleLowerCase()}\n${lowered}`
    if (tokens.some(token => !haystack.includes(token))) return
    const match = tokens.map(token => lowered.indexOf(token)).find(index => index >= 0) ?? 0
    const item = candidate(session, kind, sourceId, text, timestamp, label, Math.max(0, match - 300))
    if (!item || candidates.some(existing => existing.id === item.id)) return
    candidates.push(item); candidates.sort(compare)
    if (candidates.length > limit) candidates.pop()
  }
  const sessions = input.sessions.filter(session => session.id !== input.currentSessionId && session.deletedAt === undefined).slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, MEMORY_LIMITS.sessions)
  for (const session of sessions) {
    add(session, 'notes', 'notes', session.notes, session.updatedAt, 'Saved notes')
    for (let index = session.transcript.length - 1; index >= Math.max(0, session.transcript.length - MEMORY_LIMITS.transcriptSourcesPerSession); index--) {
      const turn = session.transcript[index]
      if (turn.sessionId === session.id && !turn.provisional) add(session, 'transcript', turn.id, turn.text, turn.timestamp, turn.channel === 'microphone' ? 'Microphone transcript' : turn.channel === 'system' ? 'System audio transcript' : 'Written context')
    }
    for (let index = session.answers.length - 1; index >= Math.max(0, session.answers.length - MEMORY_LIMITS.answerSourcesPerSession); index--) {
      const answer = session.answers[index]
      if (answer.sessionId === session.id && answer.status === 'complete') add(session, 'answer', answer.id, answer.text, answer.createdAt, `Saved ${answer.action} answer · generated text`)
    }
  }
  return candidates
}

export function validateMemorySnippets(currentSessionId: string, value: unknown): MemorySnippet[] {
  validText(currentSessionId, 128)
  if (!Array.isArray(value) || value.length > MEMORY_LIMITS.selected) throw new Error('Choose at most four prior-session excerpts.')
  const snippets = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Invalid prior-session excerpt.')
    const data = item as Record<string, unknown>
    const allowed = ['id', 'sessionId', 'sessionTitle', 'sessionMode', 'contextEpoch', 'sourceUpdatedAt', 'sourceKind', 'sourceId', 'sourceTimestamp', 'label', 'excerptStart', 'text', 'truncated', 'originalText', 'edited']
    if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Unsupported prior-session excerpt field.')
    const sessionId = validText(data.sessionId, 128), sourceId = validText(data.sourceId, 512)
    if (sessionId === currentSessionId) throw new Error('Choose excerpts from a different saved session.')
    if (!['notes', 'transcript', 'answer'].includes(String(data.sourceKind)) || !['meeting', 'interview'].includes(String(data.sessionMode))) throw new Error('Unsupported prior-session source.')
    const sourceKind = data.sourceKind as MemorySourceKind
    if (data.id !== sourceKey(sessionId, sourceKind, sourceId) || (sourceKind === 'notes' && sourceId !== 'notes')) throw new Error('Invalid prior-session source identity.')
    const text = validText(data.text, MEMORY_LIMITS.snippetCharacters), originalText = validText(data.originalText, MEMORY_LIMITS.snippetCharacters)
    if (typeof data.truncated !== 'boolean' || typeof data.edited !== 'boolean' || data.edited !== (text !== originalText)) throw new Error('Invalid prior-session edit metadata.')
    return { id: data.id as string, sessionId, sourceId, sourceKind, sessionTitle: validText(data.sessionTitle, 200), sessionMode: data.sessionMode as WorkspaceMode, contextEpoch: integer(data.contextEpoch), sourceUpdatedAt: integer(data.sourceUpdatedAt), sourceTimestamp: integer(data.sourceTimestamp), label: validText(data.label, 100), excerptStart: integer(data.excerptStart), text, originalText, edited: data.edited, truncated: data.truncated }
  })
  if (new Set(snippets.map(snippet => snippet.id)).size !== snippets.length) throw new Error('An excerpt was selected more than once.')
  if (snippets.reduce((sum, snippet) => sum + snippet.text.length, 0) > MEMORY_LIMITS.totalCharacters) throw new Error('Prior-session excerpts exceed 6,000 characters. Shorten an excerpt or remove one.')
  return snippets
}

export function selectMemoryCandidates(currentSessionId: string, ids: readonly string[], candidates: readonly MemoryCandidate[]): MemorySnippet[] {
  if (!Array.isArray(ids) || ids.length > MEMORY_LIMITS.selected || new Set(ids).size !== ids.length) throw new Error('Choose at most four distinct prior-session excerpts.')
  const selected = ids.map(id => {
    const candidate = candidates.find(item => item.id === id)
    if (!candidate) throw new Error('An excerpt is unavailable. Search again before selecting it.')
    return { ...candidate, originalText: candidate.text, edited: false }
  })
  return validateMemorySnippets(currentSessionId, selected)
}

export function editMemorySnippet(currentSessionId: string, snippets: readonly MemorySnippet[], snippetId: string, text: string): MemorySnippet[] {
  if (!snippets.some(snippet => snippet.id === snippetId)) throw new Error('This excerpt is no longer selected. Refresh the session.')
  return validateMemorySnippets(currentSessionId, snippets.map(snippet => snippet.id === snippetId ? { ...snippet, text, edited: text !== snippet.originalText } : snippet))
}

/** Recheck authoritative local sources at request admission; never silently replace stale excerpts. */
export function resolveMemorySnippets(currentSessionId: string, value: unknown, getSession: (id: string) => Session): PriorSessionContext[] {
  const snippets = validateMemorySnippets(currentSessionId, value)
  return snippets.map(snippet => {
    const stale = () => new Error('A selected prior-session excerpt changed or was removed. Refresh the context list and reselect it before requesting assistance.')
    let session: Session
    try { session = getSession(snippet.sessionId) } catch { throw stale() }
    if (session.id !== snippet.sessionId || session.id === currentSessionId || session.deletedAt !== undefined) throw stale()
    const current = source(session, snippet.sourceKind, snippet.sourceId, snippet.excerptStart)
    if (!current || current.contextEpoch !== snippet.contextEpoch || current.sourceUpdatedAt !== snippet.sourceUpdatedAt || current.sourceTimestamp !== snippet.sourceTimestamp || current.text !== snippet.originalText) throw stale()
    return { source: 'selected_prior_session_excerpt', trust: 'untrusted_reference_data', id: current.id, sessionId: session.id, sessionTitle: current.sessionTitle, mode: session.mode, contextEpoch: session.contextEpoch, sourceKind: current.sourceKind, sourceId: current.sourceId, timestamp: current.sourceTimestamp, text: snippet.text, userEdited: snippet.edited, truncated: current.truncated }
  })
}
