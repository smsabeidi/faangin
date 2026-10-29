import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { settingsPatch, generateInput } from '../src/main/validation'
import { Repository } from '../src/main/repository'

test('live suggestion preferences accept explicit booleans and actual audio sources only', () => {
  assert.deepEqual(settingsPatch({ liveSuggestions: true, liveSuggestionSource: 'system' }), { liveSuggestions: true, liveSuggestionSource: 'system' })
  assert.deepEqual(settingsPatch({ liveSuggestions: false, liveSuggestionSource: 'microphone' }), { liveSuggestions: false, liveSuggestionSource: 'microphone' })
  for (const value of ['true', 1, null, undefined]) assert.throws(() => settingsPatch({ liveSuggestions: value }))
  for (const value of ['interviewer', 'manual', '', null, 1]) assert.throws(() => settingsPatch({ liveSuggestionSource: value }))
})

test('a legacy saved configuration leaves automatic requests disabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-live-suggestions-settings-'))
  const path = join(directory, 'test.sqlite')
  let repo: Repository | undefined
  try {
    repo = new Repository(path)
    repo.close(); repo = undefined
    const legacy = new DatabaseSync(path)
    try {
      const { liveSuggestions: _enabled, liveSuggestionSource: _source, ...oldSettings } = DEFAULT_SETTINGS
      legacy.prepare('INSERT INTO settings(id,json) VALUES(1,?)').run(JSON.stringify({ ...oldSettings, systemAudio: true, fontSize: 17 }))
    } finally { legacy.close() }
    repo = new Repository(path)
    assert.equal(repo.settings().liveSuggestions, false)
    assert.equal(repo.settings().liveSuggestionSource, 'system')
    assert.equal(repo.settings().systemAudio, true)
    assert.equal(repo.settings().fontSize, 17)
    repo.saveSettings({ ...repo.settings(), liveSuggestions: true, liveSuggestionSource: 'microphone' })
    repo.close(); repo = new Repository(path)
    assert.equal(repo.settings().liveSuggestions, true)
    assert.equal(repo.settings().liveSuggestionSource, 'microphone')
  } finally { repo?.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('renderer requests cannot assign the automatic answer origin', () => {
  assert.throws(() => generateInput({ sessionId: 'session', action: 'reply', origin: 'automatic' }))
  assert.deepEqual(generateInput({ sessionId: 'session', action: 'reply' }), { sessionId: 'session', action: 'reply', prompt: '', attachmentIds: [], smart: undefined })
})
