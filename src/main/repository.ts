import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Answer, type AudioChannel, type InterviewContext, type Session, type SessionListFilter, type SessionStatus, type SessionSummary, type Settings, type TranscriptTurn, type WorkspaceMode } from '../shared/types'
import { ACTIONS, interviewContext, sessionListFilter, settingsPatch } from './validation'
import { validateTranscriptReferences } from '../shared/transcript-references'

type Row = Record<string, string | number | null>
type StoredSession = Session & { persistent: boolean }
type StoredSummary = SessionSummary & { persistent: boolean }
export type RepositoryIssue = 'settings-corrupt' | 'answer-corrupt' | 'interview-corrupt' | 'configuration-corrupt' | 'deletion-checkpoint-pending'
export class RepositoryError extends Error {
  constructor(public readonly code: 'unsupported-schema' | 'storage-corrupt' | 'storage-unavailable' | 'storage-busy' | 'storage-full' | 'save-failed', message: string) { super(message); this.name = 'RepositoryError' }
}
export interface PermanentDeletionResult { deleted: true; persistent: boolean; cleanup: 'complete' | 'pending'; reason?: 'database-busy' | 'checkpoint-failed' }
const schemaVersion = 3
const tableColumns: Record<string, string[]> = {
  settings: ['id', 'json'], configuration: ['name', 'json'],
  sessions: ['id', 'title', 'mode', 'status', 'created_at', 'updated_at', 'ended_at', 'deleted_at', 'notes', 'context_epoch'],
  transcripts: ['id', 'session_id', 'channel', 'text', 'timestamp'], answers: ['id', 'session_id', 'json', 'created_at']
}
export class Repository {
  private db!: DatabaseSync
  private readonly ephemeral = new Map<string, Session>()
  private readonly issues = new Set<RepositoryIssue>()
  private historyEnabled = true
  private closed = false
  constructor(path: string, options: { historyEnabled?: boolean } = {}) {
    let database: DatabaseSync | undefined
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      database = new DatabaseSync(path); this.db = database
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
      if (!Number.isSafeInteger(version) || version < 0 || version > schemaVersion) throw new RepositoryError('unsupported-schema', 'This workspace schema is unsupported or was created by a newer application. Update Faangin before opening it; its data was preserved.')
      const integrity = this.db.prepare('PRAGMA quick_check(1)').get() as Row
      if (Object.values(integrity)[0] !== 'ok') throw new RepositoryError('storage-corrupt', 'Local workspace integrity could not be verified. Its files were preserved; restore a known-good copy before continuing.')
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Row[]
      if (tables.some(row => !Object.hasOwn(tableColumns, String(row.name)))) throw new RepositoryError('unsupported-schema', 'This file is not a supported Faangin workspace. It was preserved.')
      if (version > 0 && Object.keys(tableColumns).filter(name => name !== 'configuration' || version >= 3).some(name => !tables.some(row => row.name === name))) throw new RepositoryError('unsupported-schema', 'The workspace schema is incomplete or unsupported. Its data was preserved.')
      for (const row of tables) {
        const table = String(row.name), columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
        if (tableColumns[table].some(name => !columns.some(column => column.name === name)) || (table === 'sessions' && version >= 2 && !columns.some(column => column.name === 'interview_json'))) throw new RepositoryError('unsupported-schema', 'The workspace schema is incomplete or unsupported. Its data was preserved.')
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;')
      this.transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS configuration (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER, deleted_at INTEGER, notes TEXT NOT NULL DEFAULT '', context_epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, channel TEXT NOT NULL, text TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS transcript_session ON transcripts(session_id, timestamp);
      CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS answer_session ON answers(session_id, created_at);`)
        const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Row[]
        if (!columns.some(column => column.name === 'interview_json')) this.db.exec("ALTER TABLE sessions ADD COLUMN interview_json TEXT NOT NULL DEFAULT '{}';")
        if (!columns.some(column => column.name === 'transcript_incomplete')) this.db.exec('ALTER TABLE sessions ADD COLUMN transcript_incomplete INTEGER NOT NULL DEFAULT 0;')
        this.db.exec(`PRAGMA user_version=${schemaVersion};`)
        const now = Date.now()
        this.db.prepare("UPDATE sessions SET status='ended', ended_at=?, updated_at=? WHERE status IN ('starting','recording','paused','stopping')").run(now, now)
        for (const row of this.db.prepare('SELECT id,session_id,json,created_at FROM answers').all() as Row[]) {
          const answer = this.readAnswer(row)
          if (answer && answer.status === 'streaming') { answer.status = 'failed'; answer.error = 'Application closed before this answer completed.'; this.db.prepare('UPDATE answers SET json=? WHERE id=?').run(JSON.stringify(answer), row.id) }
        }
      })
      if (path !== ':memory:') for (const name of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(name)) chmodSync(name, 0o600)
      this.historyEnabled = options.historyEnabled ?? (this.settings() as Settings & { historyEnabled?: boolean }).historyEnabled ?? true
    } catch (error) {
      try { database?.close() } catch { /* Preserve the original failure. */ }
      if (error instanceof RepositoryError) throw error
      const code = (error as { errcode?: number })?.errcode
      throw new RepositoryError(code === 11 || code === 26 ? 'storage-corrupt' : 'storage-unavailable', 'The local workspace could not be opened. Its existing files were preserved. Check disk availability, permissions, and workspace integrity.')
    }
  }
  private write<T>(operation: () => T): T {
    try { return operation() } catch (error) {
      if ((error as { code?: string })?.code !== 'ERR_SQLITE_ERROR') throw error
      const code = (error as { errcode?: number }).errcode
      throw new RepositoryError(code === 5 || code === 6 ? 'storage-busy' : code === 13 ? 'storage-full' : 'save-failed', code === 13 ? 'Local storage is full. The change was not saved.' : code === 5 || code === 6 ? 'The workspace is busy. The change was not saved; retry after the other operation finishes.' : 'The local workspace could not save this change. Check disk availability and permissions.')
    }
  }
  private transaction<T>(operation: () => T): T { return this.write(() => { this.db.exec('BEGIN IMMEDIATE'); try { const result = operation(); this.db.exec('COMMIT'); return result } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ } throw error } }) }
  private readAnswer(row: Row): Answer | null {
    try {
      const answer = JSON.parse(String(row.json)) as Answer
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.id !== row.id || answer.sessionId !== row.session_id || typeof answer.requestId !== 'string' || typeof answer.prompt !== 'string' || typeof answer.text !== 'string' || typeof answer.model !== 'string' || !ACTIONS.includes(answer.action) || !['streaming', 'complete', 'cancelled', 'failed'].includes(answer.status) || !Number.isSafeInteger(answer.createdAt) || answer.createdAt < 0) throw new Error('Malformed answer')
      if (answer.transcriptReferences !== undefined) answer.transcriptReferences = validateTranscriptReferences(answer.transcriptReferences, answer.context?.transcriptIds ?? [])
      return answer
    } catch { this.issues.add('answer-corrupt'); return null }
  }
  close(): void { if (this.closed) return; this.db.close(); this.ephemeral.clear(); this.closed = true }
  setHistoryEnabled(enabled: boolean): void { if (typeof enabled !== 'boolean') throw new Error('Invalid history preference.'); this.historyEnabled = enabled }
  isHistoryEnabled(): boolean { return this.historyEnabled }
  isPersistent(id: string): boolean { this.get(id, true); return !this.ephemeral.has(id) }
  hasSavedSnapshot(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id) }
  makeEphemeral(id: string): StoredSession { if (!this.ephemeral.has(id)) this.ephemeral.set(id, structuredClone(this.get(id))); return this.get(id) }
  /** Called before an edit: with history off, the session continues in RAM and its saved snapshot stays unchanged. */
  shadowIfHistoryOff(id: string): void { if (!this.historyEnabled) this.makeEphemeral(id) }
  markTranscriptIncomplete(id: string): void {
    this.get(id)
    const ephemeral = this.ephemeral.get(id)
    if (ephemeral) { ephemeral.transcriptIncomplete = true; ephemeral.updatedAt = Date.now() }
    else this.write(() => this.db.prepare('UPDATE sessions SET transcript_incomplete=1,updated_at=? WHERE id=?').run(Date.now(), id))
  }
  diagnostics(): { schemaVersion: number; issueCodes: RepositoryIssue[]; persistentSessions: number; ephemeralSessions: number; trashedSessions: number; transcriptTurns: number; answers: number } {
    const count = (table: string, condition = '') => Number((this.db.prepare(`SELECT COUNT(*) count FROM ${table} ${condition}`).get() as Row).count)
    return { schemaVersion, issueCodes: [...this.issues].sort(), persistentSessions: count('sessions'), ephemeralSessions: this.ephemeral.size, trashedSessions: count('sessions', 'WHERE deleted_at IS NOT NULL') + [...this.ephemeral.values()].filter(s => s.deletedAt !== undefined).length, transcriptTurns: count('transcripts') + [...this.ephemeral.values()].reduce((n, s) => n + s.transcript.length, 0), answers: count('answers') + [...this.ephemeral.values()].reduce((n, s) => n + s.answers.length, 0) }
  }
  configuration(name: 'preset-catalog' | 'access-setup'): unknown | undefined {
    if (name !== 'preset-catalog' && name !== 'access-setup') throw new Error('Unsupported configuration namespace.')
    const row = this.db.prepare('SELECT json FROM configuration WHERE name=?').get(name) as Row | undefined
    if (!row) return undefined
    try { return JSON.parse(String(row.json)) } catch { this.issues.add('configuration-corrupt'); throw new RepositoryError('storage-corrupt', `The saved ${name === 'preset-catalog' ? 'preset catalog' : 'access setup'} is unreadable. Its record was preserved.`) }
  }
  saveConfiguration(name: 'preset-catalog' | 'access-setup', value: unknown): void {
    if (name !== 'preset-catalog' && name !== 'access-setup') throw new Error('Unsupported configuration namespace.')
    const json = JSON.stringify(value)
    if (!json || json.length > 1_000_000) throw new Error('Configuration is missing or too large.')
    this.write(() => this.db.prepare('INSERT INTO configuration(name,json) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET json=excluded.json').run(name, json))
    this.issues.delete('configuration-corrupt')
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT json FROM settings WHERE id=1').get() as Row | undefined
    if (!row) return { ...DEFAULT_SETTINGS }
    try { return { ...DEFAULT_SETTINGS, ...settingsPatch(JSON.parse(String(row.json))) } } catch { this.issues.add('settings-corrupt'); return { ...DEFAULT_SETTINGS, historyEnabled: false } as Settings }
  }
  saveSettings(settings: Settings): Settings {
    const validated = { ...DEFAULT_SETTINGS, ...settingsPatch(settings) }
    this.write(() => this.db.prepare('INSERT INTO settings(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(validated)))
    this.historyEnabled = (validated as Settings & { historyEnabled?: boolean }).historyEnabled ?? this.historyEnabled
    this.issues.delete('settings-corrupt')
    return validated
  }
  create(mode: WorkspaceMode): StoredSession {
    if (!['meeting', 'interview'].includes(mode)) throw new Error('Unsupported session mode.')
    const now = Date.now(), sessionId = randomUUID()
    const title = `${mode === 'meeting' ? 'Meeting' : 'Interview'} · ${new Date(now).toLocaleDateString()}`
    if (!this.historyEnabled) this.ephemeral.set(sessionId, { id: sessionId, title, mode, status: 'idle', createdAt: now, updatedAt: now, notes: '', contextEpoch: 0, interview: { ...DEFAULT_INTERVIEW_CONTEXT }, transcript: [], answers: [], attachments: [] })
    else this.write(() => this.db.prepare('INSERT INTO sessions(id,title,mode,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(sessionId, title, mode, 'idle', now, now))
    return this.get(sessionId)
  }
  epoch(id: string): number {
    const ephemeral = this.ephemeral.get(id)
    if (ephemeral) { if (ephemeral.deletedAt !== undefined) throw new Error('Session is unavailable.'); return ephemeral.contextEpoch }
    const row = this.db.prepare('SELECT context_epoch FROM sessions WHERE id=? AND deleted_at IS NULL').get(id) as Row | undefined
    if (!row) throw new Error('Session is unavailable.')
    return Number(row.context_epoch)
  }
  get(id: string, includeDeleted = false): StoredSession {
    const ephemeral = this.ephemeral.get(id)
    if (ephemeral) { if (!includeDeleted && ephemeral.deletedAt !== undefined) throw new Error('Session is unavailable.'); return { ...structuredClone(ephemeral), persistent: false } }
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined
    if (!row || (!includeDeleted && row.deleted_at !== null)) throw new Error('Session is unavailable.')
    const transcript = (this.db.prepare('SELECT * FROM transcripts WHERE session_id=? ORDER BY timestamp,id').all(id) as Row[]).map(r => ({ id: String(r.id), sessionId: id, channel: r.channel as TranscriptTurn['channel'], text: String(r.text), timestamp: Number(r.timestamp) }))
    const answers = (this.db.prepare('SELECT id,session_id,json,created_at FROM answers WHERE session_id=? ORDER BY created_at,id').all(id) as Row[]).map(r => this.readAnswer(r) ?? { id: String(r.id), requestId: `unreadable-${r.id}`, sessionId: id, action: 'ask' as const, prompt: '', text: '', model: 'unavailable', status: 'failed' as const, createdAt: Number(r.created_at), error: 'This saved answer is unreadable. Its original record was preserved.' })
    let interview: InterviewContext
    try {
      const saved: unknown = JSON.parse(String(row.interview_json))
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Malformed interview brief')
      interview = interviewContext({ ...DEFAULT_INTERVIEW_CONTEXT, ...saved })
    } catch { this.issues.add('interview-corrupt'); interview = { ...DEFAULT_INTERVIEW_CONTEXT } }
    return { id, title: String(row.title), mode: row.mode as WorkspaceMode, status: row.status as SessionStatus, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), endedAt: row.ended_at === null ? undefined : Number(row.ended_at), deletedAt: row.deleted_at === null ? undefined : Number(row.deleted_at), notes: String(row.notes), contextEpoch: Number(row.context_epoch), interview, transcript, answers, attachments: [], persistent: true, transcriptIncomplete: row.transcript_incomplete === 1 }
  }
  list(query = '', trash = false, filter: SessionListFilter = {}): StoredSummary[] {
    filter = sessionListFilter(filter)
    if (typeof query !== 'string' || query.length > 500) throw new Error('Search must use at most 500 characters.')
    const terms = query.trim().split(/\s+/).filter(Boolean)
    const clause = `(s.title LIKE ? ESCAPE '\\' OR s.notes LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM transcripts t WHERE t.session_id=s.id AND t.text LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM answers a WHERE a.session_id=s.id AND CASE WHEN json_valid(a.json) THEN coalesce(json_extract(a.json,'$.text'),'') || ' ' || coalesce(json_extract(a.json,'$.prompt'),'') ELSE '' END LIKE ? ESCAPE '\\') OR CASE WHEN json_valid(s.interview_json) THEN coalesce(json_extract(s.interview_json,'$.company'),'') || ' ' || coalesce(json_extract(s.interview_json,'$.role'),'') || ' ' || coalesce(json_extract(s.interview_json,'$.problem'),'') || ' ' || coalesce(json_extract(s.interview_json,'$.constraints'),'') || ' ' || coalesce(json_extract(s.interview_json,'$.candidateAttempt'),'') ELSE '' END LIKE ? ESCAPE '\\')`
    const rows = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM transcripts t WHERE t.session_id=s.id) transcript_count, (SELECT COUNT(*) FROM answers a WHERE a.session_id=s.id) answer_count, COALESCE((SELECT t.text FROM transcripts t WHERE t.session_id=s.id ORDER BY timestamp DESC LIMIT 1),'') preview FROM sessions s WHERE ${trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'} AND (? IS NULL OR s.updated_at >= ?) AND (? IS NULL OR s.updated_at < ?) AND (?='' OR s.mode=?) ${terms.length ? 'AND ' + terms.map(() => clause).join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 500`)
    const patterns = terms.flatMap(term => Array(5).fill(`%${term.replace(/[\\%_]/g, '\\$&')}%`))
    const persisted = (rows.all(filter.updatedFrom ?? null, filter.updatedFrom ?? null, filter.updatedBefore ?? null, filter.updatedBefore ?? null, filter.mode ?? '', filter.mode ?? '', ...patterns) as Row[]).filter(r => !this.ephemeral.has(String(r.id))).map(r => ({ id: String(r.id), title: String(r.title), mode: r.mode as WorkspaceMode, status: r.status as SessionStatus, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), deletedAt: r.deleted_at === null ? undefined : Number(r.deleted_at), transcriptCount: Number(r.transcript_count), answerCount: Number(r.answer_count), preview: String(r.preview).slice(0, 200), persistent: true }))
    const needles = terms.map(term => term.toLowerCase())
    const ephemeral = [...this.ephemeral.values()].filter(s => {
      const text = [s.title, s.notes, ...s.transcript.map(t => t.text), ...s.answers.flatMap(a => [a.text, a.prompt]), ...Object.values(s.interview ?? {}).filter((value): value is string => typeof value === 'string')].join(' ').toLowerCase()
      return (s.deletedAt !== undefined) === trash && (filter.updatedFrom === undefined || s.updatedAt >= filter.updatedFrom) && (filter.updatedBefore === undefined || s.updatedAt < filter.updatedBefore) && (filter.mode === undefined || s.mode === filter.mode) && needles.every(needle => text.includes(needle))
    }).map(s => ({ id: s.id, title: s.title, mode: s.mode, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, deletedAt: s.deletedAt, transcriptCount: s.transcript.length, answerCount: s.answers.length, preview: [...s.transcript].sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))[0]?.text.slice(0, 200) ?? '', persistent: false }))
    return [...persisted, ...ephemeral].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 500)
  }
  update(id: string, patch: { title?: string; notes?: string; interview?: InterviewContext }): StoredSession {
    const session = this.get(id)
    const interview = patch.interview ? interviewContext(patch.interview) : session.interview
    const ephemeral = this.ephemeral.get(id)
    if (ephemeral) { ephemeral.title = patch.title ?? session.title; ephemeral.notes = patch.notes ?? session.notes; ephemeral.interview = structuredClone(interview); ephemeral.updatedAt = Date.now() }
    else this.write(() => this.db.prepare('UPDATE sessions SET title=?,notes=?,interview_json=?,updated_at=? WHERE id=?').run(patch.title ?? session.title, patch.notes ?? session.notes, JSON.stringify(interview), Date.now(), id))
    return this.get(id)
  }
  applyGeneratedNotes(id: string, epoch: number, expectedNotes: string, notes: string): boolean {
    const ephemeral = this.ephemeral.get(id)
    if (ephemeral) { if (ephemeral.deletedAt !== undefined || ephemeral.contextEpoch !== epoch || ephemeral.notes !== expectedNotes) return false; ephemeral.notes = notes; ephemeral.updatedAt = Date.now(); return true }
    // A completed request must not overwrite notes saved in either window meanwhile.
    const result = this.write(() => this.db.prepare('UPDATE sessions SET notes=?,updated_at=? WHERE id=? AND context_epoch=? AND notes=? AND deleted_at IS NULL').run(notes, Date.now(), id, epoch, expectedNotes))
    return result.changes === 1
  }
  setStatus(id: string, status: SessionStatus): void {
    this.get(id)
    if (!['idle', 'starting', 'recording', 'paused', 'stopping', 'ended'].includes(status)) throw new Error('Unsupported session status.')
    const now = Date.now(), ephemeral = this.ephemeral.get(id)
    if (ephemeral) { ephemeral.status = status; ephemeral.endedAt = status === 'ended' ? now : undefined; ephemeral.updatedAt = now }
    else this.write(() => this.db.prepare('UPDATE sessions SET status=?,ended_at=?,updated_at=? WHERE id=?').run(status, status === 'ended' ? now : null, now, id))
  }
  trash(id: string): void { this.get(id); const ephemeral = this.ephemeral.get(id), now = Date.now(); if (ephemeral) { ephemeral.deletedAt = now; ephemeral.updatedAt = now } else this.write(() => this.db.prepare('UPDATE sessions SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, id)) }
  restore(id: string): void { this.get(id, true); const ephemeral = this.ephemeral.get(id); if (ephemeral) { delete ephemeral.deletedAt; ephemeral.updatedAt = Date.now() } else this.write(() => this.db.prepare('UPDATE sessions SET deleted_at=NULL,updated_at=? WHERE id=?').run(Date.now(), id)) }
  deletePermanently(id: string): PermanentDeletionResult {
    this.get(id, true)
    const stored = this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id) as Row | undefined
    if (stored) this.transaction(() => {
      this.db.prepare('DELETE FROM transcripts WHERE session_id=?').run(id)
      this.db.prepare('DELETE FROM answers WHERE session_id=?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id)
    })
    this.ephemeral.delete(id)
    if (!stored) return { deleted: true, persistent: false, cleanup: 'complete' }
    try {
      const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row
      if (Number(checkpoint.busy) !== 0) { this.issues.add('deletion-checkpoint-pending'); return { deleted: true, persistent: true, cleanup: 'pending', reason: 'database-busy' } }
      this.issues.delete('deletion-checkpoint-pending'); return { deleted: true, persistent: true, cleanup: 'complete' }
    } catch { this.issues.add('deletion-checkpoint-pending'); return { deleted: true, persistent: true, cleanup: 'pending', reason: 'checkpoint-failed' } }
  }
  reset(id: string): StoredSession {
    this.get(id)
    const ephemeral = this.ephemeral.get(id)
    if (ephemeral) { ephemeral.transcript = []; ephemeral.answers = []; ephemeral.notes = ''; ephemeral.interview = { ...DEFAULT_INTERVIEW_CONTEXT }; ephemeral.transcriptIncomplete = false; ephemeral.contextEpoch++; ephemeral.updatedAt = Date.now(); return this.get(id) }
    this.transaction(() => {
      this.db.prepare('DELETE FROM transcripts WHERE session_id=?').run(id)
      this.db.prepare('DELETE FROM answers WHERE session_id=?').run(id)
      this.db.prepare("UPDATE sessions SET notes='', interview_json='{}', transcript_incomplete=0, context_epoch=context_epoch+1,updated_at=? WHERE id=?").run(Date.now(), id)
    })
    return this.get(id)
  }
  transcript(sessionId: string, channel: AudioChannel | 'manual', text: string, stableId: string = randomUUID(), capturedAt = Date.now()): TranscriptTurn {
    this.epoch(sessionId)
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new Error('Invalid capture timestamp.')
    const turn: TranscriptTurn = { id: stableId, sessionId, channel, text, timestamp: capturedAt }
    const ephemeral = this.ephemeral.get(sessionId), collision = this.db.prepare('SELECT session_id FROM transcripts WHERE id=?').get(stableId) as Row | undefined
    if ((collision && collision.session_id !== sessionId) || [...this.ephemeral.values()].some(s => s.id !== sessionId && s.transcript.some(t => t.id === stableId))) throw new Error('Transcript identity collision.')
    if (ephemeral) {
      const existing = ephemeral.transcript.find(t => t.id === stableId)
      if (existing) return structuredClone(existing)
      ephemeral.transcript.push(turn); ephemeral.transcript.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)); ephemeral.updatedAt = Date.now(); return structuredClone(turn)
    }
    return this.transaction(() => {
      this.db.prepare('INSERT INTO transcripts(id,session_id,channel,text,timestamp) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(turn.id, sessionId, channel, text, turn.timestamp)
      this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), sessionId)
      const stored = this.db.prepare('SELECT * FROM transcripts WHERE id=? AND session_id=?').get(stableId, sessionId) as Row | undefined
      if (!stored) throw new Error('Transcript identity collision.')
      return { id: stableId, sessionId, channel: stored.channel as TranscriptTurn['channel'], text: String(stored.text), timestamp: Number(stored.timestamp) }
    })
  }
  saveAnswer(answer: Answer): void {
    this.epoch(answer.sessionId)
    const collision = this.db.prepare('SELECT session_id FROM answers WHERE id=?').get(answer.id) as Row | undefined
    if ((collision && collision.session_id !== answer.sessionId) || [...this.ephemeral.values()].some(s => s.id !== answer.sessionId && s.answers.some(a => a.id === answer.id))) throw new Error('Answer identity collision.')
    const ephemeral = this.ephemeral.get(answer.sessionId)
    if (ephemeral) { const index = ephemeral.answers.findIndex(a => a.id === answer.id); if (index < 0) ephemeral.answers.push(structuredClone(answer)); else ephemeral.answers[index] = structuredClone(answer); ephemeral.answers.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); ephemeral.updatedAt = Date.now() }
    else this.transaction(() => {
      this.db.prepare('INSERT INTO answers(id,session_id,json,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(answer.id, answer.sessionId, JSON.stringify(answer), answer.createdAt)
      this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), answer.sessionId)
    })
  }
}
