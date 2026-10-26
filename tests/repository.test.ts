import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Repository, RepositoryError } from '../src/main/repository'
import { DEFAULT_INTERVIEW_CONTEXT, DEFAULT_SETTINGS, type Answer } from '../src/shared/types'
import { generateInput, settingsPatch } from '../src/main/validation'

test('SQLite persists session, transcript, notes, settings and answer; recovers interrupted capture', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-repository-')), path = join(directory, 'test.sqlite')
  try {
    let repo = new Repository(path)
    const session = repo.create('meeting')
    repo.setStatus(session.id, 'recording'); repo.update(session.id, { title: 'Specific roadmap', notes: 'Decision recorded' })
    repo.transcript(session.id, 'microphone', 'Budget is 10%', 'stable-segment')
    repo.transcript(session.id, 'microphone', 'Duplicate callback must not overwrite', 'stable-segment')
    repo.saveSettings({ ...DEFAULT_SETTINGS, fontSize: 17, hideDockIcon: false })
    repo.saveAnswer({ id: 'answer', requestId: 'request', sessionId: session.id, action: 'recap', prompt: '', text: 'Partial', model: 'example', status: 'streaming', createdAt: Date.now() })
    repo.close(); repo = new Repository(path)
    const restored = repo.get(session.id)
    assert.equal(restored.status, 'ended'); assert.equal(restored.transcript.length, 1)
    assert.equal(restored.transcript[0].text, 'Budget is 10%'); assert.equal(restored.notes, 'Decision recorded')
    assert.equal(restored.answers[0].status, 'failed'); assert.equal(repo.settings().fontSize, 17)
    assert.equal(repo.settings().hideDockIcon, false)
    assert.equal(repo.list('10%').length, 1); assert.equal(repo.list('10_').length, 0)
    repo.trash(session.id); assert.equal(repo.list().length, 0); assert.throws(() => repo.get(session.id))
    assert.equal(repo.list('', true).length, 1); repo.restore(session.id); assert.equal(repo.list().length, 1)
    const reset = repo.reset(session.id)
    assert.equal(reset.contextEpoch, 1); assert.equal(reset.transcript.length, 0); assert.equal(reset.answers.length, 0); assert.equal(reset.notes, '')
    repo.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('strict settings and generation schemas exclude secrets and unknown privilege fields', () => {
  assert.throws(() => settingsPatch({ apiKey: 'secret' })); assert.throws(() => settingsPatch({ opacity: 1.1 })); assert.throws(() => settingsPatch({ microphone: 'yes' }))
  assert.throws(() => generateInput({ sessionId: 'x', action: 'execute', prompt: 'danger' }))
  assert.throws(() => generateInput({ sessionId: 'x', action: 'ask', attachmentIds: Array(9).fill('image') }))
  assert.throws(() => generateInput({ sessionId: 'x', action: 'ask', tools: ['shell'] }))
  assert.deepEqual(settingsPatch({ theme: 'light', opacity: .8 }), { theme: 'light', opacity: .8 })
  assert.deepEqual(settingsPatch({ opacity: 0 }), { opacity: 0 })
  assert.throws(() => settingsPatch({ opacity: -.01 }))
})

test('generated notes preserve a newer saved edit and can still apply to an unchanged snapshot', () => {
  const repo = new Repository(':memory:')
  try {
    const session = repo.create('meeting')
    repo.update(session.id, { notes: 'Original notes' })
    const snapshot = repo.get(session.id)
    repo.update(session.id, { notes: 'User edited this during generation' })
    assert.equal(repo.applyGeneratedNotes(session.id, snapshot.contextEpoch, snapshot.notes, 'Older generated answer'), false)
    assert.equal(repo.get(session.id).notes, 'User edited this during generation')
    const latest = repo.get(session.id)
    assert.equal(repo.applyGeneratedNotes(session.id, latest.contextEpoch, latest.notes, 'New generated notes'), true)
    assert.equal(repo.get(session.id).notes, 'New generated notes')
  } finally { repo.close() }
})

test('context reset and Trash prevent late generated notes from restoring cleared context', () => {
  const repo = new Repository(':memory:')
  try {
    const session = repo.create('meeting')
    repo.reset(session.id)
    assert.equal(repo.applyGeneratedNotes(session.id, session.contextEpoch, '', 'Old generated notes'), false)
    const current = repo.get(session.id)
    repo.trash(session.id)
    assert.equal(repo.applyGeneratedNotes(session.id, current.contextEpoch, '', 'Deleted-session notes'), false)
    repo.restore(session.id)
    assert.equal(repo.get(session.id).notes, '')
    assert.equal(repo.applyGeneratedNotes('missing-session', 0, '', 'Orphan notes'), false)
  } finally { repo.close() }
})

test('a second SQLite connection cannot have its saved notes overwritten by a pending generation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-notes-race-')), path = join(directory, 'workspace.sqlite')
  const first = new Repository(path), second = new Repository(path)
  try {
    const session = first.create('meeting')
    second.update(session.id, { notes: 'Another window saved these notes' })
    assert.equal(first.applyGeneratedNotes(session.id, session.contextEpoch, session.notes, 'Stale generated notes'), false)
    first.close()
    const reopened = new Repository(path)
    try { assert.equal(reopened.get(session.id).notes, 'Another window saved these notes') } finally { reopened.close() }
  } finally { second.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('image imports reject decompression-sized dimensions before native decode', async () => {
  const { imageSize } = await import('../src/main/validation')
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20)
  assert.deepEqual(imageSize(png), { width: 1920, height: 1080 })
  png.writeUInt32BE(100_000, 16); assert.throws(() => imageSize(png))
  assert.throws(() => imageSize(Buffer.from('<svg onload="unsafe"/>')))
})

function databaseFixture(run: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-data-control-'))
  try { run(join(directory, 'workspace.sqlite')) } finally { rmSync(directory, { recursive: true, force: true }) }
}
const answer = (sessionId: string, text = 'fixture answer', id = 'fixture-answer'): Answer => ({ id, sessionId, requestId: 'fixture-request', action: 'ask', prompt: 'fixture prompt', text, model: 'fixture-model', status: 'complete', createdAt: Date.now() })

test('history OFF creates functional RAM sessions without persisting their content or identity', () => {
  databaseFixture(file => {
    const repo = new Repository(file), marker = 'EPHEMERAL_CONTENT_MUST_NEVER_REACH_SQLITE_0123456789'
    const saved = repo.create('meeting')
    repo.update(saved.id, { notes: 'Saved record stays intact' })
    repo.setHistoryEnabled(false)
    const temporary = repo.create('interview')
    assert.equal(temporary.persistent, false)
    repo.update(temporary.id, { title: marker, notes: marker, interview: { ...DEFAULT_INTERVIEW_CONTEXT, problem: marker, candidateAttempt: marker } })
    repo.setStatus(temporary.id, 'recording')
    repo.transcript(temporary.id, 'microphone', marker, 'ram-turn', 100)
    repo.saveAnswer(answer(temporary.id, marker))
    assert.equal(repo.applyGeneratedNotes(temporary.id, 0, marker, `${marker} amended`), true)
    assert.equal(repo.get(temporary.id).answers[0].text, marker)
    assert.equal(repo.list(marker)[0].persistent, false)
    const inspect = new DatabaseSync(file)
    try { assert.equal(inspect.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(temporary.id)?.n, 0); assert.equal(inspect.prepare('SELECT COUNT(*) n FROM transcripts').get()?.n, 0); assert.equal(inspect.prepare('SELECT COUNT(*) n FROM answers').get()?.n, 0) } finally { inspect.close() }
    repo.close()
    for (const path of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(path)) { assert(!readFileSync(path).includes(Buffer.from(marker))); assert(!readFileSync(path).includes(Buffer.from(temporary.id))) }
    const reopened = new Repository(file)
    try { assert.throws(() => reopened.get(temporary.id), /unavailable/); assert.equal(reopened.get(saved.id).notes, 'Saved record stays intact') } finally { reopened.close() }
  })
})

test('re-enabling history preserves RAM disposition and persists only new future sessions', () => {
  databaseFixture(file => {
    const repo = new Repository(file, { historyEnabled: false })
    const temporary = repo.create('meeting')
    repo.setHistoryEnabled(true)
    repo.update(temporary.id, { notes: 'Still temporary' })
    const saved = repo.create('meeting')
    assert.equal(repo.isPersistent(temporary.id), false); assert.equal(repo.isPersistent(saved.id), true)
    repo.close()
    const reopened = new Repository(file)
    try { assert.throws(() => reopened.get(temporary.id), /unavailable/); assert.equal(reopened.get(saved.id).persistent, true) } finally { reopened.close() }
  })
})

test('an active saved session can switch to RAM with its ID and prior saved snapshot preserved', () => {
  databaseFixture(file => {
    const repo = new Repository(file), saved = repo.create('meeting')
    repo.update(saved.id, { notes: 'Last explicitly saved snapshot' })
    repo.transcript(saved.id, 'manual', 'Prior saved speech', 'prior-turn', 10)
    repo.setHistoryEnabled(false)
    const shadow = repo.makeEphemeral(saved.id)
    assert.equal(shadow.id, saved.id); assert.equal(shadow.persistent, false)
    repo.update(saved.id, { notes: 'RAM changes' }); repo.transcript(saved.id, 'manual', 'RAM speech', 'ram-turn', 20)
    assert.equal(repo.list().filter(s => s.id === saved.id).length, 1)
    repo.close()
    const reopened = new Repository(file)
    try { assert.equal(reopened.get(saved.id).notes, 'Last explicitly saved snapshot'); assert.deepEqual(reopened.get(saved.id).transcript.map(t => t.text), ['Prior saved speech']) } finally { reopened.close() }
  })
})

test('RAM snapshots are defensive and reset, Trash, restore and late-note fences remain coherent', () => {
  const repo = new Repository(':memory:', { historyEnabled: false })
  try {
    const session = repo.create('interview')
    repo.transcript(session.id, 'manual', 'first', 'stable', 20)
    repo.transcript(session.id, 'manual', 'duplicate', 'stable', 30)
    repo.transcript(session.id, 'system', 'earlier', 'earlier', 10)
    const snapshot = repo.get(session.id); snapshot.transcript[0].text = 'caller mutation'
    assert.deepEqual(repo.get(session.id).transcript.map(t => t.text), ['earlier', 'first'])
    const reset = repo.reset(session.id)
    assert.equal(reset.contextEpoch, 1); assert.deepEqual(reset.transcript, [])
    assert.equal(repo.applyGeneratedNotes(session.id, 0, '', 'late old notes'), false)
    repo.trash(session.id); assert.throws(() => repo.epoch(session.id), /unavailable/); assert.equal(repo.list('', true).length, 1)
    assert.equal(repo.applyGeneratedNotes(session.id, 1, '', 'late trashed notes'), false)
    repo.restore(session.id); assert.equal(repo.list().length, 1); assert.equal(repo.get(session.id).notes, '')
  } finally { repo.close() }
})

test('permanent RAM deletion makes late persistence callbacks unavailable', () => {
  const repo = new Repository(':memory:', { historyEnabled: false })
  try {
    const session = repo.create('meeting')
    repo.saveAnswer(answer(session.id)); repo.trash(session.id)
    assert.deepEqual(repo.deletePermanently(session.id), { deleted: true, persistent: false, cleanup: 'complete' })
    assert.throws(() => repo.get(session.id, true), /unavailable/)
    assert.throws(() => repo.saveAnswer(answer(session.id)), /unavailable/)
    assert.throws(() => repo.transcript(session.id, 'manual', 'late turn'), /unavailable/)
    assert.equal(repo.applyGeneratedNotes(session.id, 0, '', 'late notes'), false)
    assert.deepEqual(repo.list('', true), [])
  } finally { repo.close() }
})

test('permanent saved deletion removes associated records and clears SQLite content under an idle checkpoint', () => {
  databaseFixture(file => {
    const marker = 'PERMANENT_DELETE_CONTENT_MARKER_0123456789_'.repeat(10), repo = new Repository(file)
    const session = repo.create('interview'), other = repo.create('meeting')
    repo.update(session.id, { notes: marker, interview: { ...DEFAULT_INTERVIEW_CONTEXT, problem: marker } })
    repo.transcript(session.id, 'manual', marker); repo.saveAnswer(answer(session.id, marker))
    repo.update(other.id, { notes: 'Other session preserved' })
    repo.trash(session.id)
    assert.deepEqual(repo.deletePermanently(session.id), { deleted: true, persistent: true, cleanup: 'complete' })
    assert.throws(() => repo.get(session.id, true), /unavailable/)
    const inspect = new DatabaseSync(file)
    try { for (const table of ['transcripts', 'answers']) assert.equal(inspect.prepare(`SELECT COUNT(*) n FROM ${table} WHERE session_id=?`).get(session.id)?.n, 0) } finally { inspect.close() }
    assert.equal(repo.get(other.id).notes, 'Other session preserved')
    if (existsSync(`${file}-wal`)) assert.equal(statSync(`${file}-wal`).size, 0)
    assert(!readFileSync(file).includes(Buffer.from(marker)))
    repo.close()
    const reopened = new Repository(file)
    try { assert.throws(() => reopened.get(session.id, true), /unavailable/); assert.equal(reopened.list().length, 1) } finally { reopened.close() }
  })
})

test('permanent deletion of a RAM shadow also removes its retained saved snapshot', () => {
  databaseFixture(file => {
    const repo = new Repository(file), session = repo.create('meeting')
    repo.makeEphemeral(session.id); repo.update(session.id, { notes: 'RAM shadow' })
    assert.equal(repo.deletePermanently(session.id).persistent, true); repo.close()
    const reopened = new Repository(file)
    try { assert.throws(() => reopened.get(session.id, true), /unavailable/) } finally { reopened.close() }
  })
})

test('a held SQLite reader reports pending physical cleanup while logical deletion remains durable', () => {
  databaseFixture(file => {
    const repo = new Repository(file), session = repo.create('meeting'), reader = new DatabaseSync(file)
    repo.transcript(session.id, 'manual', 'Retained reader snapshot', 'reader-turn')
    reader.exec('BEGIN'); reader.prepare('SELECT * FROM sessions').all()
    try {
      const result = repo.deletePermanently(session.id)
      assert.equal(result.deleted, true); assert.equal(result.cleanup, 'pending'); assert.equal(result.reason, 'database-busy')
      assert.throws(() => repo.get(session.id, true), /unavailable/)
      assert(repo.diagnostics().issueCodes.includes('deletion-checkpoint-pending'))
    } finally { reader.exec('ROLLBACK'); reader.close(); repo.close() }
    const reopened = new Repository(file)
    try { assert.throws(() => reopened.get(session.id, true), /unavailable/) } finally { reopened.close() }
  })
})

test('future and unrelated database schemas are rejected without changing recoverable files', () => {
  databaseFixture(file => {
    const newer = new DatabaseSync(file)
    newer.exec("CREATE TABLE personal (text TEXT); INSERT INTO personal VALUES('PRESERVE_FOREIGN_CONTENT'); PRAGMA user_version=999;"); newer.close()
    const original = readFileSync(file)
    assert.throws(() => new Repository(file), error => error instanceof RepositoryError && error.code === 'unsupported-schema')
    assert.deepEqual(readFileSync(file), original)
    const foreign = new DatabaseSync(file); foreign.exec('PRAGMA user_version=0'); foreign.close()
    const foreignBytes = readFileSync(file)
    assert.throws(() => new Repository(file), /not a supported Faangin workspace/)
    assert.deepEqual(readFileSync(file), foreignBytes)
  })
})

test('a corrupt database is preserved and reports a safe recovery error without its path', () => {
  databaseFixture(file => {
    const bytes = Buffer.from('This fixture is not a SQLite file. PRESERVE_CORRUPT_BYTES'); writeFileSync(file, bytes)
    assert.throws(() => new Repository(file), error => { assert(error instanceof RepositoryError); assert.equal(error.code, 'storage-corrupt'); assert(!error.message.includes(file)); return true })
    assert.deepEqual(readFileSync(file), bytes)
  })
})

test('corrupt individual JSON records remain recoverable and do not strand healthy sessions', () => {
  databaseFixture(file => {
    const first = new Repository(file), session = first.create('interview'), other = first.create('meeting')
    first.saveAnswer(answer(session.id)); first.close()
    const broken = new DatabaseSync(file), raw = '{invalid fixture JSON containing private content'
    broken.prepare('UPDATE answers SET json=?').run(raw); broken.prepare('UPDATE sessions SET interview_json=? WHERE id=?').run(raw, session.id)
    broken.prepare('INSERT INTO settings(id,json) VALUES(1,?)').run(raw); broken.close()
    const reopened = new Repository(file)
    try {
      assert.equal(reopened.get(session.id).answers[0].status, 'failed'); assert.equal(reopened.get(session.id).answers[0].text, '')
      assert.deepEqual(reopened.get(session.id).interview, DEFAULT_INTERVIEW_CONTEXT); assert.equal(reopened.get(other.id).id, other.id)
      assert.equal(reopened.isHistoryEnabled(), false)
      assert.deepEqual(reopened.diagnostics().issueCodes, ['answer-corrupt', 'interview-corrupt', 'settings-corrupt'])
      const inspect = new DatabaseSync(file)
      try { assert.equal(inspect.prepare('SELECT json FROM answers').get()?.json, raw); assert.equal(inspect.prepare('SELECT json FROM settings').get()?.json, raw); assert.equal(inspect.prepare('SELECT interview_json FROM sessions WHERE id=?').get(session.id)?.interview_json, raw) } finally { inspect.close() }
    } finally { reopened.close() }
  })
})

test('save errors propagate safely and rollback all parts of a multi-statement answer write', () => {
  databaseFixture(file => {
    const repo = new Repository(file), session = repo.create('meeting'), inspect = new DatabaseSync(file)
    inspect.exec("CREATE TRIGGER fail_session_save BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'PRIVATE_PATH_OR_CREDENTIAL_FIXTURE'); END;")
    try {
      assert.throws(() => repo.saveAnswer(answer(session.id)), error => { assert(error instanceof RepositoryError); assert.equal(error.code, 'save-failed'); assert(!error.message.includes('PRIVATE_PATH_OR_CREDENTIAL_FIXTURE')); return true })
      assert.equal(repo.get(session.id).answers.length, 0)
      assert.throws(() => repo.update(session.id, { notes: 'Failed notes' }), /could not save/)
      assert.equal(repo.get(session.id).notes, '')
    } finally { inspect.close(); repo.close() }
  })
})

test('preset configuration remains durable while new session history is OFF', () => {
  databaseFixture(file => {
    const repo = new Repository(file, { historyEnabled: false }), value = { version: 1, templates: [{ id: 'template', instructions: 'Fixture user preference' }] }
    repo.saveConfiguration('preset-catalog', value)
    const returned = repo.configuration('preset-catalog') as typeof value; returned.templates[0].instructions = 'caller mutation'
    assert.deepEqual(repo.configuration('preset-catalog'), value)
    assert.throws(() => repo.saveConfiguration('other' as 'preset-catalog', value), /Unsupported/)
    assert.throws(() => repo.saveConfiguration('preset-catalog', 'x'.repeat(1_000_001)), /too large/)
    assert.throws(() => repo.saveConfiguration('preset-catalog', undefined), /missing/)
    repo.close()
    const reopened = new Repository(file)
    try { assert.deepEqual(reopened.configuration('preset-catalog'), value); assert.equal(reopened.diagnostics().schemaVersion, 3) } finally { reopened.close() }
  })
})

test('cross-session answer and transcript identities cannot overwrite saved or RAM context', () => {
  const repo = new Repository(':memory:')
  try {
    const saved = repo.create('meeting'); repo.setHistoryEnabled(false); const temporary = repo.create('meeting')
    repo.saveAnswer(answer(saved.id)); assert.throws(() => repo.saveAnswer(answer(temporary.id)), /identity collision/)
    repo.transcript(temporary.id, 'manual', 'RAM source', 'collision'); assert.throws(() => repo.transcript(saved.id, 'manual', 'Saved collision', 'collision'), /identity collision/)
    assert.equal(repo.get(saved.id).transcript.length, 0); assert.equal(repo.get(temporary.id).answers.length, 0)
    assert.equal(repo.get(saved.id).answers[0].text, 'fixture answer')
  } finally { repo.close() }
})

test('incomplete transcript warnings survive restart and reset independently in saved and RAM sessions', () => {
  databaseFixture(file => {
    const repo = new Repository(file), saved = repo.create('meeting')
    assert.equal(repo.get(saved.id).transcriptIncomplete, false)
    repo.markTranscriptIncomplete(saved.id); repo.close()
    const reopened = new Repository(file)
    try {
      assert.equal(reopened.get(saved.id).transcriptIncomplete, true)
      reopened.setHistoryEnabled(false); const temporary = reopened.create('meeting')
      reopened.markTranscriptIncomplete(temporary.id)
      assert.equal(reopened.get(temporary.id).transcriptIncomplete, true)
      assert.equal(reopened.reset(temporary.id).transcriptIncomplete, false)
      assert.equal(reopened.get(saved.id).transcriptIncomplete, true)
      assert.equal(reopened.reset(saved.id).transcriptIncomplete, false)
      reopened.trash(saved.id); assert.throws(() => reopened.markTranscriptIncomplete(saved.id), /unavailable/)
    } finally { reopened.close() }
    const final = new Repository(file)
    try { assert.equal(final.get(saved.id, true).transcriptIncomplete, false) } finally { final.close() }
  })
})

test('history preference survives restart and failed preference saves cannot change retention mode', () => {
  databaseFixture(file => {
    const first = new Repository(file)
    first.saveSettings({ ...DEFAULT_SETTINGS, historyEnabled: false }); first.close()
    const reopened = new Repository(file), inspect = new DatabaseSync(file)
    try {
      assert.equal(reopened.isHistoryEnabled(), false)
      assert.equal(reopened.create('meeting').persistent, false)
      inspect.exec("CREATE TRIGGER fail_preferences BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'PRIVATE_FIXTURE_ERROR'); END;")
      assert.throws(() => reopened.saveSettings({ ...DEFAULT_SETTINGS, historyEnabled: true }), /could not save/)
      assert.equal(reopened.isHistoryEnabled(), false); assert.equal(reopened.settings().historyEnabled, false)
      assert.equal(reopened.create('meeting').persistent, false)
    } finally { inspect.close(); reopened.close() }
  })
})
