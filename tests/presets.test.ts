import assert from 'node:assert/strict'
import test from 'node:test'
import { PresetCatalog, PRESET_LIMITS, validatePresetDraft, type PresetDraft } from '../src/main/presets'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const draft: PresetDraft = { name: 'My interview preparation', kind: 'response', mode: 'interview', instructions: 'Explain the approach concisely, then discuss edge cases.' }
function catalog(): PresetCatalog { let sequence = 0; return new PresetCatalog(undefined, { now: () => 100, createId: () => `custom-${++sequence}` }) }

test('fresh presets provide useful mode-specific defaults without implicitly replacing existing settings', () => {
  const store = catalog(), presets = store.list()
  assert.equal(presets.length, 6)
  assert(presets.some(preset => preset.mode === 'meeting' && preset.kind === 'notes'))
  assert(presets.some(preset => preset.mode === 'interview' && preset.kind === 'response'))
  assert.deepEqual(store.choice('session-a'), { responseId: null, noteTemplateId: null })
  const settings = { ...DEFAULT_SETTINGS, instructions: 'Existing response preference.', noteTemplate: 'Existing template.' }
  assert.deepEqual(store.settingsFor('session-a', 'interview', settings), settings)
  assert.notEqual(store.settingsFor('session-a', 'interview', settings), settings)
  assert.equal(store.snapshot().revision, 0)
})

test('create, edit and duplicate persist independently through validated snapshot reopening', () => {
  const store = catalog(), original = store.create(draft)
  const edited = store.update(original.id, { ...draft, name: 'Updated name', instructions: 'UPDATED_PREFERENCE' }, original.revision)
  assert.equal(edited.revision, original.revision + 1)
  const copy = store.duplicate(edited.id)
  assert.notEqual(copy.id, edited.id)
  assert.equal(copy.instructions, 'UPDATED_PREFERENCE')
  assert.equal(copy.name, 'Updated name (copy)')
  assert.equal(copy.builtIn, false)
  store.select('session-a', 'interview', 'response', edited.id)
  store.select('session-a', 'interview', 'notes', 'builtin:interview-notes')
  const reopened = new PresetCatalog(JSON.parse(JSON.stringify(store.snapshot())))
  assert.deepEqual(reopened.list(), store.list())
  assert.deepEqual(reopened.choice('session-a'), store.choice('session-a'))
  assert.equal(reopened.settingsFor('session-a', 'interview', DEFAULT_SETTINGS).instructions, 'UPDATED_PREFERENCE')
  assert.equal(reopened.settingsFor('session-a', 'interview', DEFAULT_SETTINGS).noteTemplate, reopened.resolve('session-a', 'interview').notes?.instructions)
  copy.instructions = 'Mutated external result'
  const snapshot = store.snapshot(); snapshot.presets[0].instructions = 'Mutated snapshot'; snapshot.choices['session-a'].responseId = null
  assert.equal(store.resolve('session-a', 'interview').response?.instructions, 'UPDATED_PREFERENCE')
  assert.notEqual(store.list()[0].instructions, 'Mutated snapshot')
})

test('a stale window cannot overwrite a newer preset edit or change a selected mode silently', () => {
  const store = catalog(), preset = store.create(draft)
  store.update(preset.id, { ...draft, instructions: 'Saved in another window.' }, preset.revision)
  assert.throws(() => store.update(preset.id, { ...draft, instructions: 'Stale replacement.' }, preset.revision), /another window/)
  assert.equal(store.list().find(item => item.id === preset.id)?.instructions, 'Saved in another window.')
  assert.throws(() => store.update(preset.id, { ...draft, mode: 'meeting' }, 1), /Duplicate/)
  assert.throws(() => store.update(preset.id, { ...draft, kind: 'notes' }, 1), /Duplicate/)
})

test('session choices enforce kind/mode, stay isolated, and reset back to global settings', () => {
  const store = catalog(), preset = store.create(draft)
  store.select('interview-a', 'interview', 'response', preset.id)
  store.select('interview-b', 'interview', 'response', 'builtin:behavioral')
  assert.throws(() => store.select('meeting-a', 'meeting', 'response', preset.id), /supports this session mode/)
  assert.throws(() => store.select('interview-a', 'interview', 'notes', preset.id), /supports this session mode/)
  assert.deepEqual(store.choice('meeting-a'), { responseId: null, noteTemplateId: null })
  assert.throws(() => store.resolve('interview-a', 'meeting'), /does not support/)
  store.clearSession('interview-a')
  assert.equal(store.choice('interview-a').responseId, null)
  assert.equal(store.choice('interview-b').responseId, 'builtin:behavioral')
  store.select('interview-b', 'interview', 'response', null)
  assert.equal(store.settingsFor('interview-b', 'interview', DEFAULT_SETTINGS).instructions, DEFAULT_SETTINGS.instructions)
})

test('deleting a preset revokes all selected references while preserving unrelated configuration', () => {
  const store = catalog(), preset = store.create(draft)
  for (const sessionId of ['session-a', 'session-b']) {
    store.select(sessionId, 'interview', 'response', preset.id)
    store.select(sessionId, 'interview', 'notes', 'builtin:interview-notes')
  }
  store.delete(preset.id)
  for (const sessionId of ['session-a', 'session-b']) assert.deepEqual(store.choice(sessionId), { responseId: null, noteTemplateId: 'builtin:interview-notes' })
  assert.throws(() => store.select('session-a', 'interview', 'response', preset.id), /unavailable/)
  assert.throws(() => store.delete(preset.id), /unavailable/)
})

test('restore defaults recreates deleted defaults, resets edited defaults, and retains custom choices', () => {
  const store = catalog(), original = store.list().find(item => item.id === 'builtin:interview-coach')!
  store.update(original.id, { name: original.name, kind: original.kind, mode: original.mode, instructions: 'Changed built-in.' }, original.revision)
  store.select('session-a', 'interview', 'response', original.id)
  const custom = store.create(draft); store.select('session-b', 'interview', 'response', custom.id)
  store.delete('builtin:meeting-notes'); store.restoreDefaults()
  assert.equal(store.list().length, 7)
  assert.equal(store.resolve('session-a', 'interview').response?.instructions, original.instructions)
  assert.equal(store.resolve('session-b', 'interview').response?.id, custom.id)
  assert(store.list().some(item => item.id === 'builtin:meeting-notes'))
  assert.throws(() => store.update(original.id, { ...draft }, 1), /another window/)
})

test('preset validation rejects malformed identities, duplicate records, forged defaults and missing references', () => {
  assert.throws(() => validatePresetDraft({ ...draft, privateRubric: 'Unsupported' }), /Unsupported/)
  assert.throws(() => validatePresetDraft({ ...draft, name: '   ' }), /nonempty/)
  assert.throws(() => validatePresetDraft({ ...draft, instructions: 'bad\0text' }), /nonempty/)
  assert.throws(() => validatePresetDraft({ ...draft, instructions: 'x'.repeat(PRESET_LIMITS.responseCharacters + 1) }), /4000/)
  assert.throws(() => validatePresetDraft({ ...draft, kind: 'notes', instructions: 'x'.repeat(PRESET_LIMITS.noteCharacters + 1) }), /2000/)
  const store = catalog(), snapshot = store.snapshot()
  assert.throws(() => new PresetCatalog({ ...snapshot, version: 2 }), /version/)
  assert.throws(() => new PresetCatalog({ ...snapshot, presets: [...snapshot.presets, snapshot.presets[0]] }), /Duplicate/)
  assert.throws(() => new PresetCatalog({ ...snapshot, presets: [{ ...snapshot.presets[0], id: 'builtin:forged' }] }), /identity/)
  assert.throws(() => new PresetCatalog({ ...snapshot, choices: { 'session-a': { responseId: 'missing-preset', noteTemplateId: null } } }), /unavailable/)
  assert.throws(() => store.select('__proto__', 'interview', 'response', null), /Invalid/)
  store.select('constructor', 'interview', 'response', 'builtin:interview-coach')
  assert.equal(new PresetCatalog(store.snapshot()).choice('constructor').responseId, 'builtin:interview-coach')
})

test('catalog capacity failure leaves existing state intact and default restoration does not exceed the cap', () => {
  const store = catalog()
  for (let i = store.list().length; i < PRESET_LIMITS.count; i++) store.create({ ...draft, name: `Custom ${i}` })
  const before = store.snapshot()
  assert.throws(() => store.create(draft), /At most 100/)
  assert.deepEqual(store.snapshot(), before)
  for (const preset of store.list().filter(item => item.builtIn)) store.delete(preset.id)
  for (let i = store.list().length; i < PRESET_LIMITS.count; i++) store.create({ ...draft, name: `Replacement ${i}` })
  const full = store.snapshot()
  assert.throws(() => store.restoreDefaults(), /Delete a custom/)
  assert.deepEqual(store.snapshot(), full)
})
